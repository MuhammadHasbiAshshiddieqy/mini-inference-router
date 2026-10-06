<script setup lang="ts">
import { adminKey } from "../lib/admin-key.ts";
</script>

<template>
  <label class="flex items-center gap-2 text-xs text-slate-500">
    Admin key
    <input
      v-model="adminKey"
      type="password"
      class="w-56 rounded border border-slate-300 px-2 py-1 font-mono"
      placeholder="ADMIN_API_KEY"
    />
  </label>
</template>
