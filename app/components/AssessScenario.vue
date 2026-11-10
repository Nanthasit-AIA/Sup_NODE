<script setup lang="ts">
import { itemKey, stepPath, type EndpointEval, type ReviewRequest, type ReviewState } from '~/utils/assess'
import type { Rules } from '~/utils/lopa'
import type { SafetyLayer } from '~/utils/safety'
import type { Graph, PosCause } from '~/utils/supernode'

const props = defineProps<{
  cause: PosCause; evals: EndpointEval[]; graph: Graph; safety: SafetyLayer | null; rules: Rules
  reviews: Map<string, ReviewState>; labels: Map<string, string>; openId: string | null
}>()
const emit = defineEmits<{ toggle: [id: string]; review: [request: ReviewRequest] }>()

const first = computed(() => props.evals[0]!)
const s = computed(() => first.value.scenario)
const sr = computed(() => first.value.scenarioReview)
const paths = computed(() => s.value.propagation_steps.map(step => stepPath(props.graph, props.safety, step)))
const unsupported = (n: number) => sr.value?.unsupported_steps.find(u => u.step === n)
const decision = computed(() => props.reviews.get(itemKey.scenario(s.value.cause_id))?.last)
const CRED_STYLE = { credible: 'bg-emerald-50 text-emerald-700', not_credible: 'bg-zinc-100 text-zinc-500', insufficient_evidence: 'bg-amber-50 text-amber-800' }

function reviewScenario() {
  const change = props.reviews.get(itemKey.scenario(s.value.cause_id))?.change ?? {}
  const ie = props.rules.initiating_events.find(e => e.id === s.value.initiating_event_class)
  emit('review', {
    deviation: first.value.deviation, item: itemKey.scenario(s.value.cause_id), title: `${s.value.cause_id}: ${props.cause.cause}`,
    actions: ['confirm_assessment', 'revise', 'request_verification'],
    fields: [
      { key: 'initiating_event_class', label: 'Initiating event (Table B1)', value: (change.initiating_event_class as string) ?? null,
        options: [{ value: null, label: `AI value (${ie?.label ?? s.value.initiating_event_class})` },
          ...props.rules.initiating_events.map(e => ({ value: e.id, label: `${e.label}${e.per_year ? ` · ${e.per_year}/yr` : ''}` }))] },
      { key: 'scenario_credibility', label: 'Scenario credibility', value: (change.scenario_credibility as string) ?? null,
        options: [{ value: null, label: `AI value (${sr.value?.scenario_credibility.replace('_', ' ') ?? '—'})` },
          ...['credible', 'not_credible', 'insufficient_evidence'].map(v => ({ value: v, label: v.replace('_', ' ') }))] },
    ],
  })
}
</script>

<template>
  <article class="border-t border-zinc-200">
    <header class="grid gap-4 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div class="space-y-1.5 text-sm">
        <p class="font-mono text-[11px] text-zinc-400">{{ s.cause_id }} · {{ s.source_type.replaceAll('_', ' ') }}</p>
        <p class="text-zinc-900">{{ cause.cause }}</p>
        <p class="flex flex-wrap gap-1">
          <span v-for="c in s.cause_source_ids" :key="c" class="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px]">{{ c }}</span>
        </p>
        <p class="text-xs text-zinc-600">
          <b class="font-medium">Initiating event.</b> {{ s.initiating_event }} — {{ first.initiatingEvent?.label ?? s.initiating_event_class }}<template v-if="first.initiatingEvent?.per_year">, {{ first.initiatingEvent.per_year }}/yr</template>.
          <span class="text-zinc-500">{{ s.initiating_event_reason }}</span>
        </p>
        <p v-if="sr" class="text-xs text-zinc-600">
          <span class="mr-1 rounded px-1.5 py-0.5" :class="CRED_STYLE[sr.scenario_credibility]">{{ sr.scenario_credibility.replace('_', ' ') }}</span>{{ sr.credibility_reason }}
        </p>
        <p v-if="decision" class="text-xs text-zinc-500">{{ decision.action.replaceAll('_', ' ') }} by {{ decision.reviewer }}: {{ decision.reason }}</p>
        <button type="button" class="rounded-md border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:border-black hover:text-black" @click="reviewScenario">
          Review scenario…
        </button>
      </div>

      <!-- forward trace: every step is checked against the graph; P2 flags steps it does not accept -->
      <ol class="space-y-1 text-xs leading-relaxed">
        <li class="text-zinc-500"><b class="font-medium text-zinc-700">Local effect.</b> {{ s.local_effect }}</li>
        <li v-for="(step, i) in s.propagation_steps" :key="step.step" class="flex gap-2">
          <span class="w-4 shrink-0 text-right text-zinc-400">{{ step.step }}</span>
          <span class="min-w-0">
            <span class="font-mono text-[11px]">{{ step.from_id }} → {{ step.to_id }}</span>
            <span
              class="ml-1.5 rounded px-1 text-[10px]" :class="paths[i] ? 'bg-zinc-100 text-zinc-500' : 'bg-amber-50 text-amber-800'"
              :title="paths[i] ? `Graph path: ${paths[i]!.join(' → ')}` : 'No documented link in the graph between these elements'"
            >{{ paths[i] ? `path ${paths[i]!.length - 1} hop${paths[i]!.length === 2 ? '' : 's'}` : 'no graph path' }}</span>
            <span class="block text-zinc-600">{{ step.mechanism }}: {{ step.effect }}</span>
            <span v-if="unsupported(step.step)" class="block text-red-700">P2: {{ unsupported(step.step)!.reason }}</span>
          </span>
        </li>
      </ol>
    </header>

    <AssessEndpoint
      v-for="e in evals" :key="e.endpoint.endpoint_id" :e="e" :rules="rules" :reviews="reviews" :labels="labels"
      :open="openId === e.endpoint.endpoint_id" @toggle="emit('toggle', e.endpoint.endpoint_id)" @review="emit('review', $event)"
    />
  </article>
</template>
