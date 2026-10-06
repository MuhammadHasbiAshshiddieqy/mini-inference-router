<script setup lang="ts">
import { AdminRequestDetailSchema, type AdminRequestDetail } from "@mir/shared";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import AdminKeyInput from "../components/AdminKeyInput.vue";
import { adminKey } from "../lib/admin-key.ts";
import { ApiError, getJson } from "../lib/api.ts";

// The fallback decision record (R9): the request row plus every route attempt with its reason and status.
const route = useRoute();
const id = computed(() => String(route.params["id"] ?? ""));
const detail = ref<AdminRequestDetail | null>(null);
const error = ref<string | null>(null);

async function load() {
  if (!adminKey.value || !id.value) return;
  try {
    detail.value = await getJson(`/admin/requests/${id.value}`, AdminRequestDetailSchema, adminKey.value);
    error.value = null;
  } catch (err) {
    error.value = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
  }
}
watch([adminKey, id], load);
onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-4">
      <RouterLink to="/requests" class="text-sm text-indigo-600 hover:underline">← requests</RouterLink>
      <h1 class="font-mono text-sm">{{ id }}</h1>
      <AdminKeyInput />
    </div>
    <p v-if="!adminKey" class="text-sm text-slate-500">Enter the admin key to inspect this request.</p>
    <p v-if="error" class="text-sm text-rose-700">{{ error }}</p>
    <template v-if="detail">
      <div class="grid grid-cols-4 gap-2 rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs">
        <div v-for="(v, k) in detail.request" :key="k">
          <div class="text-slate-400">{{ k }}</div>
          <div class="truncate" :title="String(v)">{{ Array.isArray(v) ? v.join(", ") : (v ?? "—") }}</div>
        </div>
      </div>
      <h2 class="font-semibold">Route attempts</h2>
      <table class="w-full rounded-lg border border-slate-200 bg-white text-sm">
        <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th class="p-2">#</th>
            <th class="p-2">Backend</th>
            <th class="p-2">Model</th>
            <th class="p-2">Reason</th>
            <th class="p-2">Status</th>
            <th class="p-2">Error</th>
            <th class="p-2 text-right">Tokens (in/out/think)</th>
            <th class="p-2 text-right">Latency</th>
            <th class="p-2 text-right">TTFT</th>
            <th class="p-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody class="font-mono text-xs">
          <tr v-for="a in detail.attempts" :key="a.attempt_no" class="border-t border-slate-100">
            <td class="p-2">{{ a.attempt_no }}</td>
            <td class="p-2">{{ a.backend_id }}</td>
            <td class="p-2">{{ a.model }}</td>
            <td class="p-2">{{ a.reason }}</td>
            <td class="p-2" :class="a.status === 'ok' ? 'text-emerald-700' : 'text-rose-700'">{{ a.status }}</td>
            <td class="max-w-xs truncate p-2 text-slate-500" :title="a.error_detail ?? ''">
              {{ a.error_detail ?? "" }}
            </td>
            <td class="p-2 text-right">
              {{ a.prompt_tokens ?? "—" }}/{{ a.completion_tokens ?? "—" }}/{{ a.thinking_tokens ?? "—" }}
            </td>
            <td class="p-2 text-right">{{ a.latency_ms ?? "—" }} ms</td>
            <td class="p-2 text-right">{{ a.ttft_ms ?? "—" }}</td>
            <td class="p-2 text-right">${{ Number(a.cost_usd).toFixed(6) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!detail.attempts.length" class="text-sm text-slate-500">
        No backend attempts (rejected or refused before any LLM call).
      </p>
    </template>
  </div>
</template>
