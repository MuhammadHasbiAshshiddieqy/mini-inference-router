# Makefile untuk repo mini-inference-router: semua perintah, diurutkan dari persiapan sampai evaluasi.
#
#   make help      daftar semua perintah, dikelompokkan menurut urutan pemakaian
#   make steps     urutan menjalankan dari nol untuk tiga cara (Docker penuh, Docker + Ollama native, tanpa Docker)
#   make doctor    cek perangkat yang terpasang dan apa yang sedang berjalan
#
# Perintah yang sebenarnya dijalankan SENGAJA ditampilkan (tidak disembunyikan dengan @) supaya Anda bisa
# melihat dan mempelajari command aslinya. Hanya baris penjelasan (echo) yang disembunyikan.
#
# Lokasi file ini fleksibel:
#   - di luar repo: repo dicari di folder saudara ../mini-inference-router, atau set REPO=/path/ke/repo
#   - di root repo (salin saja): repo = folder saat ini
# Kompatibel dengan GNU Make 3.81 (bawaan macOS).

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ------------------------------------------------------------------------------------------------ variabel

MAKEFILE_PATH := $(abspath $(lastword $(MAKEFILE_LIST)))
MAKEFILE_DIR  := $(patsubst %/,%,$(dir $(MAKEFILE_PATH)))

ifndef REPO
REPO := $(shell if [ -f package.json ] && [ -d apps/gateway ] && [ -d apps/console ]; then pwd; \
                else cd "$(MAKEFILE_DIR)/../mini-inference-router" 2>/dev/null && pwd; fi)
endif
ifeq ($(REPO),)
$(error Repo tidak ditemukan. Jalankan dari root repo, atau set REPO=/path/ke/mini-inference-router)
endif

IN        := cd "$(REPO)" &&
# Muat .env ke environment shell (hanya untuk recipe yang butuh nilai seperti SEED_KEY_ACME)
LOAD_ENV  := set -a; [ -f .env ] && . ./.env; set +a;
SUB       := $(MAKE) --no-print-directory -f "$(MAKEFILE_PATH)" REPO="$(REPO)"
RUN_DIR   ?= $(HOME)/.cache/mir-make

# Gateway yang dites (smoke, api-*, eval-e2e)
GATEWAY   ?= http://localhost:8787

# Ollama native di Mac
OLLAMA_URL         ?= http://localhost:11434
NATIVE_CHAT_MODEL  ?= gemma4:e2b-mlx
DOCKER_CHAT_MODEL  ?= gemma4:e2b-it-qat
EMBED_MODEL        ?= nomic-embed-text

PROVIDER  ?= ollama
SERVICE   ?= gateway
Q         ?= how do i change my shipping address


##@ 0. Bantuan

help: ## Tampilkan daftar perintah ini
	@awk 'BEGIN {FS=":.*## "} /^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0,5)} /^[a-zA-Z0-9_.-]+:.*## / {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""
	@echo "Repo : $(REPO)"
	@echo "Opsi : REPO=... GATEWAY=... PROVIDER=ollama|gemini SERVICE=gateway Q=\"pertanyaan\" LABEL=nama CONFIRM=1"

steps: ## Urutan menjalankan dari nol untuk ketiga cara
	@echo ""
	@echo "A. DOCKER PENUH (Ollama di container, CPU, lambat; cocok untuk reviewer)"
	@echo "   1. make env              salin .env.example ke .env (sekali)"
	@echo "   2. make docker-up        build dan jalankan semuanya (tunggu sampai gateway sehat)"
	@echo "   3. make docker-health    cek http://localhost:8787/healthz"
	@echo "   4. make smoke            uji asap (10 pemeriksaan)"
	@echo "   5. make docker-down      matikan"
	@echo ""
	@echo "B. DOCKER + OLLAMA NATIVE (cepat, GPU Metal; model berjalan di Mac)"
	@echo "   1. make env"
	@echo "   2. make ollama-pull      unduh model (sekali, beberapa GB)"
	@echo "   3. make docker-native-up nyalakan Ollama native lalu docker compose dengan DOCKER_OLLAMA_URL"
	@echo "   4. make smoke"
	@echo "   5. make docker-native-down  matikan container DAN Ollama"
	@echo ""
	@echo "C. TANPA DOCKER UNTUK APLIKASI (pnpm dev; hanya Postgres di Docker)"
	@echo "   1. make install && make env"
	@echo "   2. make ollama-pull && make ollama-start"
	@echo "   3. make local-setup      db-up, migrate, seed, isi KB dari cache"
	@echo "   4. make dev              gateway :8787 + console :5173"
	@echo "   5. make smoke            (terminal lain)"
	@echo "   6. make ollama-stop && make db-down"
	@echo ""
	@echo "EVALUASI (butuh gateway lokal berjalan, mode B atau C)"
	@echo "   make eval-retrieval          tanpa LLM"
	@echo "   make eval-e2e LABEL=local-ollama"
	@echo "   make eval-compare A=eval/results/x.json B=eval/results/y.json"
	@echo "   atau satu kali jalan: make eval-flow-local"
	@echo ""

doctor: ## Cek perangkat terpasang dan status layanan
	@echo "--- perangkat"
	@for c in node pnpm docker ollama uv python3 psql curl; do \
	  if command -v $$c >/dev/null 2>&1; then \
	    if [ $$c = ollama ]; then v=$$($$c --version 2>&1 | tail -n1); else v=$$($$c --version 2>&1 | head -n1); fi; \
	    printf "  %-8s ok   %s\n" $$c "$$v"; \
	  else printf "  %-8s TIDAK ADA\n" $$c; fi; done
	@command -v docker >/dev/null 2>&1 && printf "  %-8s ok   %s\n" compose "$$(docker compose version 2>&1 | head -n1)" || true
	@echo "--- layanan"
	@if docker info >/dev/null 2>&1; then echo "  docker daemon   berjalan"; else echo "  docker daemon   MATI (buka Docker Desktop)"; fi
	@if curl -fsS $(OLLAMA_URL)/api/version >/dev/null 2>&1; then echo "  ollama          berjalan di $(OLLAMA_URL)"; else echo "  ollama          mati"; fi
	@if curl -fsS $(GATEWAY)/healthz >/dev/null 2>&1; then echo "  gateway         berjalan di $(GATEWAY)"; else echo "  gateway         mati"; fi
	@if [ -f "$(REPO)/.env" ]; then echo "  .env            ada"; else echo "  .env            BELUM ADA (make env)"; fi

##@ 1. Persiapan (sekali)

install: ## pnpm install (semua workspace)
	$(IN) pnpm install

env: ## Salin .env.example ke .env bila belum ada (tidak menimpa)
	@if [ -f "$(REPO)/.env" ]; then echo ".env sudah ada, tidak diubah."; \
	else cp "$(REPO)/.env.example" "$(REPO)/.env" && echo ".env dibuat dari .env.example."; fi
	@echo "Isi ADMIN_API_KEY dan SEED_KEY_ACME/GLOBEX/TINY/EVAL (minimal 20 karakter) bila ingin kunci tetap: make keys-suggest"

keys-suggest: ## Cetak contoh nilai SEED_KEY_* dan ADMIN_API_KEY acak (tidak mengubah file)
	@for t in ACME GLOBEX TINY EVAL; do echo "SEED_KEY_$$t=mir_local_$$(openssl rand -hex 16)"; done
	@echo "ADMIN_API_KEY=$$(openssl rand -hex 16)"

##@ 2. Data (opsional, satu kali; hasilnya sudah di-commit di data/)

data-setup: ## Siapkan Python (venv) dan pasang paket untuk prepare_data.py
	$(IN) if command -v uv >/dev/null 2>&1; then uv venv .venv && uv pip install --python .venv/bin/python -r scripts/requirements.txt; \
	  else python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt; fi

data-prepare: ## Bagi ulang dataset Bitext (butuh jaringan; menulis ulang data/*.jsonl) CONFIRM=1
	@test "$(CONFIRM)" = 1 || { echo "Ini menulis ulang file data/ yang sudah di-commit. Jalankan: make data-prepare CONFIRM=1"; exit 1; }
	$(IN) .venv/bin/python scripts/prepare_data.py --out data --seed 42 --kb-per-intent 50 --dev-per-intent 10

##@ 3. Database (Postgres + pgvector di Docker)

db-up: ## Jalankan Postgres saja dan tunggu sampai sehat
	$(IN) docker compose up -d --wait postgres

db-migrate: ## Terapkan migrasi (buat tabel, ekstensi vector dan pg_trgm)
	$(IN) pnpm db:migrate

db-seed: ## Buat/perbarui tenant demo (kunci dicetak SEKALI bila SEED_KEY_* kosong)
	$(IN) pnpm db:seed

db-seed-reset: ## Seed ulang dan kembalikan kuota semua tenant ke penuh (wajib sebelum eval)
	$(IN) pnpm db:seed -- --reset-usage

db-psql: ## Buka psql ke database lokal
	$(IN) docker compose exec postgres psql -U postgres -d router

db-tables: ## Daftar tabel dan jumlah baris KB per model embedding
	$(IN) docker compose exec -T postgres psql -U postgres -d router -c '\dt' -c 'select embedding_model, count(*) from kb_entries group by 1'

db-down: ## Hentikan Postgres (data tetap ada di volume)
	$(IN) docker compose stop postgres

db-wipe: ## HAPUS data Postgres (volume pgdata) CONFIRM=1
	@test "$(CONFIRM)" = 1 || { echo "Menghapus seluruh data database lokal. Jalankan: make db-wipe CONFIRM=1"; exit 1; }
	$(IN) docker compose rm -sf postgres
	-docker volume rm $$(basename "$(REPO)" | tr 'A-Z' 'a-z')_pgdata

##@ 4. Knowledge base dan ambang penolakan

kb-embed-cache: ## Isi KB dari cache nomic-embed-text yang sudah di-commit (cepat, tanpa Ollama)
	$(IN) pnpm kb:embed -- --provider ollama --from-cache-only

kb-embed-ollama: ## Embed KB dengan Ollama sungguhan (Ollama harus berjalan; lambat)
	$(IN) pnpm kb:embed -- --provider ollama

kb-embed-gemini-cache: ## Isi KB dari cache gemini-embedding-001 yang sudah di-commit (tanpa panggilan Gemini)
	$(IN) pnpm kb:embed -- --provider gemini --from-cache-only

kb-embed-gemini: ## Embed KB dengan Gemini (pakai kunci router-eval; 1.000 teks/hari/proyek)
	$(IN) pnpm kb:embed -- --provider gemini

calibrate: ## Hitung ulang T_oos/T_high dari split dev PROVIDER=ollama|gemini (menulis data/thresholds.json)
	$(IN) pnpm calibrate -- --provider $(PROVIDER)

##@ 5. Jalankan tanpa Docker untuk aplikasi (pnpm dev)

local-setup: ## Berurutan: db-up, db-migrate, db-seed, kb-embed-cache
	@$(SUB) db-up
	@$(SUB) db-migrate
	@$(SUB) db-seed
	@$(SUB) kb-embed-cache
	@echo ""
	@echo "Siap. Jalankan: make dev   (pastikan Ollama berjalan: make ollama-start)"

dev: ## Gateway (:8787) dan console (:5173) bersamaan
	$(IN) pnpm dev

gateway: ## Gateway saja (:8787, auto-reload)
	$(IN) pnpm --filter gateway dev

console: ## Console saja (:5173)
	$(IN) pnpm --filter console dev

console-build: ## Build produksi console (typecheck + vite build)
	$(IN) pnpm --filter console build

open-console: ## Buka console di browser
	open http://localhost:5173

##@ 6. Kualitas kode

typecheck: ## Typecheck semua workspace
	$(IN) pnpm -r typecheck

lint: ## ESLint semua workspace
	$(IN) pnpm -r lint

test: ## Unit test (tes database dilewati bila Postgres mati)
	$(IN) pnpm -r test

test-db: ## Semua tes, dan tes database WAJIB jalan (menyalakan Postgres dulu)
	@$(SUB) db-up
	$(IN) REQUIRE_DB=1 pnpm -r test

test-live-gemini: ## Tes opt-in ke Gemini sungguhan (memakai kuota!)
	$(IN) LIVE=gemini pnpm --filter gateway exec vitest run src/backends/live.test.ts

format: ## Prettier: rapikan semua file
	$(IN) pnpm format

format-check: ## Prettier: hanya cek
	$(IN) pnpm format:check

check: ## typecheck + lint + test (sebelum commit)
	@$(SUB) typecheck
	@$(SUB) lint
	@$(SUB) test

##@ 7. Ollama native (Mac)

ollama-pull: ## Unduh model native: gemma4:e2b-mlx dan nomic-embed-text (sekali, beberapa GB)
	@$(SUB) ollama-start
	ollama pull $(NATIVE_CHAT_MODEL)
	ollama pull $(EMBED_MODEL)

ollama-start: ## Jalankan `ollama serve` di latar belakang (dilewati bila sudah berjalan)
	@command -v ollama >/dev/null 2>&1 || { echo "ollama belum terpasang (https://ollama.com)"; exit 1; }
	@mkdir -p "$(RUN_DIR)"
	@if curl -fsS $(OLLAMA_URL)/api/version >/dev/null 2>&1; then \
	  echo "Ollama sudah berjalan di $(OLLAMA_URL) (tidak dijalankan lagi)."; \
	else \
	  echo '$$ ollama serve   (log: $(RUN_DIR)/ollama.log)'; \
	  nohup ollama serve > "$(RUN_DIR)/ollama.log" 2>&1 & echo $$! > "$(RUN_DIR)/ollama.pid"; \
	  for i in $$(seq 1 40); do curl -fsS $(OLLAMA_URL)/api/version >/dev/null 2>&1 && break; sleep 0.5; done; \
	  if curl -fsS $(OLLAMA_URL)/api/version >/dev/null 2>&1; then echo "Ollama berjalan (PID $$(cat $(RUN_DIR)/ollama.pid))."; \
	  else echo "Ollama gagal mulai, lihat: make ollama-logs"; exit 1; fi; \
	fi

ollama-stop: ## Hentikan Ollama (jangan dibiarkan menyala: model memakai 6 sampai 9 GB RAM)
	@if [ -f "$(RUN_DIR)/ollama.pid" ] && kill -0 $$(cat "$(RUN_DIR)/ollama.pid") 2>/dev/null; then \
	  echo "Menghentikan Ollama (PID $$(cat $(RUN_DIR)/ollama.pid)) ..."; kill $$(cat "$(RUN_DIR)/ollama.pid"); rm -f "$(RUN_DIR)/ollama.pid"; echo "Ollama dihentikan."; \
	elif pgrep -f "ollama serve" >/dev/null 2>&1; then \
	  echo "Ollama tidak dijalankan lewat make; menghentikan proses 'ollama serve' ..."; pkill -f "ollama serve"; \
	  echo "Bila menyala lagi sendiri, itu aplikasi Ollama di menubar: pilih Quit Ollama."; \
	else echo "Ollama tidak berjalan."; fi

ollama-status: ## Apakah Ollama berjalan, model apa yang ada, dan model apa yang sedang dimuat di memori
	@if curl -fsS $(OLLAMA_URL)/api/version >/dev/null 2>&1; then echo "Ollama berjalan di $(OLLAMA_URL)"; \
	  ollama list; echo "--- dimuat di memori:"; ollama ps; else echo "Ollama mati."; fi

ollama-logs: ## Log ollama serve (yang dijalankan lewat make)
	@tail -n 40 -f "$(RUN_DIR)/ollama.log"

ollama-check-models: ## Pastikan model native sudah diunduh (dipakai oleh docker-native-up)
	@ollama list | grep -q "$(NATIVE_CHAT_MODEL)" || { echo "Model $(NATIVE_CHAT_MODEL) belum ada. Jalankan: make ollama-pull"; exit 1; }
	@ollama list | grep -q "$(EMBED_MODEL)" || { echo "Model $(EMBED_MODEL) belum ada. Jalankan: make ollama-pull"; exit 1; }
	@echo "Model $(NATIVE_CHAT_MODEL) dan $(EMBED_MODEL) tersedia."

##@ 8. Docker PENUH (Ollama di container, CPU)

docker-up: ## Mode A: build dan jalankan semuanya (foreground; Ctrl+C untuk berhenti)
	$(IN) docker compose --profile ollama up --build

docker-up-d: ## Mode A di latar belakang
	$(IN) docker compose --profile ollama up --build -d

docker-gpu-up: ## Mode A dengan GPU NVIDIA (Linux; didokumentasikan, belum diuji)
	$(IN) docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile ollama up --build

docker-down: ## Hentikan dan hapus container (volume data dan model tetap ada)
	$(IN) docker compose --profile ollama down

docker-down-volumes: ## Hentikan dan HAPUS volume (database dan model Ollama, bisa beberapa GB) CONFIRM=1
	@test "$(CONFIRM)" = 1 || { echo "Menghapus pgdata dan volume model Ollama. Jalankan: make docker-down-volumes CONFIRM=1"; exit 1; }
	$(IN) docker compose --profile ollama down -v

docker-ps: ## Status container
	$(IN) docker compose --profile ollama ps

docker-logs: ## Log satu layanan SERVICE=gateway|console|postgres|migrate|ollama|ollama-pull
	$(IN) docker compose --profile ollama logs -f --tail=100 $(SERVICE)

docker-keys: ## Lihat log migrate (mencetak kunci tenant bila SEED_KEY_* kosong)
	$(IN) docker compose --profile ollama logs migrate

docker-health: ## Cek /healthz gateway (status, backend, apakah Ollama terjangkau)
	@curl -fsS $(GATEWAY)/healthz | (python3 -m json.tool 2>/dev/null || cat); echo

docker-rebuild: ## Build ulang image tanpa cache
	$(IN) docker compose --profile ollama build --no-cache

##@ 9. Docker + Ollama NATIVE (aplikasi berjalan di Mac, Docker hanya untuk Postgres, gateway, console)

docker-native-up: ## Mode B: nyalakan Ollama native, cek model, lalu docker compose (foreground)
	@$(SUB) ollama-start
	@$(SUB) ollama-check-models
	@echo "Gateway di container memakai Ollama Mac lewat host.docker.internal. Setelah selesai: make ollama-stop"
	$(IN) DOCKER_OLLAMA_URL=http://host.docker.internal:11434 DOCKER_OLLAMA_CHAT_MODEL=$(NATIVE_CHAT_MODEL) docker compose up --build

docker-native-up-d: ## Mode B di latar belakang
	@$(SUB) ollama-start
	@$(SUB) ollama-check-models
	$(IN) DOCKER_OLLAMA_URL=http://host.docker.internal:11434 DOCKER_OLLAMA_CHAT_MODEL=$(NATIVE_CHAT_MODEL) docker compose up --build -d
	@echo "Tunggu gateway sehat: make docker-health"

docker-native-logs: ## Log container mode B SERVICE=gateway
	$(IN) docker compose logs -f --tail=100 $(SERVICE)

docker-native-down: ## Hentikan container DAN Ollama native
	$(IN) docker compose down
	@$(SUB) ollama-stop

##@ 10. Uji asap dan panggilan API

smoke: ## 10 pemeriksaan black-box ke gateway (kunci dibaca dari .env; bisa di-override KEY= TINY= GLOBEX= ADMIN=)
	$(IN) $(LOAD_ENV) BASE=$(GATEWAY) KEY=$${KEY:-$$SEED_KEY_ACME} TINY=$${TINY:-$$SEED_KEY_TINY} GLOBEX=$${GLOBEX:-$$SEED_KEY_GLOBEX} ADMIN=$${ADMIN:-$${ADMIN_API_KEY:-local-admin}} ./scripts/smoke.sh

smoke-cloud: ## Smoke ke deployment cloud: make smoke-cloud GATEWAY=https://... KEY= TINY= GLOBEX= ADMIN=
	$(IN) BASE=$(GATEWAY) EXPECT_PROFILE=cloud KEY=$(KEY) TINY=$(TINY) GLOBEX=$(GLOBEX) ADMIN=$(ADMIN) ./scripts/smoke.sh

api-health: ## GET /healthz
	@curl -fsS $(GATEWAY)/healthz | (python3 -m json.tool 2>/dev/null || cat); echo

api-ask: ## Tanya asisten (satu JSON): make api-ask Q="where is my refund"
	$(IN) $(LOAD_ENV) curl -fsS $(GATEWAY)/v1/support/answer -H "authorization: Bearer $${KEY:-$$SEED_KEY_ACME}" -H "content-type: application/json" -d '{"message":"$(Q)","stream":false}' | (python3 -m json.tool 2>/dev/null || cat)

api-ask-stream: ## Tanya asisten dengan streaming SSE (curl -N)
	$(IN) $(LOAD_ENV) curl -N $(GATEWAY)/v1/support/answer -H "authorization: Bearer $${KEY:-$$SEED_KEY_ACME}" -H "content-type: application/json" -d '{"message":"$(Q)"}'

api-usage: ## Kuota dan pemakaian tenant acme
	$(IN) $(LOAD_ENV) curl -fsS $(GATEWAY)/v1/usage -H "authorization: Bearer $${KEY:-$$SEED_KEY_ACME}" | (python3 -m json.tool 2>/dev/null || cat)

api-admin-usage: ## Pemakaian semua tenant (butuh ADMIN_API_KEY)
	$(IN) $(LOAD_ENV) curl -fsS $(GATEWAY)/admin/usage -H "authorization: Bearer $${ADMIN:-$${ADMIN_API_KEY:-local-admin}}" | (python3 -m json.tool 2>/dev/null || cat)

##@ 11. Evaluasi (berurutan: retrieval, end-to-end, bandingkan)

eval-retrieval: ## 1) Retrieval saja: dense vs hybrid vs lexical, tanpa LLM PROVIDER=ollama|gemini
	$(IN) pnpm eval:retrieval -- --provider $(PROVIDER)

eval-prep: ## 2) Sebelum e2e: kembalikan kuota tenant eval ke penuh
	@$(SUB) db-seed-reset

eval-e2e: ## 3) End-to-end lewat gateway: make eval-e2e LABEL=local-ollama [LIMIT=3 DELAY_MS=4000 EVAL_KEY=...]
	@test -n "$(LABEL)" || { echo "Isi LABEL, contoh: make eval-e2e LABEL=local-ollama"; exit 1; }
	@curl -fsS $(GATEWAY)/healthz >/dev/null 2>&1 || { echo "Gateway tidak menjawab di $(GATEWAY). Jalankan make gateway, make docker-native-up-d, atau make docker-up-d"; exit 1; }
	$(IN) pnpm eval -- --label $(LABEL) --gateway $(GATEWAY) --delay-ms $(or $(DELAY_MS),0) $(if $(LIMIT),--limit $(LIMIT),) $(if $(EVAL_KEY),--key $(EVAL_KEY),)

eval-compare: ## 4) Bandingkan hasil, tulis eval/report.md: make eval-compare A=eval/results/x.json B=eval/results/y.json
	@test -n "$(A)$(B)$(FILES)" || { echo "Isi A= dan B= (atau FILES=\"a.json b.json\"). Lihat: make eval-results"; exit 1; }
	$(IN) pnpm eval:compare -- $(or $(FILES),$(A) $(B))

eval-results: ## Daftar file hasil di eval/results/
	@ls -la "$(REPO)/eval/results"

eval-report: ## Tampilkan awal eval/report.md
	@sed -n '1,120p' "$(REPO)/eval/report.md"

eval-flow-local: ## Satu kali jalan (lokal): Ollama, DB, seed, KB, retrieval, e2e. Gateway harus sudah menyala. LABEL=local-ollama KEEP_OLLAMA=1 untuk tidak mematikan Ollama
	@$(SUB) ollama-start
	@$(SUB) db-up
	@$(SUB) db-migrate
	@$(SUB) db-seed-reset
	@$(SUB) kb-embed-cache
	@curl -fsS $(GATEWAY)/healthz >/dev/null 2>&1 || { echo "Gateway belum menyala di $(GATEWAY). Terminal lain: make gateway (mode C) atau make docker-native-up-d (mode B). Lalu ulangi."; exit 1; }
	@$(SUB) eval-retrieval PROVIDER=ollama
	@$(SUB) eval-e2e LABEL=$(or $(LABEL),local-ollama)
	@if [ "$(KEEP_OLLAMA)" != 1 ]; then $(SUB) ollama-stop; fi
	@echo "Selesai. Hasil di eval/results/. Bandingkan: make eval-compare A=... B=..."

##@ 12. Cloud (menyentuh database Neon: hati-hati)

cloud-prepare: ## Migrate + seed + isi KB dari cache Gemini ke Neon: make cloud-prepare DATABASE_URL=postgres://...neon... CONFIRM=1
	@test "$(origin DATABASE_URL)" != "undefined" || { echo "Isi DATABASE_URL secara eksplisit (URL Neon pooled)."; exit 1; }
	@case "$(DATABASE_URL)" in *localhost*|*127.0.0.1*|*@postgres:*) echo "DATABASE_URL tampak lokal. Perintah ini untuk database cloud."; exit 1;; esac
	@test "$(CONFIRM)" = 1 || { echo "Perintah ini mengubah database cloud ($(DATABASE_URL)). Tambahkan CONFIRM=1."; exit 1; }
	$(IN) pnpm db:migrate
	$(IN) PROFILE=cloud pnpm db:seed
	$(IN) PROFILE=cloud pnpm kb:embed -- --provider gemini --from-cache-only

cloud-reset-usage: ## Kuota tenant cloud kembali penuh (sebelum submit): DATABASE_URL=... CONFIRM=1
	@test "$(origin DATABASE_URL)" != "undefined" || { echo "Isi DATABASE_URL secara eksplisit (URL Neon pooled)."; exit 1; }
	@test "$(CONFIRM)" = 1 || { echo "Tambahkan CONFIRM=1."; exit 1; }
	$(IN) PROFILE=cloud pnpm db:seed -- --reset-usage

##@ 13. Bersih-bersih

clean-run: ## Hapus PID dan log buatan Makefile ini (~/.cache/mir-make); Ollama dihentikan dulu
	@$(SUB) ollama-stop
	rm -rf "$(RUN_DIR)"

# Semua target adalah perintah, bukan file (aman bila Makefile ini disalin ke root repo)
.PHONY: $(shell grep -E '^[a-zA-Z0-9_.-]+:' '$(MAKEFILE_PATH)' | cut -d: -f1)
