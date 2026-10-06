<script setup lang="ts">
import { GATEWAY_URL } from "./lib/config.ts";
</script>

<template>
  <header class="border-b border-slate-200 bg-white">
    <nav class="mx-auto flex max-w-[1440px] items-center gap-6 px-6 py-3 text-sm">
      <span class="font-semibold">Mini Inference Router</span>
      <RouterLink to="/playground" active-class="text-indigo-600 font-medium">Playground</RouterLink>
      <RouterLink to="/usage" active-class="text-indigo-600 font-medium">Usage</RouterLink>
      <RouterLink to="/requests" active-class="text-indigo-600 font-medium">Requests</RouterLink>
      <span class="ml-auto font-mono text-xs text-slate-400">{{ GATEWAY_URL }}</span>
    </nav>
  </header>
  <main class="mx-auto max-w-[1440px] px-6 py-6">
    <RouterView />
  </main>
</template>
