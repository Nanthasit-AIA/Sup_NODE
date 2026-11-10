<script setup lang="ts">
import { graphAliases } from '~/utils/safety'
import { buildGraph, buildScenario, makeResolver, type CaseData, type Trace } from '~/utils/supernode'

const id = String(useRoute().params.id)
const { data, error } = await useFetch<CaseData>(`/api/case/${id}`)

const graph = computed(() => data.value ? buildGraph(data.value.pid, data.value.safety) : null)
const resolve = computed(() => graph.value ? makeResolver(graph.value.nodes, graphAliases(data.value?.safety)) : null)
const deviations = computed(() => data.value?.pos?.cause_consequence_analysis_no_safeguards.map(d => d.deviation) ?? [])
const deviation = ref('')
watch(deviations, (d) => {
  if (!d.includes(deviation.value)) deviation.value = d[0] ?? ''
}, { immediate: true })

const deviationOpen = ref(false)
function onDeviationBlur(e: FocusEvent) {
  if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) deviationOpen.value = false
}

const withSafeguards = ref(false)
const selectedId = ref<string | null>(null)
const selected = computed(() => (selectedId.value && graph.value?.byId.get(selectedId.value)) || null)

const scene = computed(() => {
  const pos = data.value?.pos
  if (!graph.value || !resolve.value || !pos || !selectedId.value) return null
  return buildScenario(graph.value, resolve.value, pos, deviation.value, selectedId.value, withSafeguards.value)
})
const EMPTY: Trace = { nodes: new Set(), links: [] }
const red = computed(() => scene.value?.red ?? EMPTY)
const blue = computed(() => scene.value?.blue ?? EMPTY)

useHead({ title: () => data.value ? `${data.value.id} · ${data.value.name} — Super NODE` : 'Super NODE' })
</script>

<template>
  <main class="min-h-screen bg-white">
    <div class="mx-auto max-w-7xl px-4 py-8 md:px-8">
      <AppHeader />

      <p v-if="error" class="mt-10 rounded-xl bg-red-50 p-6 text-red-700">
        Could not load case {{ id }} ({{ error.statusCode }}). <NuxtLink to="/" class="underline">Back to search</NuxtLink>
      </p>

      <template v-else-if="data && graph && resolve">
        <div class="mt-6 flex flex-wrap items-center gap-3">
          <span class="size-4 rounded-full bg-[#22c55e]" />
          <h2 class="text-2xl font-medium capitalize tracking-tight">{{ data.name }}</h2>
          <span class="font-mono text-sm text-zinc-400">#{{ data.id }}</span>
          <NuxtLink to="/" class="text-sm text-zinc-500 hover:text-black">← search</NuxtLink>
          <NuxtLink v-if="data.pos" :to="`/lopa/${data.id}`" class="ml-auto text-sm text-zinc-500 hover:text-black">
            Baseline IPL review
          </NuxtLink>
          <NuxtLink v-if="data.pos" :to="`/assess/${data.id}`" class="rounded-lg bg-black px-4 py-2 text-sm text-white hover:bg-zinc-800">
            Safety assessment →
          </NuxtLink>
        </div>

        <section class="mt-3 grid grid-cols-1 gap-3 rounded-2xl bg-[#ececec] p-3 md:p-4 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div class="relative h-[70vh] min-h-[460px]">
            <GraphView :graph="graph" :red="red" :blue="blue" :selected-id="selectedId" @select="selectedId = $event" />

            <!-- one button that expands into the deviation list -->
            <div v-if="deviations.length" class="absolute left-3 top-3" @focusout="onDeviationBlur" @keydown.esc="deviationOpen = false">
              <button
                type="button" :aria-expanded="deviationOpen"
                class="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm shadow-sm hover:bg-zinc-50"
                @click="deviationOpen = !deviationOpen"
              >
                <span class="text-xs text-zinc-400">Deviation</span>
                <span class="font-medium">{{ deviation }}</span>
                <span class="text-zinc-400 transition-transform" :class="deviationOpen && 'rotate-180'">▾</span>
              </button>
              <ul v-if="deviationOpen" class="mt-1 w-64 rounded-lg bg-white py-1 text-sm shadow-lg">
                <li v-for="d in deviations" :key="d">
                  <button
                    type="button" :aria-current="d === deviation"
                    class="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-zinc-100"
                    @click="deviation = d; deviationOpen = false"
                  >
                    {{ d }}<span v-if="d === deviation">✓</span>
                  </button>
                </li>
              </ul>
            </div>
          </div>

          <aside class="rounded-xl bg-white lg:h-[70vh] lg:min-h-[460px] lg:overflow-y-auto">
            <NodeDetail
              v-if="selected" v-model:with-safeguards="withSafeguards"
              :node="selected" :data="data" :graph="graph" :resolve="resolve" :deviation="deviation" :scene="scene"
              @select="selectedId = $event" @deviation="deviation = $event" @close="selectedId = null"
            />
            <p v-else class="p-6 text-sm leading-relaxed text-zinc-500">
              Pick a deviation (top-left), then click a node in the graph to see its P&amp;ID data and how a cause there
              propagates along the flow.
            </p>
          </aside>
        </section>
      </template>
    </div>
  </main>
</template>
