<script setup lang="ts">
import {
  BLUE, causeDeviations, KIND_COLOR, KIND_LABEL, neighborsOf, pidReasoningFor, RED, safeguardEntries,
  type CaseData, type GNode, type Graph, type Resolver, type Scenario,
} from '~/utils/supernode'

const props = defineProps<{
  node: GNode; data: CaseData; graph: Graph; resolve: Resolver
  deviation: string; scene: Scenario | null
}>()
const withSafeguards = defineModel<boolean>('withSafeguards', { required: true })
const emit = defineEmits<{ select: [id: string]; deviation: [name: string]; close: [] }>()

const SUBTITLE_KEYS = ['name', 'function', 'node', 'utility_type']
const record = computed(() => ({
  ...props.node.record,
  ...(props.node.kind === 'supernode' && {
    process_description: props.data.pid.process_description,
    intention: props.data.pid.intention,
  }),
}))
const subtitleKey = computed(() => SUBTITLE_KEYS.find(k => typeof record.value[k as keyof typeof record.value] === 'string'))
const entries = computed(() => Object.entries(record.value).filter(([k]) => k !== 'id' && k !== 'line_id' && k !== subtitleKey.value))
const fields = computed(() => entries.value.filter((e): e is [string, string] => typeof e[1] === 'string'))
const lists = computed(() => entries.value.filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every(x => typeof x === 'string')))

const lines = computed(() => neighborsOf(props.graph, props.node.id, 'line'))
const pidReasoning = computed(() => pidReasoningFor(props.data.pid, props.node.id))
const pos = computed(() => props.data.pos)
const otherDeviations = computed(() => pos.value ? causeDeviations(pos.value, props.resolve, props.node.id).filter(d => d !== props.deviation) : [])
const asSafeguard = computed(() => pos.value ? safeguardEntries(pos.value, props.resolve, props.node.id) : [])
const isTarget = computed(() => props.scene?.targets.includes(props.node.id) ?? false)

const human = (k: string) => k.replace(/_/g, ' ')
const colorOf = (id: string) => { const kind = props.graph.byId.get(id)?.kind; return kind ? KIND_COLOR[kind] : 'transparent' }
const lineEnds = (n: GNode) => `${n.record?.from_id} → ${n.record?.to_id}`
</script>

<template>
  <article class="p-5">
    <header class="flex flex-wrap items-start gap-x-3 gap-y-2">
      <span class="mt-2 size-3.5 shrink-0 rounded-full bg-[#22c55e]" />
      <div class="min-w-40 flex-1">
        <h3 class="break-words text-xl font-medium tracking-tight">{{ node.id }}</h3>
        <p class="flex items-center gap-1.5 text-sm text-zinc-500">
          <i class="size-2 shrink-0 rounded-full" :style="{ background: KIND_COLOR[node.kind] }" />
          <span>{{ KIND_LABEL[node.kind] }}<template v-if="subtitleKey"> · {{ record[subtitleKey as keyof typeof record] }}</template></span>
        </p>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <!-- which json-pos section animates: red only, or red + blue safeguards -->
        <div v-if="pos" role="radiogroup" aria-label="Animation layers" class="flex rounded-full bg-zinc-100 p-0.5 text-[11px]">
          <button
            type="button" role="radio" :aria-checked="!withSafeguards" class="flex items-center gap-1 rounded-full px-2 py-1"
            :class="withSafeguards ? 'text-zinc-500' : 'bg-white text-black shadow-sm'" @click="withSafeguards = false"
          >
            <i class="size-1.5 rounded-full" :style="{ background: RED }" />No safeguards
          </button>
          <button
            type="button" role="radio" :aria-checked="withSafeguards" class="flex items-center gap-1 rounded-full px-2 py-1"
            :class="withSafeguards ? 'bg-white text-black shadow-sm' : 'text-zinc-500'" @click="withSafeguards = true"
          >
            <i class="size-1.5 rounded-full" :style="{ background: BLUE }" />IPLs &amp; safeguards
          </button>
        </div>
        <button type="button" aria-label="Close" class="text-zinc-400 hover:text-black" @click="emit('close')">✕</button>
      </div>
    </header>

    <div class="mt-5 grid gap-8">
      <!-- json-pid -->
      <section class="min-w-0">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">P&amp;ID · json-pid</h4>
        <dl class="mt-3 space-y-3 text-sm">
          <div v-for="[k, v] in fields" :key="k">
            <dt class="text-xs capitalize text-zinc-400">{{ human(k) }}</dt>
            <dd class="leading-relaxed text-zinc-800">{{ v }}</dd>
          </div>
        </dl>
        <div v-for="[k, ids] in lists" :key="k" class="mt-3">
          <p class="text-xs capitalize text-zinc-400">{{ human(k) }}</p>
          <div class="mt-1 flex flex-wrap gap-1.5">
            <button
              v-for="t in ids" :key="t" type="button" :disabled="!graph.byId.has(t)"
              class="flex items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs enabled:hover:bg-zinc-200"
              @click="emit('select', t)"
            >
              <i class="size-1.5 rounded-full" :style="{ background: colorOf(t) }" />{{ t }}
            </button>
          </div>
        </div>
        <div v-if="lines.length" class="mt-3">
          <p class="text-xs text-zinc-400">Lines</p>
          <ul class="mt-1 space-y-1 text-xs">
            <li v-for="l in lines" :key="l.id">
              <button type="button" class="rounded-md bg-zinc-100 px-2 py-0.5 font-mono hover:bg-zinc-200" :title="l.id" @click="emit('select', l.id)">{{ l.label }}</button>
              <span class="ml-2 text-zinc-500">{{ lineEnds(l) }}</span>
            </li>
          </ul>
        </div>
        <div v-for="r in pidReasoning" :key="r.deviation" class="mt-4 rounded-lg border border-zinc-100 p-3 text-sm">
          <p class="font-medium">{{ r.deviation }} <span class="font-normal text-zinc-500">· {{ r.cause_source.cause_type }}</span></p>
          <p class="mt-1 text-zinc-600">{{ r.cause_source.cause_context }}</p>
          <ol class="mt-2 space-y-1 text-zinc-700">
            <li v-for="s in r.propagation_path" :key="s.step"><span class="text-red-600">{{ s.step }}.</span> {{ s.affected_section }} — {{ s.effect }}</li>
          </ol>
        </div>
      </section>

      <!-- json-pos -->
      <section class="min-w-0">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Cause → consequence · {{ deviation || 'json-pos' }}</h4>
        <p v-if="!pos" class="mt-3 text-sm text-zinc-500">No json-pos file for this case.</p>
        <template v-else-if="scene">
          <ul v-if="node.kind === 'supernode'" class="mt-3 space-y-3 text-sm">
            <li v-for="c in scene.deviation.possible_causes" :key="c.cause_id">
              <p><span class="font-mono text-xs text-red-600">{{ c.cause_id }}</span> <span class="text-zinc-500">· {{ c.cause_source }}</span></p>
              <p class="text-zinc-800">{{ c.cause }}</p>
            </li>
          </ul>
          <template v-else-if="scene.causes.length">
            <div v-for="c in scene.causes" :key="c.cause_id" class="mt-3 space-y-1 text-sm">
              <p><span class="font-mono text-xs text-red-600">{{ c.cause_id }}</span> {{ c.cause }}</p>
              <p class="text-zinc-600"><span class="text-zinc-400">Local effect:</span> {{ c.local_effect }}</p>
              <p class="text-zinc-600"><span class="text-zinc-400">Propagated:</span> {{ c.propagated_consequence }}</p>
            </div>
            <p class="mt-3 text-xs text-zinc-400">Consequence targets</p>
            <div class="mt-1 flex flex-wrap gap-1.5 text-xs">
              <button v-for="t in scene.targets" :key="t" type="button" class="rounded-md bg-red-50 px-2 py-0.5 text-red-700 hover:bg-red-100" @click="emit('select', t)">{{ t }}</button>
              <span v-for="t in scene.unresolvedTargets" :key="t" class="rounded-md bg-zinc-100 px-2 py-0.5 text-zinc-500">{{ t }}</span>
            </div>
          </template>
          <p v-else class="mt-3 text-sm text-zinc-500">Not a cause source in this deviation.</p>
          <p v-if="isTarget" class="mt-3 text-sm text-red-700">Listed as a consequence target in this deviation.</p>
        </template>

        <div v-if="otherDeviations.length" class="mt-4">
          <p class="text-xs text-zinc-400">Also a cause source in</p>
          <div class="mt-1 flex flex-wrap gap-1.5">
            <button v-for="d in otherDeviations" :key="d" type="button" class="rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs hover:border-black" @click="emit('deviation', d)">{{ d }}</button>
          </div>
        </div>

        <template v-if="withSafeguards && scene?.safeguards.length">
          <h4 class="mt-6 text-xs font-semibold uppercase tracking-wider text-zinc-400">IPLs &amp; safeguards</h4>
          <ul class="mt-2 space-y-2 text-sm">
            <li v-for="s in scene.safeguards" :key="s.tag">
              <span class="font-mono text-xs text-blue-700">{{ s.tag }}</span> <span class="text-zinc-500">· {{ s.type }}</span>
              <p class="text-zinc-700">{{ s.related_cause_consequence_logic }}</p>
            </li>
          </ul>
        </template>

        <div v-for="s in asSafeguard" :key="s.tag" class="mt-6 rounded-lg border border-blue-100 p-3 text-sm">
          <p class="text-xs font-semibold uppercase tracking-wider text-blue-700">As a safeguard · {{ s.type }}</p>
          <p class="mt-1 text-zinc-800">{{ s.related_cause_consequence_logic }}</p>
          <p class="mt-1 text-zinc-500">{{ s.classification_note }}</p>
          <p class="mt-1 text-xs text-zinc-400">Deviations: {{ s.related_deviations.join(', ') }}</p>
        </div>
      </section>
    </div>
  </article>
</template>
