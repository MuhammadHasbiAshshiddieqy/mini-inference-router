<script setup lang="ts">
import { AdminRequestsResponseSchema, OUTCOMES, type RequestRow } from "@mir/shared";
import { onMounted, ref, watch } from "vue";
import AdminKeyInput from "../components/AdminKeyInput.vue";
import { adminKey } from "../lib/admin-key.ts";
import { ApiError, getJson } from "../lib/api.ts";

const rows = ref<RequestRow[]>([]);
const tenant = ref("");
const outcome = ref("");
const error = ref<string | null>(null);

async function load() {
  if (!adminKey.value) return;
  const params = new URLSearchParams({ limit: "50" });
  if (tenant.value) params.set("tenant", tenant.value);
  if (outcome.value) params.set("outcome", outcome.value);
  try {
    rows.value = (await getJson(`/admin/requests?${params}`, AdminRequestsResponseSchema, adminKey.value)).requests;
    error.value = null;
  } catch (err) {
    error.value = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
  }
}
watch([adminKey, tenant, outcome], load);
onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-4">
      <h1 class="text-lg font-semibold">Recent requests</h1>
      <AdminKeyInput />
      <input v-model.lazy="tenant" class="rounded border border-slate-300 px-2 py-1 text-sm" placeholder="tenant" />
      <select v-model="outcome" class="rounded border border-slate-300 px-2 py-1 text-sm">
        <option value="">all outcomes</option>
        <option v-for="o in OUTCOMES" :key="o" :value="o">{{ o }}</option>
      </select>
      <button class="rounded border border-slate-300 px-3 py-1 text-sm" @click="load">Refresh</button>
    </div>
    <p v-if="error" class="text-sm text-rose-700">{{ error }}</p>
    <table class="w-full rounded-lg border border-slate-200 bg-white text-sm">
      <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500">
        <tr>
          <th class="p-2">Time</th>
          <th class="p-2">Tenant</th>
          <th class="p-2">Endpoint</th>
          <th class="p-2">Outcome</th>
          <th class="p-2">Served by</th>
          <th class="p-2">Fallback</th>
          <th class="p-2 text-right">Tokens</th>
          <th class="p-2 text-right">Latency</th>
          <th class="p-2 text-right">Cost (est.)</th>
        </tr>
      </thead>
      <tbody class="font-mono text-xs">
        <tr v-for="r in rows" :key="r.id" class="border-t border-slate-100 hover:bg-indigo-50">
          <td class="p-2">
            <RouterLink :to="`/requests/${r.id}`" class="text-indigo-600 hover:underline">{{
              new Date(r.created_at).toLocaleTimeString()
            }}</RouterLink>
          </td>
          <td class="p-2">{{ r.tenant_id }}</td>
          <td class="p-2">{{ r.endpoint }}</td>
          <td class="p-2">{{ r.outcome }}</td>
          <td class="p-2">{{ r.served_backend_id ?? "—" }}</td>
          <td class="p-2">{{ r.fallback_fired ? "yes" : "" }}{{ r.escalated ? " esc" : "" }}</td>
          <td class="p-2 text-right">
            {{ r.total_tokens }}<span v-if="r.tokens_estimated" class="text-amber-700">*</span>
          </td>
          <td class="p-2 text-right">{{ r.latency_ms ?? "—" }} ms</td>
          <td class="p-2 text-right">${{ Number(r.cost_usd).toFixed(6) }}</td>
        </tr>
      </tbody>
    </table>
    <p class="text-xs text-slate-400">* estimated token count (mock backend, or provider usage missing)</p>
  </div>
</template>
