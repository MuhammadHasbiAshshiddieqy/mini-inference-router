#!/usr/bin/env bash
# Black-box smoke test of a running gateway (docs/08 §3). Prints PASS/FAIL per check; exits 1 if any fail.
#   BASE=https://<gateway> KEY=<acme key> TINY=<tiny key> GLOBEX=<globex key> ADMIN=<admin key> ./scripts/smoke.sh
# Works against any profile: the backend order is read from /healthz (primary = first backend).
# Uses curl and node (for JSON). Spends a handful of real model calls on the primary/fallback backends.
set -uo pipefail

BASE="${BASE:-http://localhost:8787}"
: "${KEY:?set KEY (acme)}" "${TINY:?set TINY}" "${GLOBEX:?set GLOBEX}" "${ADMIN:?set ADMIN}"
EXPECT_PROFILE="${EXPECT_PROFILE:-}"
pass=0
fail=0
check() { # name, condition result (0 = ok), detail
  if [ "$2" -eq 0 ]; then echo "PASS  $1"; pass=$((pass + 1)); else echo "FAIL  $1 — $3"; fail=$((fail + 1)); fi
}
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s);const r=($1);process.stdout.write(r===undefined?'':String(r))}catch(e){process.stdout.write('')}})"; }
post() { # path, key, body → body (status in $STATUS)
  local out
  out=$(curl -s -w $'\n%{http_code}' -X POST "$BASE$1" -H "authorization: Bearer $2" -H "content-type: application/json" -d "$3")
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

# 1. health + profile
health=$(curl -s "$BASE/healthz")
profile=$(echo "$health" | json 'v.profile')
primary=$(echo "$health" | json 'v.backends[0].id')
real=$(echo "$health" | json 'v.backends.filter(b=>b.id!=="mock").map(b=>b.id).join(",")')
second=$(echo "$health" | json 'v.backends[1].id')
[ -n "$profile" ] && { [ -z "$EXPECT_PROFILE" ] || [ "$profile" = "$EXPECT_PROFILE" ]; }
check "1. /healthz answers (profile=$profile, primary=$primary, status=$(echo "$health" | json 'v.status'))" $? "$health"

# 2. auth
post /v1/support/answer "" '{"message":"hi"}'
[ "$STATUS" = 401 ] && [ "$(echo "$BODY" | json 'v.error.code')" = missing_api_key ]
check "2a. no key → 401 missing_api_key" $? "$STATUS $BODY"
post /v1/support/answer "mir_not_a_real_key_0000000000000000" '{"message":"hi"}'
[ "$STATUS" = 401 ] && [ "$(echo "$BODY" | json 'v.error.code')" = invalid_api_key ]
check "2b. bad key → 401 invalid_api_key" $? "$STATUS $BODY"

# 3. validation
post /v1/support/answer "$KEY" '{"message":""}'
[ "$STATUS" = 400 ] && [ "$(echo "$BODY" | json 'v.error.code')" = invalid_request ]
check "3. bad body → 400 invalid_request" $? "$STATUS $BODY"

# 4. streaming support answer
sse=$(curl -sN -X POST "$BASE/v1/support/answer" -H "authorization: Bearer $KEY" -H "content-type: application/json" -d '{"message":"how do i change my shipping address"}')
events=$(echo "$sse" | grep '^event: ' | sed 's/event: //' | uniq | tr '\n' ' ')
done_outcome=$(echo "$sse" | grep -A1 '^event: done' | tail -1 | sed 's/^data: //' | json 'v.outcome')
[[ "$events" == "meta retrieval route "*"intent token "*"done " ]] && [[ "$done_outcome" == ok* ]]
check "4. SSE stream: ${events}→ ${done_outcome}" $? "$events / $done_outcome"

# 5. force-fail the primary → fallback, recorded
post /v1/support/answer "$KEY" "{\"message\":\"how do i change my shipping address\",\"stream\":false,\"debug\":{\"force_fail\":[\"$primary\"]}}"
fallback_id=$(echo "$BODY" | json 'v.request_id')
served=$(echo "$BODY" | json 'v.served_by && v.served_by.backend_id')
[ "$STATUS" = 200 ] && [ "$(echo "$BODY" | json 'v.fallback_fired')" = true ] && [ "$served" = "$second" ]
check "5. force-fail $primary → served by $served (fallback_fired)" $? "$STATUS $BODY"

# 6. force-fail every real backend → mock
post /v1/support/answer "$KEY" "{\"message\":\"how do i change my shipping address\",\"stream\":false,\"debug\":{\"force_fail\":[\"${real//,/\",\"}\"]}}"
[ "$(echo "$BODY" | json 'v.served_by && v.served_by.backend_id')" = mock ]
check "6. force-fail all real backends → served by mock" $? "$STATUS $BODY"

# 7. tenant policy (globex: gemini-3-flash + mock only; no debug)
post /v1/chat "$GLOBEX" '{"messages":[{"role":"user","content":"Say hello in five words."}],"stream":false}'
gserved=$(echo "$BODY" | json 'v.served_by && v.served_by.backend_id')
gattempts=$(echo "$BODY" | json 'v.attempts.map(a=>a.backend_id).join(",")')
[ "$STATUS" = 200 ] && [[ ",$gattempts," != *",gemini-3.5-flash,"* ]] && [[ "$gserved" == gemini-3-flash || "$gserved" == mock ]]
check "7a. globex served by $gserved, attempts [$gattempts] never include gemini-3.5-flash" $? "$STATUS $BODY"
post /v1/support/answer "$GLOBEX" '{"message":"hi","debug":{"mock_fail":true}}'
[ "$STATUS" = 403 ] && [ "$(echo "$BODY" | json 'v.error.code')" = debug_not_allowed ]
check "7b. globex with debug → 403 debug_not_allowed" $? "$STATUS $BODY"

# 8. refusal and lexical fallback
post /v1/support/answer "$KEY" '{"message":"Can you write me a poem about the sea?","stream":false}'
[ "$(echo "$BODY" | json 'v.refused')" = true ]
check "8a. OOS → refusal ($(echo "$BODY" | json 'v.refusal_reason'))" $? "$BODY"
post /v1/support/answer "$KEY" '{"message":"I want to cancel my order","stream":false,"debug":{"force_embedding_fail":true}}'
level=$(echo "$BODY" | json 'v.confidence && v.confidence.level')
[ "$(echo "$BODY" | json 'v.retrieval_mode')" = lexical_fallback ] && [ "$level" != high ] && [ -n "$(echo "$BODY" | json 'v.answer')" ]
check "8b. embedding outage → lexical_fallback, answered, confidence $level" $? "$BODY"

# 9. quota exhaustion on tiny
code=""
for _ in 1 2 3 4 5 6 7 8; do
  post /v1/support/answer "$TINY" '{"message":"how do i change my shipping address","stream":false}'
  if [ "$STATUS" = 429 ]; then code=$(echo "$BODY" | json 'v.error.code'); break; fi
done
[ "$code" = quota_exceeded ]
check "9. tiny exhausted → 429 quota_exceeded (remaining $(echo "$BODY" | json 'v.error.details.remaining') < requested $(echo "$BODY" | json 'v.error.details.requested'))" $? "$STATUS $BODY"

# 10. the fallback decision is recorded and inspectable
detail=$(curl -s "$BASE/admin/requests/$fallback_id" -H "authorization: Bearer $ADMIN")
reasons=$(echo "$detail" | json 'v.attempts.map(a=>a.reason+"/"+a.status).join(" ")')
[[ "$reasons" == "primary/forced_failure fallback:forced_failure/ok" ]]
check "10. /admin/requests/<id> → $reasons" $? "$detail"

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
