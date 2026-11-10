<script setup lang="ts">
import {
  deficiencyPayload, DEFICIENCY_TITLE, evaluateDeviation, foldReviews, proposedOverlay, REVIEW_ACTION_LABEL, summarizeAssessment,
  type AssessData, type DeficiencyCode, type ReviewRequest, type Versions,
} from '~/utils/assess'
import { RISK_STYLE } from '~/utils/lopa'
import { FINDING_LABEL, graphAliases, missingEvidence, reconcile, type FindingKind } from '~/utils/safety'
import { buildGraph, makeResolver, type CaseData } from '~/utils/supernode'

const id = String(useRoute().params.id)
const [{ data: caseData, error }, { data, refresh }] = await Promise.all([
  useFetch<CaseData>(`/api/case/${id}`),
  useFetch<AssessData>(`/api/assess/${id}`),
])

const graph = computed(() => (caseData.value ? buildGraph(caseData.value.pid, caseData.value.safety) : null))
const reviews = computed(() => foldReviews(data.value?.reviews ?? []))
const labels = computed(() => new Map(data.value?.safety?.safety_functions.map(f => [f.id, f.label])))
const sameVersions = (a: Versions, b: Versions) => a.source_version === b.source_version && a.prompt_version === b.prompt_version && a.rules_version === b.rules_version

const groups = computed(() => {
  const pos = caseData.value?.pos
  const d = data.value
  if (!pos || !d) return []
  return pos.cause_consequence_analysis_no_safeguards.map((dev) => {
    const analysis = d.assessment.deviations[dev.deviation]
    const evals = analysis ? evaluateDeviation(d.rules, d.safety, analysis, reviews.value) : []
    const payload = analysis?.status === 'complete' ? deficiencyPayload(evals) : []
    const rec = analysis?.recommendations
    const stages = analysis ? Object.values(analysis.stages) : []
    return {
      name: dev.deviation, analysis, evals, payload, rec,
      byCause: dev.possible_causes.map(cause => ({ cause, evals: evals.filter(e => e.scenario.cause_id === cause.cause_id) })).filter(x => x.evals.length),
      running: d.running[dev.deviation], error: d.errors[dev.deviation],
      stale: !!analysis && !sameVersions(analysis.versions, d.versions),
      recStale: !!rec && (rec.deficiency_ids.length !== payload.length || payload.some(p => !rec.deficiency_ids.includes(p.id))),
      issues: [...stages, ...(rec ? [rec] : [])].flatMap(s => s?.issues ?? []),
      seconds: Math.round(stages.reduce((n, s) => n + (s?.seconds ?? 0), 0)),
      tokens: stages.reduce((n, s) => n + (s?.usage ? s.usage.input_tokens + s.usage.output_tokens : 0), 0),
    }
  })
})
const evals = computed(() => groups.value.flatMap(g => g.evals))
const analysed = computed(() => groups.value.filter(g => g.analysis?.status === 'complete').length)
const summary = computed(() => summarizeAssessment(evals.value, groups.value.length, analysed.value))
const notAnalysed = computed(() => groups.value.filter(g => !g.analysis && !g.running).map(g => g.name))
const running = computed(() => Object.entries(data.value?.running ?? {}))
const overlay = computed(() => proposedOverlay(evals.value))

const STAGES = [
  { key: 'R0', label: 'R0 unmitigated' },
  { key: 'R1', label: 'R1 as-is' },
  { key: 'R1p', label: 'R1 + pending' },
  { key: 'R2', label: 'R2 projected' },
] as const
const stage = ref<(typeof STAGES)[number]['key']>('R1')
const openId = ref<string | null>(null)
const reviewed = computed(() => evals.value.filter(e => e.adequacy !== 'not_credible'))
const points = computed(() => reviewed.value.flatMap(e => (e[stage.value] && e.severity ? [{ f: e[stage.value]!.f, s: e.severity }] : [])))
const marks = computed(() => {
  const e = evals.value.find(x => x.endpoint.endpoint_id === openId.value)
  if (!e?.severity) return []
  return ([['R0', e.R0], ['R1', e.R1], ['P', e.R1p], ['R2', e.R2]] as const).flatMap(([label, s]) => (s ? [{ label, f: s.f, s: e.severity! }] : []))
})

const DECISION = {
  adequate: { text: 'Adequate', style: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  inadequate: { text: 'Inadequate', style: 'border-red-200 bg-red-50 text-red-700' },
  undetermined: { text: 'Undetermined', style: 'border-amber-200 bg-amber-50 text-amber-800' },
  not_credible: { text: '—', style: '' },
}
const decisionDetail = computed(() => {
  const s = summary.value
  if (s.decision === 'inadequate') return `${s.inadequate} endpoint(s) stay at risk I/II even if every pending layer is confirmed.`
  if (s.decision === 'adequate') return 'Every credible endpoint reaches risk III/IV with qualified existing layers.'
  return [s.incomplete && `${groups.value.length - analysed.value} deviation(s) not analysed`, s.undetermined && `${s.undetermined} endpoint(s) depend on pending evidence or unreviewed data`]
    .filter(Boolean).join('; ') + '.'
})

// ---- data checks (Phase 1) ----
const findings = computed(() => {
  const c = caseData.value
  if (!c?.safety || !graph.value) return []
  return reconcile(c.pid, c.pos, c.safety, makeResolver(graph.value.nodes, graphAliases(c.safety)))
})
const findingGroups = computed(() => (Object.keys(FINDING_LABEL) as FindingKind[])
  .map(kind => ({ kind, label: FINDING_LABEL[kind], items: findings.value.filter(f => f.kind === kind) })).filter(g => g.items.length))
const missing = computed(() => (data.value?.safety ? missingEvidence(data.value.safety) : []))

// ---- jobs ----
async function run(deviations: string[], rerun = false) {
  if (rerun && !confirm('Re-running replaces this analysis and drops its recommendations. Review decisions stay in the log. Continue?')) return
  await $fetch(`/api/assess/${id}/run`, { method: 'POST', body: { deviations } })
  await refresh()
}
async function recommend(g: (typeof groups.value)[number]) {
  await $fetch(`/api/assess/${id}/recommend`, { method: 'POST', body: { deviation: g.name, deficiencies: g.payload } })
  await refresh()
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  watch(() => running.value.length, (n) => {
    clearInterval(timer)
    timer = n ? setInterval(refresh, 4000) : undefined
  }, { immediate: true })
})
onBeforeUnmount(() => clearInterval(timer))

const request = ref<ReviewRequest | null>(null)
async function saved() {
  request.value = null
  await refresh()
}

useHead({ title: () => (caseData.value ? `${caseData.value.id} · Safety assessment — Super NODE` : 'Super NODE') })
</script>

<template>
  <main class="min-h-screen bg-white">
    <div class="mx-auto max-w-7xl px-4 py-8 md:px-8">
      <AppHeader />

      <p v-if="error" class="mt-10 rounded-xl bg-red-50 p-6 text-red-700">
        Could not load case {{ id }} ({{ error.statusCode }}). <NuxtLink to="/" class="underline">Back to search</NuxtLink>
      </p>

      <template v-else-if="caseData && data && graph">
        <div class="mt-6 flex flex-wrap items-center gap-3">
          <span class="size-4 rounded-full bg-[#22c55e]" />
          <h2 class="text-2xl font-medium tracking-tight">Safety assessment</h2>
          <span class="capitalize text-zinc-500">{{ caseData.name }} <span class="font-mono text-sm text-zinc-400">#{{ id }}</span></span>
          <NuxtLink :to="`/case/${id}`" class="text-sm text-zinc-500 hover:text-black">← 3D graph</NuxtLink>
          <NuxtLink :to="`/lopa/${id}`" class="text-sm text-zinc-500 hover:text-black">Baseline review (single prompt)</NuxtLink>
          <div class="ml-auto flex items-center gap-2 text-sm">
            <span class="rounded-full bg-zinc-100 px-3 py-1 font-mono text-xs text-zinc-600" :title="`source ${data.versions.source_version} · prompts ${data.versions.prompt_version} · rules ${data.versions.rules_version}`">
              AI · {{ data.model }}
            </span>
            <button v-if="notAnalysed.length" type="button" class="rounded-lg bg-black px-4 py-2 text-white" @click="run(notAnalysed)">
              Analyse · {{ notAnalysed.length }} deviation{{ notAnalysed.length > 1 ? 's' : '' }}
            </button>
          </div>
        </div>

        <p v-if="!data.safety" class="mt-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">
          No safety layer (json_safety) for this case: no safety functions, so dependency checks only use the tags P3 names.
        </p>
        <p v-if="running.length" class="mt-3 flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm text-zinc-600">
          <span class="size-3 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
          {{ running.map(([d, s]) => `${d}: ${s}`).join(' · ') }} — each stage takes a few minutes; results appear stage by stage.
        </p>

        <!-- node-level answers -->
        <section class="mt-6 grid gap-3 md:grid-cols-5">
          <div class="rounded-xl border p-4 md:col-span-2" :class="DECISION[summary.decision].style">
            <p class="text-sm text-zinc-600">Is the protection of this node adequate?</p>
            <p class="mt-1 text-2xl font-medium">{{ DECISION[summary.decision].text }}</p>
            <p class="mt-1 text-xs leading-relaxed text-zinc-600">{{ decisionDetail }}</p>
          </div>
          <div class="rounded-xl border border-zinc-200 p-4">
            <p class="text-sm text-zinc-600">As-is (R1)</p>
            <p class="mt-1 text-2xl font-medium">{{ summary.gaps.R1 }}<span class="text-base text-zinc-400"> / {{ summary.reviewed }}</span></p>
            <p class="mt-1 text-xs text-zinc-500">endpoints at I/II with qualified layers only</p>
          </div>
          <div class="rounded-xl border border-zinc-200 p-4">
            <p class="text-sm text-zinc-600">If pending evidence holds</p>
            <p class="mt-1 text-2xl font-medium">{{ summary.gaps.R1p }}<span class="text-base text-zinc-400"> / {{ summary.reviewed }}</span></p>
            <p class="mt-1 text-xs text-zinc-500">at I/II counting unverified layers that pass applicability and independence</p>
          </div>
          <div class="rounded-xl border border-dashed border-zinc-300 p-4">
            <p class="text-sm text-zinc-600">Projected (R2)</p>
            <p class="mt-1 text-2xl font-medium">{{ summary.gaps.R2 }}<span class="text-base text-zinc-400"> / {{ summary.reviewed }}</span></p>
            <p class="mt-1 text-xs text-zinc-500">at I/II with {{ summary.proposals }} open proposal(s) — conditional, not installed</p>
          </div>
        </section>
        <p class="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          {{ analysed }} of {{ groups.length }} deviations analysed · {{ summary.endpoints }} endpoints · {{ summary.notCredible }} not credible ·
          <span v-for="(n, code) in summary.deficiencies" :key="code" class="rounded bg-zinc-100 px-1.5 py-0.5" :title="DEFICIENCY_TITLE[code as DeficiencyCode]">
            <b class="font-medium">{{ code }}</b> {{ n }}
          </span>
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
            <RiskMatrix :rules="data.rules" :points="points" :marks="marks" />
            <p class="mt-2 text-[11px] text-zinc-500">Numbers = endpoints per cell. Open an endpoint to see its path: R0 → R1 → P (pending) → R2.</p>
          </div>
          <div class="space-y-3 rounded-xl bg-white p-4 text-sm leading-relaxed text-zinc-600">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">How the assessment is made</h3>
            <p>
              <b>P1</b> traces each cause forward with no safeguard. <b>P2</b> challenges the trace and rates each endpoint (credibility, type, severity).
              <b>P3</b> works backward from each credible endpoint to the protective functions it needs and the existing safeguards that could perform them.
              <b>P4</b> judges every safeguard on six checks. The engineer worksheet is not shown to the model.
            </p>
            <p>
              Code turns the checks into a status: any failed check makes a layer invalid (not applicable if applicability fails), any unknown makes it unverified.
              Only <b>qualified</b> layers earn credit in <b>R1</b>. Unverified layers that pass applicability and independence count only in the pending band.
              A layer sharing a component with the cause earns nothing; layers sharing a component with each other count once, until an engineer confirms independence.
              Deficiencies D1–D7 and adequacy follow from these results; <b>P6</b> then proposes actions for them. Proposals count only in <b>R2</b>, and only when they act on frequency.
            </p>
            <ul class="space-y-1 text-xs">
              <li v-for="r in data.rules.risk_ranks" :key="r.r" class="flex items-center gap-2">
                <span class="w-8 rounded py-0.5 text-center font-semibold" :class="RISK_STYLE[r.r]">{{ r.label }}</span>
                <span><b class="font-medium">{{ r.name }}</b> — {{ r.action }}</span>
              </li>
            </ul>
          </div>
        </section>

        <!-- Phase 1: data checks -->
        <details v-if="data.safety" class="mt-6 rounded-xl border border-zinc-200">
          <summary class="cursor-pointer px-4 py-2.5 text-sm">
            <b class="font-medium">Data checks</b>
            <span class="text-zinc-500"> · {{ findings.length }} reconciliation finding(s) · {{ missing.length }} safety function(s) missing evidence · safety layer {{ data.safety.version }}</span>
          </summary>
          <div class="grid gap-6 px-4 pb-4 text-xs leading-relaxed lg:grid-cols-2">
            <div class="space-y-3">
              <p class="text-zinc-500">{{ data.safety.status_note }}</p>
              <div v-for="g in findingGroups" :key="g.kind">
                <p class="font-medium text-zinc-700">{{ g.label }} ({{ g.items.length }})</p>
                <ul class="mt-1 space-y-1">
                  <li v-for="(f, i) in g.items" :key="i" class="text-zinc-600">
                    <span v-if="f.ids.length" class="font-mono">{{ f.ids.join(', ') }}</span>
                    <span v-if="f.drawn"><template v-if="f.ids.length"> ← drawing: </template>{{ f.drawn }}</span>
                    <span v-if="f.note" class="block text-zinc-500">{{ f.note }}</span>
                  </li>
                </ul>
              </div>
            </div>
            <div>
              <p class="font-medium text-zinc-700">Evidence not available for each safety function</p>
              <ul class="mt-1 space-y-1">
                <li v-for="m in missing" :key="m.id" class="text-zinc-600">
                  <span class="font-mono">{{ m.id }}</span> · {{ m.label }}: <span class="text-amber-800">{{ m.missing.join(', ') }}</span>
                </li>
              </ul>
            </div>
          </div>
        </details>

        <!-- per deviation -->
        <section v-for="g in groups" :key="g.name" class="mt-6 overflow-hidden rounded-xl border border-zinc-200">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 bg-zinc-50 px-4 py-2.5">
            <h3 class="font-medium">{{ g.name }}</h3>
            <span v-if="g.running" class="text-xs text-zinc-500">running {{ g.running }}…</span>
            <span v-else-if="g.analysis" class="text-xs text-zinc-400">
              {{ g.analysis.status === 'complete' ? 'P1–P4 complete' : `stopped after ${Object.keys(g.analysis.stages).pop()?.toUpperCase()}` }}
              · {{ g.seconds }} s · {{ g.tokens.toLocaleString() }} tokens
            </span>
            <span v-else class="text-xs text-zinc-400">not analysed</span>
            <span v-if="g.stale" class="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800" title="Inputs, prompts or rules changed since this run">stale</span>
            <span v-if="g.error" class="text-xs text-red-600">Failed: {{ g.error }}</span>
            <span class="ml-auto flex gap-1.5">
              <button
                v-if="g.analysis?.status === 'complete' && g.payload.length && !g.running" type="button"
                class="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:border-black"
                :title="`${g.payload.length} deficiencies on endpoints that are not adequate`" @click="recommend(g)"
              >
                {{ g.rec ? 'Re-run' : 'Recommend actions' }} (P6)
              </button>
              <button
                v-if="!g.running" type="button" class="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 hover:text-black"
                @click="run([g.name], g.analysis?.status === 'complete')"
              >
                {{ !g.analysis ? 'Analyse' : g.analysis.status === 'partial' ? 'Resume' : 'Re-run' }} (P1–P4)
              </button>
            </span>
          </div>
          <p v-if="g.rec" class="border-t border-zinc-100 px-4 py-1.5 text-xs text-zinc-500">
            P6: {{ g.rec.actions.length }} proposed action(s) · {{ g.rec.seconds }} s
            <span v-if="g.recStale" class="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">deficiencies changed since — re-run P6</span>
          </p>
          <details v-if="g.issues.length" class="border-t border-zinc-100 px-4 py-1.5 text-xs text-amber-800">
            <summary class="cursor-pointer">{{ g.issues.length }} validation issue(s) in the AI output</summary>
            <ul class="list-disc pl-5"><li v-for="(m, i) in g.issues" :key="i">{{ m }}</li></ul>
          </details>
          <AssessScenario
            v-for="x in g.byCause" :key="x.cause.cause_id" :cause="x.cause" :evals="x.evals" :graph="graph" :safety="data.safety"
            :rules="data.rules" :reviews="reviews" :labels="labels" :open-id="openId"
            @toggle="openId = openId === $event ? null : $event" @review="request = $event"
          />
        </section>

        <!-- Phase 4: proposals stay an overlay; review history -->
        <details v-if="overlay.length" class="mt-6 rounded-xl border border-dashed border-zinc-300">
          <summary class="cursor-pointer px-4 py-2.5 text-sm"><b class="font-medium">Proposed overlay</b><span class="text-zinc-500"> · {{ overlay.length }} change(s), not part of the as-designed graph</span></summary>
          <table class="w-full text-left text-xs">
            <thead class="text-zinc-400"><tr><th class="px-4 py-1 font-medium">Action</th><th class="px-2 font-medium">Status</th><th class="px-2 font-medium">New</th><th class="px-2 font-medium">Modifies</th><th class="px-2 font-medium">At</th></tr></thead>
            <tbody>
              <tr v-for="o in overlay" :key="o.action_id" class="border-t border-zinc-100 align-top">
                <td class="px-4 py-1 font-mono">{{ o.action_id }}</td>
                <td class="px-2 py-1">{{ o.status.replaceAll('_', ' ') }}</td>
                <td class="px-2 py-1">{{ o.new_tags.join(', ') || '—' }}</td>
                <td class="px-2 py-1 font-mono">{{ o.modifies.join(', ') || '—' }}</td>
                <td class="px-2 py-1 font-mono">{{ o.attaches_to.join(', ') || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </details>

        <details class="mt-3 rounded-xl border border-zinc-200">
          <summary class="cursor-pointer px-4 py-2.5 text-sm"><b class="font-medium">Review log</b><span class="text-zinc-500"> · {{ data.reviews.length }} decision(s), append-only</span></summary>
          <ul class="divide-y divide-zinc-100 text-xs">
            <li v-for="r in [...data.reviews].reverse()" :key="r.id" class="px-4 py-2 leading-relaxed">
              <span class="text-zinc-400">{{ r.at.replace('T', ' ').slice(0, 16) }} UTC</span>
              <b class="ml-2 font-medium">{{ r.reviewer }}</b> <span class="text-zinc-500">({{ r.role }})</span>
              · {{ REVIEW_ACTION_LABEL[r.action] }} <span class="font-mono text-zinc-500">{{ r.item }}</span>
              <span v-if="Object.keys(r.change).length" class="font-mono text-zinc-500"> {{ JSON.stringify(r.change) }}</span>
              <span class="block text-zinc-600">{{ r.reason }}<template v-if="r.evidence"> · evidence: {{ r.evidence }}</template></span>
            </li>
            <li v-if="!data.reviews.length" class="px-4 py-2 text-zinc-500">No decisions yet.</li>
          </ul>
        </details>
      </template>
    </div>

    <ReviewDialog :request="request" :case-id="id" @close="request = null" @saved="saved" />
  </main>
</template>
