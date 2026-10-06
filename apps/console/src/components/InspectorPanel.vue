<script setup lang="ts">
import { computed, ref } from "vue";
import type { RunState } from "../lib/run-state.ts";

// Everything the brief asks to see (R16): served by, fallback, attempts, retrieval, intent, tokens, latency, cost.
const props = defineProps<{ run: RunState }>();
const showRaw = ref(false);
const expanded = ref<string | null>(null);

const done = computed(() => props.run.done);
const isMock = computed(() => done.value?.served_by?.backend_id === "mock");
const pct = (v: number | null) => (v === null ? 0 : Math.max(0, Math.min(100, v * 100)));
const fmt = (v: number | null | undefined, digits = 3) => (v === null || v === undefined ? "—" : v.toFixed(digits));
const levelClass = (level: string) =>
  ({
    high: "bg-emerald-100 text-emerald-800",
    medium: "bg-amber-100 text-amber-800",
    low: "bg-rose-100 text-rose-800",
  })[level] ?? "bg-slate-100";
const statusClass = (s: string) =>
  s === "ok" ? "text-emerald-700" : s === "running" ? "text-indigo-600" : "text-rose-700";
</script>

<template>
  <div class="space-y-4 text-sm">
    <section class="rounded-lg border border-slate-200 bg-white p-3">
      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Served by</h3>
      <div v-if="done?.served_by" class="flex flex-wrap items-center gap-2">
        <span class="font-mono">{{ done.served_by.backend_id }}</span>
        <span class="font-mono text-slate-500">{{ done.served_by.model }}</span>
        <span v-if="done.fallback_fired" class="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white"
          >FALLBACK</span
        >
        <span v-if="done.escalated" class="rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-bold text-white"
          >ESCALATED</span
        >
        <span v-if="isMock" class="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-bold text-white">MOCK</span>
      </div>
      <p v-else-if="done" class="text-slate-500">No backend served this request ({{ done.outcome }}).</p>
      <p v-else class="text-slate-400">{{ run.status === "streaming" ? "Waiting…" : "—" }}</p>
      <p v-if="done?.decisions.length" class="mt-2 text-xs text-slate-500">
        Routing: <span v-for="d in done.decisions" :key="d" class="block font-mono">{{ d }}</span>
      </p>
    </section>

    <section class="rounded-lg border border-slate-200 bg-white p-3">
      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Attempts</h3>
      <p v-if="!run.attempts.length" class="text-slate-400">
        No backend attempts{{ run.refusal ? " (refused before the LLM)" : "" }}.
      </p>
      <ol class="space-y-1 font-mono text-xs">
        <li v-for="a in run.attempts" :key="a.attempt" class="flex flex-wrap gap-x-2">
          <span class="text-slate-400">#{{ a.attempt }}</span>
          <span>{{ a.backend_id }}</span>
          <span class="text-slate-400">{{ a.reason }}</span>
          <span :class="statusClass(a.status)">→ {{ a.status }}</span>
          <span v-if="a.latency_ms !== null" class="text-slate-400">({{ a.latency_ms }} ms)</span>
          <span v-if="a.error && a.status !== 'ok'" class="w-full truncate pl-6 text-slate-500" :title="a.error">{{
            a.error
          }}</span>
        </li>
      </ol>
    </section>

    <section v-if="run.intent || run.retrieval" class="rounded-lg border border-slate-200 bg-white p-3">
      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Intent</h3>
      <template v-if="run.intent">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono font-semibold">{{ run.intent.final_intent }}</span>
          <span class="rounded px-1.5 py-0.5 text-xs font-semibold" :class="levelClass(run.intent.confidence.level)">
            {{ run.intent.confidence.level }} · {{ fmt(run.intent.confidence.score, 2) }}
          </span>
        </div>
        <table class="mt-2 w-full font-mono text-xs">
          <tbody>
            <tr>
              <td class="text-slate-500">LLM intent</td>
              <td :class="{ 'text-rose-700': !run.intent.confidence.signals.agree }">{{ run.intent.llm_intent }}</td>
            </tr>
            <tr>
              <td class="text-slate-500">kNN intent</td>
              <td :class="{ 'text-rose-700': !run.intent.confidence.signals.agree }">
                {{ run.intent.confidence.signals.knn_intent }}
              </td>
            </tr>
            <tr>
              <td class="text-slate-500">top-1 similarity</td>
              <td>{{ fmt(run.intent.confidence.signals.top1_similarity) }}</td>
            </tr>
            <tr>
              <td class="text-slate-500">vote share</td>
              <td>{{ fmt(run.intent.confidence.signals.vote_share, 2) }}</td>
            </tr>
            <tr>
              <td class="text-slate-500">thresholds</td>
              <td>
                T_oos {{ fmt(run.intent.confidence.signals.thresholds.T_oos) }} · T_high
                {{ fmt(run.intent.confidence.signals.thresholds.T_high) }}
              </td>
            </tr>
          </tbody>
        </table>
      </template>
      <p v-else-if="run.retrieval" class="font-mono text-xs">
        kNN intent <b>{{ run.retrieval.knn_intent }}</b> · vote {{ fmt(run.retrieval.vote_share, 2) }} · top-1
        {{ fmt(run.retrieval.top1_similarity) }}
      </p>
    </section>

    <section v-if="run.retrieval" class="rounded-lg border border-slate-200 bg-white p-3">
      <h3 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Retrieved
        <span
          class="rounded px-1.5 py-0.5 text-[10px] font-bold normal-case"
          :class="run.retrieval.mode === 'lexical_fallback' ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-700'"
          >{{ run.retrieval.mode === "lexical_fallback" ? "LEXICAL FALLBACK" : run.retrieval.mode }}</span
        >
      </h3>
      <ul class="space-y-2">
        <li v-for="e in run.retrieval.entries" :key="e.id" class="rounded border border-slate-100 p-2">
          <div class="flex items-center justify-between gap-2 text-xs">
            <span class="font-mono font-semibold">{{ e.intent }}</span>
            <span class="font-mono text-slate-400">{{ e.id }}</span>
          </div>
          <div v-if="e.dense_sim !== null" class="mt-1 flex items-center gap-2 text-xs">
            <div class="h-1.5 flex-1 rounded bg-slate-100">
              <div class="h-1.5 rounded bg-indigo-500" :style="{ width: pct(e.dense_sim) + '%' }" />
            </div>
            <span class="w-24 font-mono text-slate-600">dense {{ fmt(e.dense_sim) }}</span>
          </div>
          <div class="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px] text-slate-500">
            <span v-if="e.trgm_sim !== null">trgm {{ fmt(e.trgm_sim) }}</span>
            <span v-if="e.rrf !== null">rrf {{ fmt(e.rrf, 4) }}</span>
            <span v-if="e.dense_rank !== null">dense#{{ e.dense_rank }}</span>
            <span v-if="e.lex_rank !== null">lex#{{ e.lex_rank }}</span>
          </div>
          <p class="mt-1 text-xs text-slate-700">“{{ e.instruction }}”</p>
          <button
            class="mt-1 text-[11px] text-indigo-600 hover:underline"
            @click="expanded = expanded === e.id ? null : e.id"
          >
            {{ expanded === e.id ? "hide answer" : "show answer" }}
          </button>
          <p v-if="expanded === e.id" class="mt-1 whitespace-pre-wrap text-xs text-slate-600">
            {{ e.response_preview }}…
          </p>
        </li>
      </ul>
    </section>

    <section class="rounded-lg border border-slate-200 bg-white p-3">
      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Metrics</h3>
      <table v-if="done" class="w-full font-mono text-xs">
        <tbody>
          <tr>
            <td class="text-slate-500">TTFT</td>
            <td>{{ done.ttft_ms ?? "—" }} ms</td>
          </tr>
          <tr>
            <td class="text-slate-500">Total latency</td>
            <td>{{ done.latency_ms }} ms</td>
          </tr>
          <tr>
            <td class="text-slate-500">Tokens</td>
            <td>
              {{ done.usage.prompt_tokens }} in · {{ done.usage.completion_tokens }} out ·
              {{ done.usage.thinking_tokens }} thinking
              <span v-if="done.usage.estimated" class="text-amber-700">(est.)</span>
            </td>
          </tr>
          <tr>
            <td class="text-slate-500">Cost (est.)</td>
            <td>${{ done.cost_usd.toFixed(6) }}</td>
          </tr>
          <tr>
            <td class="text-slate-500">Quota left</td>
            <td>{{ done.quota.remaining.toLocaleString() }} / {{ done.quota.limit.toLocaleString() }}</td>
          </tr>
          <tr>
            <td class="text-slate-500">Outcome</td>
            <td>{{ done.outcome }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="text-slate-400">—</p>
      <RouterLink
        v-if="run.requestId"
        :to="`/requests/${run.requestId}`"
        class="mt-2 inline-block text-xs text-indigo-600 hover:underline"
      >
        Open request {{ run.requestId.slice(0, 8) }}… →
      </RouterLink>
    </section>

    <section class="rounded-lg border border-slate-200 bg-white p-3">
      <button class="text-xs font-semibold uppercase tracking-wide text-slate-500" @click="showRaw = !showRaw">
        {{ showRaw ? "▾" : "▸" }} Raw events ({{ run.raw.length }})
      </button>
      <ol v-if="showRaw" class="mt-2 max-h-72 space-y-1 overflow-auto font-mono text-[11px]">
        <li v-for="(r, i) in run.raw" :key="i">
          <span class="text-slate-400">{{ r.at }}ms</span> <b>{{ r.event }}</b> {{ JSON.stringify(r.data) }}
        </li>
      </ol>
    </section>
  </div>
</template>
