<script setup lang="ts">
import { computed } from "vue";

// Renders model text with {{Placeholders}} as subtle chips: they are template slots, kept on purpose (docs/02 §6).
const props = defineProps<{ text: string; streaming?: boolean }>();
const parts = computed(() =>
  props.text
    .split(/(\{\{[^}]*\}\})/g)
    .map((p) => ({ chip: /^\{\{.*\}\}$/.test(p), text: p.replace(/^\{\{|\}\}$/g, "") })),
);
</script>

<template>
  <p class="whitespace-pre-wrap leading-relaxed" :class="{ caret: streaming }">
    <template v-for="(p, i) in parts" :key="i">
      <span v-if="p.chip" class="mx-0.5 rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{{
        p.text
      }}</span>
      <template v-else>{{ p.text }}</template>
    </template>
  </p>
</template>
