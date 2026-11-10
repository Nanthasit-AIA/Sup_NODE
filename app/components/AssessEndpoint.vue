<script setup lang="ts">
import {
  CHECKS, itemKey, type CheckKey, type EndpointEval, type Layer, type ReviewField, type ReviewRequest, type ReviewState,
} from '~/utils/assess'
import { RISK_STYLE, ROMAN, type Rules, type Stage } from '~/utils/lopa'

const props = defineProps<{ e: EndpointEval; rules: Rules; reviews: Map<string, ReviewState>; labels: Map<string, string>; open: boolean }>()
const emit = defineEmits<{ toggle: []; review: [request: ReviewRequest] }>()

const id = computed(() => props.e.endpoint.endpoint_id)
const STAGES = [['R0', 'unmitigated'], ['R1', 'as-is: qualified layers'], ['R1p', 'if pending evidence is confirmed'], ['R2', 'projected: + proposals, conditional']] as const
const STATUS_STYLE: Record<Layer['status'], string> = {
  qualified: 'bg-emerald-50 text-emerald-700', unverified: 'bg-amber-50 text-amber-800', invalid: 'bg-red-50 text-red-700',
  not_applicable: 'bg-zinc-100 text-zinc-500', not_assessed: 'bg-zinc-100 text-zinc-500',
}
const GATE_STYLE: Record<Layer['gate'], string> = {
  credited: 'bg-emerald-600 text-white', pending: 'border border-amber-400 text-amber-800', blocked: 'border border-red-300 text-red-700', none: 'text-zinc-400',
}
const ADEQUACY_STYLE = { adequate: 'bg-emerald-50 text-emerald-700', inadequate: 'bg-red-50 text-red-700', undetermined: 'bg-amber-50 text-amber-800', not_credible: 'bg-zinc-100 text-zinc-500' }
const CHECK_MARK = { pass: '✓', fail: '✗', unknown: '?' }
const CHECK_STYLE = { pass: 'bg-emerald-50 text-emerald-700', fail: 'bg-red-50 text-red-700', unknown: 'bg-amber-50 text-amber-800' }

const stageTitle = (s: Stage | null, label: string) => (s ? `${label}: F-${s.f} · C-${props.e.severity} · ${s.credits} credit(s)` : `${label}: not available`)
const typeLabel = (t: string | null) => (t ? props.rules.ipl_types.find(x => x.id === t)?.label ?? t : 'no IPL type')
const nameOf = (l: Layer) => (l.candidate.function_id && props.labels.get(l.candidate.function_id)) || l.candidate.component_ids.join(' + ') || l.candidate.description
const decision = (item: string) => props.reviews.get(item)?.last
const confirmedIndependent = (a: string, b: string) => props.reviews.get(itemKey.dependency(id.value, a, b))?.change.independent === true
const layersOf = (fid: string) => props.e.layers.filter(l => props.e.functions.find(f => f.function_id === fid)?.candidate_ids.includes(l.candidate.candidate_id))
const withReset = (options: ReviewField['options'], aiLabel: string) => [{ value: null, label: `AI value (${aiLabel})` }, ...options]

function reviewEndpoint() {
  const r = props.e.review
  emit('review', {
    deviation: props.e.deviation, item: itemKey.endpoint(id.value), title: `Endpoint ${id.value}: ${props.e.endpoint.element_id}`,
    actions: ['confirm_assessment', 'revise', 'request_verification'],
    fields: [
      { key: 'severity', label: 'Severity', value: (props.reviews.get(itemKey.endpoint(id.value))?.change.severity as number) ?? null,
        options: withReset(props.rules.consequence_categories.map(c => ({ value: c.c, label: `C-${c.c} · ${c.safety}` })), r ? `C-${r.severity}` : '—') },
      { key: 'credibility', label: 'Credibility', value: (props.reviews.get(itemKey.endpoint(id.value))?.change.credibility as string) ?? null,
        options: withReset(['credible', 'not_credible', 'insufficient_evidence'].map(v => ({ value: v, label: v.replace('_', ' ') })), r?.credibility ?? '—') },
    ],
  })
}

function reviewLayer(l: Layer) {
  const change = props.reviews.get(itemKey.layer(id.value, l.candidate.candidate_id))?.change ?? {}
  const ai = (k: CheckKey) => l.assessment?.[k].result ?? '—'
  emit('review', {
    deviation: props.e.deviation, item: itemKey.layer(id.value, l.candidate.candidate_id), title: `${nameOf(l)} for ${id.value}`,
    actions: ['confirm_assessment', 'revise', 'request_verification'],
    fields: [
      ...CHECKS.map(k => ({ key: k, label: k.replace('_', ' '), value: (change[k] as string) ?? null,
        options: withReset(['pass', 'fail', 'unknown'].map(v => ({ value: v, label: v })), ai(k)) })),
      { key: 'ipl_type', label: 'IPL type (Table B2)', value: (change.ipl_type as string) ?? null,
        options: withReset(props.rules.ipl_types.map(t => ({ value: t.id, label: `${t.label} (${t.credit})` })), typeLabel(l.assessment?.ipl_type ?? null)) },
    ],
  })
}

function reviewIndependence(l: Layer, other: string) {
  const confirmed = confirmedIndependent(l.candidate.candidate_id, other)
  emit('review', {
    deviation: props.e.deviation, item: itemKey.dependency(id.value, l.candidate.candidate_id, other),
    title: confirmed
      ? `Withdraw: ${nameOf(l)} independent of ${other === 'cause' ? 'the initiating cause' : other}`
      : `Confirm ${nameOf(l)} is independent of ${other === 'cause' ? 'the initiating cause' : other} despite shared components`,
    actions: ['revise'], change: { independent: confirmed ? null : true },
  })
}

function reviewAction(actionId: string, description: string) {
  emit('review', {
    deviation: props.e.deviation, item: itemKey.action(actionId), title: description,
    actions: ['accept_for_further_engineering', 'request_verification', 'reject'],
  })
}
</script>

<template>
  <div class="border-t border-zinc-100" :class="open && 'bg-zinc-50'">
    <!-- summary row -->
    <button type="button" :aria-expanded="open" class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-50 md:grid-cols-[minmax(0,1fr)_110px_220px_110px_auto]" @click="emit('toggle')">
      <span class="min-w-0">
        <span class="font-mono text-[11px] text-zinc-400">{{ id }} · {{ e.endpoint.element_id }}</span>
        <span class="block text-sm text-zinc-900">{{ e.review?.hazardous_event || e.endpoint.consequence }}</span>
      </span>
      <span class="hidden text-xs md:block">
        <span class="rounded px-1.5 py-0.5" :class="ADEQUACY_STYLE[e.credibility === 'not_credible' ? 'not_credible' : e.credibility === 'credible' ? 'adequate' : 'undetermined']">
          {{ e.credibility?.replace('_', ' ') ?? 'not reviewed' }}
        </span>
        <span v-if="e.severity" class="ml-1 text-zinc-500">C-{{ e.severity }}</span>
      </span>
      <span class="hidden items-center gap-1 md:flex">
        <template v-for="([k, label], i) in STAGES" :key="k">
          <span v-if="i" class="text-zinc-300">→</span>
          <span class="w-8 rounded py-0.5 text-center text-xs font-semibold" :class="e[k] ? RISK_STYLE[e[k]!.r] : 'bg-zinc-100 text-zinc-300'" :title="stageTitle(e[k], label)">
            {{ e[k] ? ROMAN[e[k]!.r] : '–' }}
          </span>
        </template>
      </span>
      <span class="hidden text-xs md:block"><span class="rounded px-1.5 py-0.5" :class="ADEQUACY_STYLE[e.adequacy]" :title="e.adequacyReason">{{ e.adequacy.replace('_', ' ') }}</span></span>
      <span class="flex items-center gap-1">
        <b v-for="code in [...new Set(e.deficiencies.map(d => d.code))]" :key="code" class="rounded bg-zinc-800 px-1 text-[10px] font-medium text-white">{{ code }}</b>
        <span class="ml-1 text-zinc-500">{{ open ? '▾' : '▸' }}</span>
      </span>
    </button>

    <div v-if="open" class="grid gap-5 px-4 pb-5 lg:grid-cols-3">
      <!-- P2 endpoint review -->
      <section class="space-y-2 rounded-xl bg-white p-4 text-xs leading-relaxed shadow-sm">
        <h4 class="font-semibold uppercase tracking-wider text-zinc-400">Endpoint (P2)</h4>
        <template v-if="e.review">
          <p class="text-sm text-zinc-900">{{ e.review.hazardous_event }}</p>
          <p class="text-zinc-500">{{ e.review.endpoint_type.replace('_', ' ') }} · {{ e.adequacyReason }}</p>
          <p><b class="font-medium">C-{{ e.severity }}.</b> {{ e.review.severity_reason }}</p>
          <p class="text-zinc-600">{{ e.review.physical_basis }}</p>
          <div v-if="e.review.required_evidence.length">
            <p class="text-zinc-400">Evidence needed to confirm</p>
            <ul class="list-disc pl-4 text-zinc-600"><li v-for="r in e.review.required_evidence" :key="r">{{ r }}</li></ul>
          </div>
        </template>
        <p v-else class="text-zinc-500">Not reviewed by P2 yet.</p>
        <p class="text-zinc-500">
          Initiating event: {{ e.initiatingEvent?.label ?? '—' }}<template v-if="e.initiatingEvent?.per_year"> · {{ e.initiatingEvent.per_year }}/yr</template>
        </p>
        <p v-if="decision(itemKey.endpoint(id))" class="text-zinc-500">
          {{ decision(itemKey.endpoint(id))!.action.replaceAll('_', ' ') }} by {{ decision(itemKey.endpoint(id))!.reviewer }}: {{ decision(itemKey.endpoint(id))!.reason }}
        </p>
        <button type="button" class="rounded-md border border-zinc-200 px-2 py-1 text-zinc-600 hover:border-black hover:text-black" @click="reviewEndpoint">Review endpoint…</button>
      </section>

      <!-- P3 functions, P4 layers and gates -->
      <section class="space-y-3 rounded-xl bg-white p-4 text-xs leading-relaxed shadow-sm">
        <h4 class="font-semibold uppercase tracking-wider text-zinc-400">Protection (P3 → P4)</h4>
        <p v-if="!e.protectionReviewed" class="text-zinc-500">Not mapped by P3 yet.</p>
        <div v-for="f in e.functions" :key="f.function_id">
          <p class="text-zinc-500"><b class="font-medium text-zinc-700">{{ f.kind }}</b> · {{ f.description }}</p>
          <p v-if="!f.candidate_ids.length" class="mt-1 rounded bg-red-50 px-2 py-1 text-red-700">No existing safeguard performs this function.</p>
          <div v-for="l in layersOf(f.function_id)" :key="l.candidate.candidate_id" class="mt-2 rounded-lg border border-zinc-100 p-2.5">
            <p class="flex flex-wrap items-center gap-1.5">
              <span class="font-medium text-zinc-900">{{ nameOf(l) }}</span>
              <span class="rounded px-1.5 py-0.5" :class="STATUS_STYLE[l.status]">{{ l.status.replace('_', ' ') }}</span>
              <span class="rounded px-1.5 py-0.5" :class="GATE_STYLE[l.gate]" :title="l.gateReason">
                {{ l.gate === 'none' ? 'no credit' : `${l.gate} −${l.credit}` }}
              </span>
            </p>
            <p class="mt-0.5 text-zinc-500">{{ typeLabel(l.iplType) }} · {{ l.candidate.mechanism }}</p>
            <p v-if="l.gateReason && l.gate !== 'credited'" class="text-zinc-500">{{ l.gateReason }}</p>
            <p v-if="l.checks" class="mt-1.5 flex flex-wrap gap-1">
              <b
                v-for="k in CHECKS" :key="k" class="rounded px-1.5 py-0.5 text-[10px] font-medium" :class="CHECK_STYLE[l.checks[k].result]"
                :title="`${l.checks[k].basis}${l.checks[k].revised ? ' (revised by the engineer)' : ''}`"
              >{{ k.replace('_', ' ') }} {{ CHECK_MARK[l.checks[k].result] }}{{ l.checks[k].revised ? '•' : '' }}</b>
            </p>
            <p v-if="l.status === 'unverified' && l.assessment?.missing_evidence.length" class="mt-1 text-amber-800">Missing: {{ l.assessment.missing_evidence.join('; ') }}</p>
            <p class="mt-1.5 flex flex-wrap gap-1.5">
              <button v-if="l.assessment" type="button" class="rounded-md border border-zinc-200 px-2 py-0.5 text-zinc-600 hover:border-black hover:text-black" @click="reviewLayer(l)">Review layer…</button>
              <button
                v-if="l.causeShared.length || confirmedIndependent(l.candidate.candidate_id, 'cause')" type="button"
                class="rounded-md border border-red-200 px-2 py-0.5 text-red-700 hover:border-red-500" @click="reviewIndependence(l, 'cause')"
              >
                {{ l.causeShared.length ? 'Confirm independent of the cause…' : 'Independence from the cause confirmed · withdraw…' }}
              </button>
              <button
                v-for="s in l.sharedWith" :key="s.id" type="button"
                class="rounded-md border border-red-200 px-2 py-0.5 text-red-700 hover:border-red-500" @click="reviewIndependence(l, s.id)"
              >
                Confirm independent of {{ s.id }}…
              </button>
            </p>
            <p v-if="decision(itemKey.layer(id, l.candidate.candidate_id))" class="mt-1 text-zinc-500">
              {{ decision(itemKey.layer(id, l.candidate.candidate_id))!.action.replaceAll('_', ' ') }} by {{ decision(itemKey.layer(id, l.candidate.candidate_id))!.reviewer }}
            </p>
          </div>
        </div>
      </section>

      <!-- D1–D7 and P6 proposals -->
      <section class="space-y-3 rounded-xl bg-white p-4 text-xs leading-relaxed shadow-sm">
        <h4 class="font-semibold uppercase tracking-wider text-zinc-400">Deficiencies (code)</h4>
        <p v-if="!e.deficiencies.length" class="text-zinc-500">None found.</p>
        <p v-for="d in e.deficiencies" :key="d.id">
          <b class="mr-1 rounded bg-zinc-800 px-1 text-[10px] font-medium text-white">{{ d.code }}</b>
          <b class="font-medium">{{ d.title }}</b><span v-if="d.refs.length" class="font-mono text-zinc-400"> {{ d.refs.join(', ') }}</span>
          <span v-if="d.detail" class="block text-zinc-600">{{ d.detail }}</span>
        </p>

        <h4 class="pt-2 font-semibold uppercase tracking-wider text-zinc-400">Proposed actions (P6, not installed)</h4>
        <p v-if="!e.actions.length" class="text-zinc-500">None yet. Run “Recommend actions” for this deviation.</p>
        <details v-for="a in e.actions" :key="a.action.action_id" class="rounded-lg border border-zinc-100 p-2.5" :class="a.status === 'rejected' && 'opacity-50'">
          <summary class="cursor-pointer">
            <span class="font-medium text-zinc-900">{{ a.action.description }}</span>
            <span class="mt-0.5 block text-zinc-500">
              {{ a.action.strategy.replaceAll('_', ' ') }} · {{ typeLabel(a.action.ipl_type) }} · {{ a.status.replaceAll('_', ' ') }}
              · <span :class="a.counted ? 'text-emerald-700' : 'text-zinc-400'">{{ a.counted ? `in R2 −${a.credit}` : a.note || 'not in R2' }}</span>
            </span>
          </summary>
          <div class="mt-2 space-y-1.5 text-zinc-700">
            <p><b class="font-medium">Why.</b> {{ a.action.reasoning }}</p>
            <p><b class="font-medium">Protects.</b> {{ a.action.process_benefit }}</p>
            <p><b class="font-medium">Mechanism.</b> {{ a.action.expected_mechanism }} ({{ a.action.effect_on.replace('_', ' ') }})</p>
            <p v-if="a.action.new_tags.length"><b class="font-medium">New.</b> {{ a.action.new_tags.join(', ') }}</p>
            <p v-if="a.action.existing_ids.length"><b class="font-medium">Uses / modifies.</b> <span class="font-mono">{{ a.action.existing_ids.join(', ') }}</span></p>
            <p v-if="a.action.possible_dependencies.length"><b class="font-medium">Dependencies.</b> {{ a.action.possible_dependencies.join('; ') }}</p>
            <div v-if="a.action.verification_requirements.length">
              <b class="font-medium">Verify before any credit</b>
              <ul class="list-disc pl-4"><li v-for="v in a.action.verification_requirements" :key="v">{{ v }}</li></ul>
            </div>
            <p class="font-mono text-zinc-400">Targets {{ a.action.target_deficiency_ids.join(', ') }}</p>
            <p v-if="decision(itemKey.action(a.action.action_id))" class="text-zinc-500">
              {{ a.status.replaceAll('_', ' ') }} by {{ decision(itemKey.action(a.action.action_id))!.reviewer }}: {{ decision(itemKey.action(a.action.action_id))!.reason }}
            </p>
            <button type="button" class="rounded-md border border-zinc-200 px-2 py-0.5 text-zinc-600 hover:border-black hover:text-black" @click="reviewAction(a.action.action_id, a.action.description)">
              Decide…
            </button>
          </div>
        </details>
        <p class="text-[11px] text-zinc-400">“Accepted for further engineering” is not approval to build.</p>
      </section>
    </div>
  </div>
</template>
