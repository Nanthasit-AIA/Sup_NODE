<script setup lang="ts">
import { RISK_STYLE, ROMAN, type Rules } from '~/utils/lopa'

const props = defineProps<{
  rules: Rules
  points: { f: number; s: number }[] // scenarios at the chosen stage
  marks: { f: number; s: number; label: string }[] // stages of the selected scenario
}>()

const count = (f: number, s: number) => props.points.filter(p => p.f === f && p.s === s).length
const marksAt = (f: number, s: number) => props.marks.filter(m => m.f === f && m.s === s)
const rank = (f: number, s: number) => props.rules.risk_matrix.rows[f - 1]![s - 1]!
</script>

<template>
  <div class="grid grid-cols-[auto_repeat(5,minmax(0,1fr))] gap-1 text-xs">
    <span />
    <span v-for="s in 5" :key="s" class="pb-0.5 text-center text-zinc-500" :title="rules.consequence_categories[s - 1]!.safety">C-{{ s }}</span>
    <template v-for="f in 5" :key="f">
      <span class="self-center pr-1.5 text-right text-zinc-500" :title="rules.frequency_categories[f - 1]!.range">F-{{ f }}</span>
      <div
        v-for="s in 5" :key="s" class="relative grid h-12 place-items-center rounded-md" :class="RISK_STYLE[rank(f, s)]"
        :title="`F-${f} × C-${s} → ${ROMAN[rank(f, s)]}: ${count(f, s)} scenario(s)`"
      >
        <span class="absolute left-1.5 top-0.5 text-[10px] opacity-60">{{ ROMAN[rank(f, s)] }}</span>
        <span v-if="count(f, s)" class="text-base font-semibold">{{ count(f, s) }}</span>
        <span v-if="marksAt(f, s).length" class="absolute bottom-0.5 right-1 flex gap-0.5">
          <b v-for="m in marksAt(f, s)" :key="m.label" class="rounded bg-black px-1 text-[9px] leading-4 text-white">{{ m.label }}</b>
        </span>
      </div>
    </template>
  </div>
</template>
