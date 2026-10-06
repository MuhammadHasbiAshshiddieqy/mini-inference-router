<script setup lang="ts">
import { AdminUsageResponseSchema, type AdminUsageResponse } from "@mir/shared";
import { onMounted, onUnmounted, ref, watch } from "vue";
import AdminKeyInput from "../components/AdminKeyInput.vue";
import { adminKey } from "../lib/admin-key.ts";
import { ApiError, getJson } from "../lib/api.ts";

// Usage (R17): requests and cost per tenant, and remaining quota. Auto-refreshes every 10 s.
const data = ref<AdminUsageResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  if (!adminKey.value) return;
  loading.value = true;
  try {
    data.value = await getJson("/admin/usage", AdminUsageResponseSchema, adminKey.value);
    error.value = null;
  } catch (err) {
    error.value = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
  } finally {
    loading.value = false;
  }
}
const count = (o: Record<string, number>, ...keys: string[]) => keys.reduce((s, k) => s + (o[k] ?? 0), 0);
const errors = (o: Record<string, number>) =>
  count(o, "all_backends_failed", "partial_error", "internal_error", "quota_exceeded", "invalid_request");
const usedPct = (q: { limit: number; used: number }) => (q.limit ? Math.min(100, (q.used / q.limit) * 100) : 0);

watch(adminKey, load);
onMounted(() => {
  void load();
  timer = setInterval(load, 10_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-4">
      <h1 class="text-lg font-semibold">Usage per tenant</h1>
      <AdminKeyInput />
      <button class="rounded border border-slate-300 px-3 py-1 text-sm" :disabled="loading" @click="load">
        Refresh
      </button>
      <span class="text-xs text-slate-400">auto-refresh 10 s</span>
    </div>
    <p v-if="!adminKey" class="text-sm text-slate-500">Enter the admin key to see usage.</p>
    <p v-if="error" class="text-sm text-rose-700">{{ error }}</p>
    <table v-if="data" class="w-full rounded-lg border border-slate-200 bg-white text-sm">
      <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500">
        <tr>
          <th class="p-2">Tenant</th>
          <th class="p-2 text-right">Requests</th>
          <th class="p-2 text-right">OK</th>
          <th class="p-2 text-right">Refused</th>
          <th class="p-2 text-right">Fallback</th>
          <th class="p-2 text-right">Errors</th>
          <th class="p-2 text-right">Tokens</th>
          <th class="p-2 text-right">Cost (est.)</th>
          <th class="p-2">Quota (used / limit)</th>
          <th class="p-2">Last request</th>
        </tr>
      </thead>
      <tbody class="font-mono text-xs">
        <tr v-for="t in data.tenants" :key="t.id" class="border-t border-slate-100">
          <td class="p-2 font-sans">
            <b>{{ t.id }}</b> <span class="text-slate-400">{{ t.name }}</span>
            <span v-if="!t.enabled" class="ml-1 text-rose-600">disabled</span>
          </td>
          <td class="p-2 text-right">{{ t.usage.requests }}</td>
          <td class="p-2 text-right">{{ count(t.usage.outcomes, "ok", "ok_after_fallback") }}</td>
          <td class="p-2 text-right">{{ count(t.usage.outcomes, "refused") }}</td>
          <td class="p-2 text-right">{{ t.usage.fallback_count }}</td>
          <td class="p-2 text-right">{{ errors(t.usage.outcomes) }}</td>
          <td class="p-2 text-right">{{ t.usage.total_tokens.toLocaleString() }}</td>
          <td class="p-2 text-right">${{ t.usage.cost_usd.toFixed(6) }}</td>
          <td class="p-2">
            <div class="h-2 w-40 rounded bg-slate-100">
              <div
                class="h-2 rounded"
                :class="usedPct(t.quota) > 90 ? 'bg-rose-500' : 'bg-indigo-500'"
                :style="{ width: usedPct(t.quota) + '%' }"
              />
            </div>
            <span class="text-slate-500"
              >{{ t.quota.used.toLocaleString() }} / {{ t.quota.limit.toLocaleString() }} ·
              <b>{{ t.quota.remaining.toLocaleString() }}</b> left</span
            >
          </td>
          <td class="p-2 text-slate-500">
            {{ t.usage.last_request_at ? new Date(t.usage.last_request_at).toLocaleTimeString() : "—" }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
