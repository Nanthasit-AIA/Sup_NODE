<script setup lang="ts">
import {
  referenceMismatch, RISK_STYLE, ROMAN,
  type CauseReview, type Edit, type Evaluated, type ProposedIpl, type ReferenceRow, type Rules, type Stage,
} from '~/utils/lopa'
import type { PosCause } from '~/utils/supernode'

const props = defineProps<{
  cause: PosCause; review?: CauseReview; ev: Evaluated | null; reference: ReferenceRow | null
  rules: Rules; edit?: Edit; open: boolean
}>()
const emit = defineEmits<{ toggle: []; edit: [edit: Edit | undefined] }>()

const typeLabel = (id: string) => props.rules.ipl_types.find(t => t.id === id)?.label ?? id
const credited = computed(() => props.ev?.existing.filter(e => e.credited) ?? [])
const mismatch = computed(() => props.reference && referenceMismatch(props.rules, props.reference))
const patch = (p: Edit) => emit('edit', { ...props.edit, ...p })
const toggleIn = (key: 'existing' | 'proposed', i: number, value: boolean) => patch({ [key]: { ...props.edit?.[key], [i]: value } })
const stageText = (s: Stage | null) => (s ? `F-${s.f} · ${s.credits ? `−${s.credits}` : 'no credit'}` : '')
const shortTags = (tags: string[]) => tags.slice(0, 3).join(' + ') + (tags.length > 3 ? ` +${tags.length - 3}` : '')
const why = (p: ProposedIpl) => p.reasoning ?? p.rationale ?? ''
const whyDialog = ref<HTMLDialogElement>()
</script>

<template>
  <tr class="border-t border-zinc-100 align-top" :class="open && 'bg-zinc-50'">
    <td class="py-3 pl-4 pr-3">
      <p class="font-mono text-[11px] text-zinc-400">{{ cause.cause_id }}</p>
      <p class="text-zinc-900">{{ cause.cause }}</p>
      <p class="mt-0.5 text-xs text-zinc-400">{{ cause.cause_source }}</p>
    </td>
    <td class="max-w-64 px-3 py-3 text-xs leading-relaxed text-zinc-600">
      <p class="line-clamp-4">{{ cause.propagated_consequence }}</p>
    </td>

    <template v-if="ev && review">
      <td class="whitespace-nowrap px-3 py-3 text-center">
        <template v-if="ev.unmitigated">
          <span class="rounded px-2 py-0.5 text-xs font-semibold" :class="RISK_STYLE[ev.unmitigated.r]">{{ ROMAN[ev.unmitigated.r] }}</span>
          <p class="mt-1 text-[11px] text-zinc-400">C-{{ ev.severity }} · F-{{ ev.unmitigated.f }}</p>
        </template>
        <span v-else class="text-xs text-zinc-400">screened out</span>
      </td>
      <td class="px-3 py-3 text-xs">
        <p v-for="(e, i) in credited" :key="i" class="mb-1 flex flex-wrap items-baseline gap-1">
          <span class="font-mono" :title="e.ipl.tags.join(' + ')">{{ shortTags(e.ipl.tags) }}</span><span class="text-zinc-400">−{{ e.credit }}</span>
        </p>
        <p v-if="ev.existing.length > credited.length" class="text-zinc-400">+{{ ev.existing.length - credited.length }} not credited</p>
        <p v-if="!ev.existing.length" class="text-zinc-400">none</p>
      </td>
      <td class="whitespace-nowrap px-3 py-3 text-center">
        <span v-if="ev.current" class="rounded px-2 py-0.5 text-xs font-semibold" :class="RISK_STYLE[ev.current.r]">{{ ROMAN[ev.current.r] }}</span>
      </td>
      <td class="px-3 py-3 text-xs">
        <p v-for="(p, i) in ev.proposed" :key="i" class="mb-1" :class="!p.included && 'line-through opacity-40'">
          <span class="font-mono" :title="p.ipl.tags.join(' + ')">{{ shortTags(p.ipl.tags) }}</span> <span class="text-zinc-400">−{{ p.credit }}</span>
        </p>
        <p v-if="!ev.proposed.length" class="text-zinc-400">none needed</p>
        <button
          v-if="ev.proposed.length" type="button" class="mt-1 rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 hover:border-black hover:text-black"
          @click="whyDialog?.showModal()"
        >
          Why these IPLs?
        </button>

        <!-- AI reasoning per proposed IPL: why it is proposed and what it protects -->
        <dialog
          ref="whyDialog" class="m-auto w-[min(720px,calc(100vw-32px))] rounded-2xl bg-white p-0 shadow-2xl backdrop:bg-black/40"
          @click.self="whyDialog?.close()"
        >
          <div class="max-h-[80vh] overflow-y-auto p-6 text-sm">
            <header class="flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <p class="font-mono text-[11px] text-zinc-400">{{ cause.cause_id }} · AI proposed IPLs</p>
                <h3 class="mt-0.5 text-lg font-medium leading-snug">{{ cause.cause }}</h3>
                <p v-if="ev.current && ev.improved" class="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-500">
                  Risk now
                  <span class="rounded px-1.5 py-0.5 font-semibold" :class="RISK_STYLE[ev.current.r]">{{ ROMAN[ev.current.r] }}</span>
                  → with all proposals
                  <span class="rounded px-1.5 py-0.5 font-semibold" :class="RISK_STYLE[ev.improved.r]">{{ ROMAN[ev.improved.r] }}</span>
                </p>
              </div>
              <button type="button" aria-label="Close" class="text-zinc-400 hover:text-black" @click="whyDialog?.close()">✕</button>
            </header>

            <article v-for="(p, i) in ev.proposed" :key="i" class="mt-5 rounded-xl border border-zinc-200 p-4">
              <p class="font-medium">{{ i + 1 }}. {{ p.ipl.description }}</p>
              <p class="mt-0.5 text-xs text-zinc-500">{{ typeLabel(p.ipl.ipl_type) }} (−{{ p.credit }}) · <span class="font-mono">{{ p.ipl.tags.join(', ') }}</span></p>

              <h4 class="mt-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">1 · Why the AI proposes it</h4>
              <p class="mt-1 leading-relaxed text-zinc-700">{{ why(p.ipl) }}</p>

              <h4 class="mt-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">2 · What it protects in the process</h4>
              <p v-if="p.ipl.process_benefit" class="mt-1 leading-relaxed text-zinc-700">{{ p.ipl.process_benefit }}</p>
              <p v-else class="mt-1 text-xs text-zinc-500">This review was cached before the AI split out the process benefit. Re-run the AI for this deviation to get it.</p>
              <div v-if="p.ipl.protected_targets?.length" class="mt-2 flex flex-wrap gap-1.5">
                <span v-for="t in p.ipl.protected_targets" :key="t" class="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs">{{ t }}</span>
              </div>

              <p v-if="p.alone && ev.current" class="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                Risk effect of this IPL alone:
                <span class="rounded px-1.5 py-0.5 font-semibold" :class="RISK_STYLE[ev.current.r]">{{ ROMAN[ev.current.r] }}</span>
                →
                <span class="rounded px-1.5 py-0.5 font-semibold" :class="RISK_STYLE[p.alone.r]">{{ ROMAN[p.alone.r] }}</span>
                <span>(F-{{ ev.current.f }} → F-{{ p.alone.f }})</span>
              </p>
            </article>

            <p class="mt-4 text-xs text-zinc-400">AI judgement — confirm with the HAZOP team. Credits and risk ranks come from the company LOPA tables, not the AI.</p>
          </div>
        </dialog>
      </td>
      <td class="whitespace-nowrap px-3 py-3 text-center">
        <span v-if="ev.improved" class="rounded px-2 py-0.5 text-xs font-semibold" :class="RISK_STYLE[ev.improved.r]">{{ ROMAN[ev.improved.r] }}</span>
      </td>
      <td class="whitespace-nowrap px-3 py-3 text-xs">
        <template v-if="reference?.R">
          <span class="font-mono text-zinc-500">{{ reference.id }}</span>
          <span class="ml-1.5 rounded px-1.5 py-0.5 font-semibold" :class="RISK_STYLE[reference.R]">{{ ROMAN[reference.R] }}</span>
          →
          <span class="rounded px-1.5 py-0.5 font-semibold" :class="RISK_STYLE[reference.R_after!]">{{ ROMAN[reference.R_after!] }}</span>
          <span v-if="mismatch" class="ml-1 text-amber-600" :title="mismatch">⚠</span>
        </template>
        <span v-else class="text-zinc-300">—</span>
      </td>
      <td class="py-3 pr-4 text-right">
        <button type="button" :aria-expanded="open" class="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-200" @click="emit('toggle')">
          {{ open ? '▾' : '▸' }}
        </button>
      </td>
    </template>
    <td v-else colspan="7" class="px-3 py-3 text-xs text-zinc-400">Not reviewed yet</td>
  </tr>

  <tr v-if="open && ev && review" class="bg-zinc-50">
    <td colspan="9" class="px-4 pb-5">
      <div class="grid gap-6 rounded-xl bg-white p-5 shadow-sm lg:grid-cols-3">
        <!-- risk inputs -->
        <section class="space-y-3 text-sm">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Risk inputs (editable)</h4>
          <label class="block">
            <span class="text-xs text-zinc-500">Severity</span>
            <select
              :value="ev.severity" class="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5"
              @change="patch({ severity: Number(($event.target as HTMLSelectElement).value) })"
            >
              <option v-for="c in rules.consequence_categories" :key="c.c" :value="c.c">C-{{ c.c }} · {{ c.safety }}</option>
            </select>
          </label>
          <p class="text-xs leading-relaxed text-zinc-600">{{ review.severity_reason }}</p>
          <label class="block">
            <span class="text-xs text-zinc-500">Initiating event (Table B1)</span>
            <select
              :value="ev.initiatingEvent.id" class="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5"
              @change="patch({ initiatingEvent: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="e in rules.initiating_events" :key="e.id" :value="e.id">{{ e.label }}{{ e.per_year ? ` · ${e.per_year}/yr` : '' }}</option>
            </select>
          </label>
          <p class="text-xs leading-relaxed text-zinc-600">{{ review.initiating_event_reason }}</p>
          <p class="text-xs text-zinc-500">
            Before {{ stageText(ev.unmitigated) }} → existing {{ stageText(ev.current) }} → with proposals {{ stageText(ev.improved) }}
          </p>
          <button v-if="edit" type="button" class="text-xs text-zinc-500 underline hover:text-black" @click="emit('edit', undefined)">
            Reset to AI judgement
          </button>
        </section>

        <!-- existing protection -->
        <section class="space-y-3 text-sm">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Existing protection</h4>
          <label v-for="(e, i) in ev.existing" :key="i" class="flex gap-2.5">
            <input
              type="checkbox" class="mt-1 size-4 accent-black" :checked="e.credited"
              @change="toggleIn('existing', i, ($event.target as HTMLInputElement).checked)"
            >
            <span class="min-w-0">
              <span class="font-mono text-xs">{{ e.ipl.tags.join(' + ') }}</span>
              <span class="text-xs text-zinc-500"> · {{ typeLabel(e.ipl.ipl_type) }} (−{{ e.credit }})</span>
              <span class="mt-1 flex gap-1 text-[10px]">
                <b v-for="k in (['independent', 'effective', 'auditable'] as const)" :key="k" class="rounded px-1.5 py-0.5 font-medium" :class="e.ipl[k] ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'">
                  {{ k }} {{ e.ipl[k] ? '✓' : '✗' }}
                </b>
              </span>
              <span class="mt-1 block text-xs leading-relaxed text-zinc-600">{{ e.ipl.reason }}</span>
            </span>
          </label>
          <div v-if="review.other_safeguards.length">
            <p class="text-xs text-zinc-400">Other safeguards (not IPL)</p>
            <ul class="mt-1 list-disc space-y-0.5 pl-4 text-xs text-zinc-600">
              <li v-for="s in review.other_safeguards" :key="s">{{ s }}</li>
            </ul>
          </div>
        </section>

        <!-- backward step: proposals, verdict, engineer reference -->
        <section class="space-y-3 text-sm">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">AI proposed IPLs</h4>
          <p v-if="!ev.proposed.length" class="text-xs text-zinc-500">No additional IPL proposed.</p>
          <label v-for="(p, i) in ev.proposed" :key="i" class="flex gap-2.5">
            <input
              type="checkbox" class="mt-1 size-4 accent-black" :checked="p.included"
              @change="toggleIn('proposed', i, ($event.target as HTMLInputElement).checked)"
            >
            <span class="min-w-0">
              <span class="block font-medium">{{ p.ipl.description }}</span>
              <span class="text-xs text-zinc-500">{{ typeLabel(p.ipl.ipl_type) }} (−{{ p.credit }}) · <span class="font-mono">{{ p.ipl.tags.join(', ') }}</span></span>
              <span class="mt-1 block text-xs leading-relaxed text-zinc-600">{{ why(p.ipl) }}</span>
              <span v-if="p.ipl.process_benefit" class="mt-1 block text-xs leading-relaxed text-zinc-600"><b class="font-medium">Protects:</b> {{ p.ipl.process_benefit }}</span>
            </span>
          </label>
          <p class="rounded-lg bg-zinc-100 p-3 text-xs leading-relaxed text-zinc-700"><b>AI verdict.</b> {{ review.verdict }}</p>
          <div v-if="reference" class="rounded-lg border border-zinc-200 p-3 text-xs leading-relaxed">
            <p class="font-medium">Engineer worksheet {{ reference.id }}</p>
            <p class="mt-1 text-zinc-600">{{ reference.cause }} → {{ reference.consequence }}</p>
            <p v-if="reference.S" class="mt-1 text-zinc-600">S{{ reference.S }}·L{{ reference.L }}·{{ ROMAN[reference.R!] }} → S{{ reference.S_after }}·L{{ reference.L_after }}·{{ ROMAN[reference.R_after!] }}</p>
            <p v-for="i in reference.ipls" :key="i.text" class="text-zinc-600">IPL: {{ i.text }}</p>
            <p v-if="reference.recommendation" class="text-zinc-600">Recommendation: {{ reference.recommendation }}</p>
            <p v-if="mismatch" class="mt-1 text-amber-700">⚠ {{ mismatch }}</p>
          </div>
        </section>
      </div>
    </td>
  </tr>
</template>
