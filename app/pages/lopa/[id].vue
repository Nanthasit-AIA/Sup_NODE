<script setup lang="ts">
import { evaluate, referenceMismatch, RISK_STYLE, summarize, type Edit, type LopaData } from '~/utils/lopa'
import type { CaseData } from '~/utils/supernode'

const id = String(useRoute().params.id)
const [{ data: caseData, error }, { data: lopa, refresh }] = await Promise.all([
  useFetch<CaseData>(`/api/case/${id}`),
  useFetch<LopaData>(`/api/lopa/${id}`),
])

const edits = ref<Record<string, Edit>>({}) // engineer overrides, keyed by cause_id
const openId = ref<string | null>(null)
const STAGES = [
  { key: 'unmitigated', label: 'Before IPLs' },
  { key: 'current', label: 'Existing IPLs' },
  { key: 'improved', label: '+ AI proposals' },
] as const
const stage = ref<(typeof STAGES)[number]['key']>('current')

const groups = computed(() => {
  const pos = caseData.value?.pos
  const l = lopa.value
  if (!pos || !l) return []
  return pos.cause_consequence_analysis_no_safeguards.map((dev) => {
    const review = l.review.deviations[dev.deviation]
    return {
      name: dev.deviation,
      review,
      running: l.running.includes(dev.deviation),
      error: l.errors[dev.deviation],
      rows: dev.possible_causes.map((cause) => {
        const r = review?.causes.find(c => c.cause_id === cause.cause_id)
        return {
          cause,
          review: r,
          ev: r ? evaluate(l.rules, r, edits.value[cause.cause_id]) : null,
          reference: (r?.reference_row && l.reference.find(x => x.id === r.reference_row)) || null,
        }
      }),
    }
  })
})
const rows = computed(() => groups.value.flatMap(g => g.rows))
const evaluated = computed(() => rows.value.flatMap(r => (r.ev ? [r.ev] : [])))
const summary = computed(() => summarize(evaluated.value))
const points = computed(() => evaluated.value.flatMap(e => (e[stage.value] ? [{ f: e[stage.value]!.f, s: e.severity }] : [])))
const marks = computed(() => {
  const ev = rows.value.find(r => r.cause.cause_id === openId.value)?.ev
  if (!ev?.unmitigated) return []
  return [['B', ev.unmitigated], ['N', ev.current], ['AI', ev.improved]].map(([label, s]) => ({ label: label as string, f: (s as { f: number }).f, s: ev.severity }))
})
const inconsistent = computed(() => (lopa.value ? lopa.value.reference.flatMap(r => (referenceMismatch(lopa.value!.rules, r) ? [r] : [])) : []))
const notReviewed = computed(() => groups.value.filter(g => !g.review && !g.running).map(g => g.name))
const running = computed(() => lopa.value?.running ?? [])

const verdicts = computed(() => {
  const s = summary.value
  return [
    {
      q: 'Is the protection good?',
      ok: s.gapsCurrent === 0,
      detail: `${s.credible - s.gapsCurrent} of ${s.credible} credible scenarios reach risk III/IV with existing IPLs.`,
    },
    {
      q: 'Is it complete?',
      ok: s.unprotected === 0,
      detail: `${s.unprotected} scenarios that need protection have no valid IPL. Across all scenarios the AI declined ${s.rejectedSafeguards} safeguard credits as not independent, effective or auditable for that scenario.`,
    },
    {
      q: 'Is the improvement enough?',
      ok: s.gapsImproved === 0,
      detail: `${s.proposals} AI-proposed IPLs take risk I/II gaps from ${s.gapsCurrent} to ${s.gapsImproved}.`,
    },
  ]
})

async function run(deviations: string[]) {
  await $fetch(`/api/lopa/${id}/run`, { method: 'POST', body: { deviations } })
  await refresh()
}

// AI reviews run as background jobs on the backend: poll while any is running.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  watch(() => running.value.length, (n) => {
    clearInterval(timer)
    timer = n ? setInterval(refresh, 4000) : undefined
  }, { immediate: true })
})
onBeforeUnmount(() => clearInterval(timer))

useHead({ title: () => (caseData.value ? `${caseData.value.id} · Backward IPL review — Super NODE` : 'Super NODE') })
</script>

<template>
  <main class="min-h-screen bg-white">
    <div class="mx-auto max-w-7xl px-4 py-8 md:px-8">
      <AppHeader />

      <p v-if="error" class="mt-10 rounded-xl bg-red-50 p-6 text-red-700">
        Could not load case {{ id }} ({{ error.statusCode }}). <NuxtLink to="/" class="underline">Back to search</NuxtLink>
      </p>

      <template v-else-if="caseData && lopa">
        <div class="mt-6 flex flex-wrap items-center gap-3">
          <span class="size-4 rounded-full bg-[#22c55e]" />
          <h2 class="text-2xl font-medium tracking-tight">Backward IPL review</h2>
          <span class="capitalize text-zinc-500">{{ caseData.name }} <span class="font-mono text-sm text-zinc-400">#{{ id }}</span></span>
          <NuxtLink :to="`/case/${id}`" class="text-sm text-zinc-500 hover:text-black">← 3D graph</NuxtLink>
          <div class="ml-auto flex items-center gap-2 text-sm">
            <span class="rounded-full bg-zinc-100 px-3 py-1 font-mono text-xs text-zinc-600">AI · {{ lopa.model }}</span>
            <button
              v-if="notReviewed.length" type="button" class="rounded-lg bg-black px-4 py-2 text-white disabled:opacity-50"
              @click="run(notReviewed)"
            >
              Run AI review · {{ notReviewed.length }} deviation{{ notReviewed.length > 1 ? 's' : '' }}
            </button>
          </div>
        </div>

        <p v-if="running.length" class="mt-3 flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm text-zinc-600">
          <span class="size-3 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
          AI reviewing {{ running.join(', ') }} — about 2–3 min each, up to 3 at a time. Results appear as they finish.
        </p>

        <!-- the three backward questions -->
        <section class="mt-6 grid gap-3 md:grid-cols-3">
          <div v-for="v in verdicts" :key="v.q" class="rounded-xl border p-4" :class="v.ok ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'">
            <p class="text-sm text-zinc-600">{{ v.q }}</p>
            <p class="mt-1 text-2xl font-medium" :class="v.ok ? 'text-emerald-700' : 'text-amber-700'">{{ v.ok ? 'Yes' : 'Not yet' }}</p>
            <p class="mt-1 text-xs leading-relaxed text-zinc-600">{{ v.detail }}</p>
          </div>
        </section>
        <p class="mt-2 text-xs text-zinc-400">
          {{ summary.reviewed }} of {{ rows.length }} causes reviewed · {{ summary.screened }} screened out as not credible ·
          AI judgement only: every S, initiating event and IPL credit must be confirmed by the HAZOP team.
        </p>

        <section class="mt-6 grid gap-6 rounded-2xl bg-[#ececec] p-4 lg:grid-cols-[minmax(0,420px)_1fr]">
          <div class="rounded-xl bg-white p-4">
            <div class="mb-3 flex rounded-full bg-zinc-100 p-0.5 text-xs">
              <button
                v-for="s in STAGES" :key="s.key" type="button" class="flex-1 rounded-full px-2 py-1"
                :class="stage === s.key ? 'bg-white text-black shadow-sm' : 'text-zinc-500'" @click="stage = s.key"
              >
                {{ s.label }}
              </button>
            </div>
            <RiskMatrix :rules="lopa.rules" :points="points" :marks="marks" />
            <p class="mt-2 text-[11px] text-zinc-500">
              Numbers = scenarios per cell. Open a row to see its path: <b>B</b> before IPLs, <b>N</b> now, <b>AI</b> with proposals.
            </p>
          </div>
          <div class="space-y-3 rounded-xl bg-white p-4 text-sm">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">How the numbers are made</h3>
            <p class="leading-relaxed text-zinc-600">
              The AI judges each cause backward from its consequence: severity (C-1..C-5), the initiating event (Table B1), whether each
              safeguard is <b>independent, effective and auditable</b>, and which IPLs (Table B2) are missing. Credits and risk ranks are not
              AI output: frequency × 0.1<sup>credits</sup> gives F-1..F-5, and the company matrix gives I–IV. Target: III or IV.
            </p>
            <ul class="space-y-1 text-xs">
              <li v-for="r in lopa.rules.risk_ranks" :key="r.r" class="flex items-center gap-2">
                <span class="w-8 rounded py-0.5 text-center font-semibold" :class="RISK_STYLE[r.r]">{{ r.label }}</span>
                <span><b class="font-medium">{{ r.name }}</b> — {{ r.action }}</span>
              </li>
            </ul>
            <p v-if="inconsistent.length" class="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
              ⚠ Engineer worksheet check: {{ inconsistent.map(r => `${r.id} (${referenceMismatch(lopa!.rules, r)})`).join('; ') }}
            </p>
          </div>
        </section>

        <!-- worksheet -->
        <section v-for="g in groups" :key="g.name" class="mt-6 overflow-x-auto rounded-xl border border-zinc-200">
          <div class="flex flex-wrap items-center gap-3 bg-zinc-50 px-4 py-2.5">
            <h3 class="font-medium">{{ g.name }}</h3>
            <span v-if="g.running" class="text-xs text-zinc-500">AI reviewing…</span>
            <span v-else-if="g.review" class="text-xs text-zinc-400">{{ g.review.model }} · {{ g.review.seconds }} s</span>
            <span v-if="g.error" class="text-xs text-red-600">Failed: {{ g.error }}</span>
            <button
              v-if="!g.running" type="button" class="ml-auto rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 hover:text-black"
              @click="run([g.name])"
            >
              {{ g.review ? 'Re-run AI' : 'Run AI' }}
            </button>
          </div>
          <table class="w-full min-w-[1100px] text-left text-sm">
            <thead class="text-[11px] uppercase tracking-wider text-zinc-400">
              <tr>
                <th class="py-2 pl-4 pr-3 font-medium">Cause</th>
                <th class="px-3 py-2 font-medium">Consequence (no safeguards)</th>
                <th class="px-3 py-2 text-center font-medium">Before</th>
                <th class="px-3 py-2 font-medium">Existing IPLs</th>
                <th class="px-3 py-2 text-center font-medium">Now</th>
                <th class="px-3 py-2 font-medium">AI adds</th>
                <th class="px-3 py-2 text-center font-medium">After</th>
                <th class="px-3 py-2 font-medium">Engineer</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <LopaRow
                v-for="r in g.rows" :key="r.cause.cause_id"
                :cause="r.cause" :review="r.review" :ev="r.ev" :reference="r.reference" :rules="lopa.rules"
                :edit="edits[r.cause.cause_id]" :open="openId === r.cause.cause_id"
                @toggle="openId = openId === r.cause.cause_id ? null : r.cause.cause_id"
                @edit="(e) => { if (e) edits[r.cause.cause_id] = e; else delete edits[r.cause.cause_id] }"
              />
            </tbody>
          </table>
        </section>
      </template>
    </div>
  </main>
</template>
