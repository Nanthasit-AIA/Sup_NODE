/**
 * Staged safety assessment (improvement plan S2–S7). The model supplies judgements (P1–P4, P6);
 * everything that decides credit is computed here from them:
 *   IPL status from the six P4 checks → credit gates (cause dependency, shared components)
 *   → risk stages R0 / R1 / R1p / R2 → deficiencies D1–D7 → adequacy.
 * Engineer review events (append-only log) are applied on top of the AI judgements.
 */
import { fCategory, riskRank, type Rules, type Stage } from './lopa'
import { expandIds, functionComponents, type SafetyLayer } from './safety'
import { pathBetween, type Graph } from './supernode'

// ---- backend shapes (backend/module/hazard_scenario.py, ipl_qualification.py, safety_improvement.py) ----

export type Versions = { source_version: string; prompt_version: string; rules_version: string }
export type Credibility = 'credible' | 'not_credible' | 'insufficient_evidence'
export type Step = { step: number; from_id: string; to_id: string; mechanism: string; effect: string }
export type Endpoint = { endpoint_id: string; element_id: string; consequence: string }
export type P1Scenario = {
  cause_id: string; source_type: string; cause_source_ids: string[]
  initiating_event: string; initiating_event_class: string; initiating_event_reason: string
  local_effect: string; propagation_steps: Step[]; hazard_endpoints: Endpoint[]
  operating_assumptions: string[]; evidence_refs: string[]
}
export type EndpointReview = {
  endpoint_id: string; credibility: Credibility; endpoint_type: 'process_safety' | 'equipment_protection' | 'operability'
  hazardous_event: string; severity: number; severity_reason: string; physical_basis: string; required_evidence: string[]
}
export type ScenarioReview = {
  cause_id: string; scenario_credibility: Credibility; credibility_reason: string
  unsupported_steps: { step: number; reason: string }[]; endpoints: EndpointReview[]
}
export type Candidate = {
  candidate_id: string; function_id: string | null; component_ids: string[]; description: string
  intervention_point_ids: string[]; mechanism: string; addresses: string
}
export type RequiredFunction = {
  function_id: string; kind: 'preventive' | 'mitigative'; description: string; intervention_point_ids: string[]; candidate_ids: string[]
}
export type EndpointProtection = { endpoint_id: string; required_functions: RequiredFunction[]; candidates: Candidate[] }
export const CHECKS = ['applicability', 'effectiveness', 'independence', 'common_cause', 'reliability', 'auditability'] as const
export type CheckKey = (typeof CHECKS)[number]
export type CheckResult = 'pass' | 'fail' | 'unknown'
export type Check = { result: CheckResult; basis: string }
export type Assessment = {
  pair_id: string; endpoint_id: string; candidate_id: string; ipl_type: string | null
  dependency_refs: string[]; missing_evidence: string[]
} & Record<CheckKey, Check>
export type Action = {
  action_id: string; endpoint_id: string; target_deficiency_ids: string[]; strategy: string; description: string
  ipl_type: string | null; existing_ids: string[]; new_tags: string[]; intervention_point_ids: string[]
  expected_mechanism: string; effect_on: 'frequency' | 'consequence' | 'evidence_only'
  possible_dependencies: string[]; verification_requirements: string[]; reasoning: string; process_benefit: string
}
type StageMeta = { seconds?: number; model?: string; usage?: { input_tokens: number; output_tokens: number } | null; issues: string[]; skipped?: string }
export type DeviationAnalysis = {
  deviation: string; versions: Versions; status: 'partial' | 'complete'; started_at: string; finished_at?: string
  stages: {
    p1?: StageMeta & { scenarios: P1Scenario[] }
    p2?: StageMeta & { reviews: ScenarioReview[] }
    p3?: StageMeta & { endpoints: EndpointProtection[] }
    p4?: StageMeta & { assessments: Assessment[] }
  }
  recommendations?: StageMeta & { generated_at: string; versions: Versions; deficiency_ids: string[]; actions: Action[] }
}
export type ReviewAction = 'confirm_assessment' | 'revise' | 'request_verification' | 'reject' | 'accept_for_further_engineering'
export type ReviewEvent = {
  id: string; at: string; reviewer: string; role: string; deviation: string; item: string; action: ReviewAction
  reason: string; evidence: string; change: Record<string, unknown>; versions: Versions; analysis_started_at: string | null
}
export type AssessData = {
  rules: Rules; safety: SafetyLayer | null; assessment: { deviations: Record<string, DeviationAnalysis> }
  reviews: ReviewEvent[]; running: Record<string, string>; errors: Record<string, string>; model: string; versions: Versions
}

// ---- engineer review ----

/** Review items: the thing a decision is about. */
export const itemKey = {
  scenario: (causeId: string) => `scenario:${causeId}`,
  endpoint: (endpointId: string) => `endpoint:${endpointId}`,
  layer: (endpointId: string, candidateId: string) => `layer:${endpointId}|${candidateId}`,
  dependency: (endpointId: string, a: string, b: string) => `dependency:${endpointId}|${[a, b].sort().join('|')}`,
  action: (actionId: string) => `action:${actionId}`,
}
export type ReviewState = { change: Record<string, unknown>; last: ReviewEvent; history: ReviewEvent[] }
/** What the review dialog asks for: the allowed decisions and any fields the engineer may change (null = back to the AI value). */
export type ReviewField = { key: string; label: string; value: string | number | null; options: { value: string | number | null; label: string }[] }
export type ReviewRequest = {
  deviation: string; item: string; title: string; actions: ReviewAction[]
  fields?: ReviewField[]; change?: Record<string, unknown>
}
export const REVIEW_ACTION_LABEL: Record<ReviewAction, string> = {
  confirm_assessment: 'Confirm assessment', revise: 'Revise', request_verification: 'Request verification',
  reject: 'Reject', accept_for_further_engineering: 'Accept for further engineering',
}

/** Latest decision per item; revisions merge in order and a null value resets a field to the AI judgement. */
export function foldReviews(events: ReviewEvent[]): Map<string, ReviewState> {
  const out = new Map<string, ReviewState>()
  for (const e of events) {
    const s = out.get(e.item) ?? { change: {}, last: e, history: [] }
    const change = { ...s.change }
    for (const [k, v] of Object.entries(e.change)) {
      if (v === null) delete change[k]
      else change[k] = v
    }
    out.set(e.item, { change, last: e, history: [...s.history, e] })
  }
  return out
}

export type ProposalStatus = 'candidate' | 'needs_verification' | 'rejected' | 'accepted_for_engineering'
const PROPOSAL_STATUS: Partial<Record<ReviewAction, ProposalStatus>> = {
  request_verification: 'needs_verification', reject: 'rejected', accept_for_further_engineering: 'accepted_for_engineering',
}

// ---- evaluation ----

export type LayerStatus = 'qualified' | 'invalid' | 'not_applicable' | 'unverified' | 'not_assessed'
export type Gate = 'credited' | 'pending' | 'blocked' | 'none'
export type Layer = {
  candidate: Candidate; assessment: Assessment | null
  checks: Record<CheckKey, Check & { revised: boolean }> | null
  status: LayerStatus; iplType: string | null; credit: number
  components: string[]
  causeShared: string[] // components shared with the initiating cause, unless the engineer confirmed independence
  sharedWith: { id: string; components: string[] }[] // other layers it was counted together with
  gate: Gate; gateReason: string
}
export type ActionEval = { action: Action; status: ProposalStatus; credit: number; counted: boolean; note: string }
export type DeficiencyCode = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7'
export type Deficiency = { id: string; code: DeficiencyCode; endpoint_id: string; title: string; detail: string; refs: string[] }
export type Adequacy = 'adequate' | 'inadequate' | 'undetermined' | 'not_credible'
export type EndpointEval = {
  deviation: string; scenario: P1Scenario; scenarioReview: ScenarioReview | null; endpoint: Endpoint; review: EndpointReview | null
  credibility: Credibility | null; severity: number | null; initiatingEvent: Rules['initiating_events'][number] | null
  functions: RequiredFunction[]; layers: Layer[]; protectionReviewed: boolean
  R0: Stage | null; R1: Stage | null; R1p: Stage | null; R2: Stage | null
  actions: ActionEval[]; deficiencies: Deficiency[]; adequacy: Adequacy; adequacyReason: string
}

export const DEFICIENCY_TITLE: Record<DeficiencyCode, string> = {
  D1: 'Missing protective function', D2: 'Inapplicable safeguard', D3: 'Dependent layers', D4: 'Inadequate performance',
  D5: 'Not independent of the cause', D6: 'Insufficient overall risk reduction', D7: 'Insufficient qualification evidence',
}
const COUNTED_STRATEGIES = ['eliminate_or_reduce_hazard', 'modify_existing_function', 'add_preventive_function', 'add_mitigative_function']

/** IPL status from the six checks: a failed applicability means not applicable, any other fail invalid, any unknown unverified. */
export function layerStatus(checks: Record<CheckKey, { result: CheckResult }>): LayerStatus {
  if (checks.applicability.result === 'fail') return 'not_applicable'
  if (CHECKS.some(k => checks[k].result === 'fail')) return 'invalid'
  if (CHECKS.some(k => checks[k].result === 'unknown')) return 'unverified'
  return 'qualified'
}

function combine(scenario: Credibility | null, endpoint: Credibility | null): Credibility | null {
  if (scenario === 'not_credible' || endpoint === 'not_credible') return 'not_credible'
  if (scenario === 'insufficient_evidence' || endpoint === 'insufficient_evidence') return 'insufficient_evidence'
  return scenario && endpoint ? 'credible' : null
}

export function evaluateDeviation(
  rules: Rules, safety: SafetyLayer | null, analysis: DeviationAnalysis, reviews: Map<string, ReviewState>,
): EndpointEval[] {
  const { p1, p2, p3, p4 } = analysis.stages
  return (p1?.scenarios ?? []).flatMap((scenario) => {
    const scenarioReview = p2?.reviews.find(r => r.cause_id === scenario.cause_id) ?? null
    const edit = reviews.get(itemKey.scenario(scenario.cause_id))?.change ?? {}
    const ieId = (edit.initiating_event_class as string | undefined) ?? scenario.initiating_event_class
    const scenarioCred = (edit.scenario_credibility as Credibility | undefined) ?? scenarioReview?.scenario_credibility ?? null
    return scenario.hazard_endpoints.map(endpoint => evaluateEndpoint({
      rules, safety, reviews, scenario, scenarioReview, endpoint, scenarioCred,
      initiatingEvent: rules.initiating_events.find(e => e.id === ieId) ?? null,
      deviation: analysis.deviation,
      review: (p2?.reviews ?? []).flatMap(r => r.endpoints).find(e => e.endpoint_id === endpoint.endpoint_id) ?? null,
      protection: p3?.endpoints.find(e => e.endpoint_id === endpoint.endpoint_id) ?? null,
      assessments: (p4?.assessments ?? []).filter(a => a.endpoint_id === endpoint.endpoint_id),
      actions: (analysis.recommendations?.actions ?? []).filter(a => a.endpoint_id === endpoint.endpoint_id),
    }))
  })
}

function evaluateEndpoint(x: {
  rules: Rules; safety: SafetyLayer | null; reviews: Map<string, ReviewState>; deviation: string
  scenario: P1Scenario; scenarioReview: ScenarioReview | null; endpoint: Endpoint; scenarioCred: Credibility | null
  initiatingEvent: Rules['initiating_events'][number] | null; review: EndpointReview | null
  protection: EndpointProtection | null; assessments: Assessment[]; actions: Action[]
}): EndpointEval {
  const { rules, safety, reviews, endpoint } = x
  const id = endpoint.endpoint_id
  const edit = reviews.get(itemKey.endpoint(id))?.change ?? {}
  const credibility = combine(x.scenarioCred, (edit.credibility as Credibility | undefined) ?? x.review?.credibility ?? null)
  const severity = (edit.severity as number | undefined) ?? x.review?.severity ?? null
  const creditOf = (type: string) => rules.ipl_types.find(t => t.id === type)?.credit ?? 0
  const base = x.initiatingEvent && x.initiatingEvent.per_year > 0 ? Math.log10(x.initiatingEvent.per_year) : null
  const stage = (credits: number): Stage | null => {
    if (base === null || severity === null) return null
    const f = fCategory(base - credits)
    return { credits, f, r: riskRank(rules, f, severity) }
  }
  const independent = (a: string, b: string) => reviews.get(itemKey.dependency(id, a, b))?.change.independent === true
  const causeIds = expandIds(safety, x.scenario.cause_source_ids)
  const fnById = new Map(safety?.safety_functions.map(f => [f.id, f]))

  // 1. status per candidate from its checks (engineer revisions override single checks)
  const layers: Layer[] = (x.protection?.candidates ?? []).map((candidate) => {
    const assessment = x.assessments.find(a => a.candidate_id === candidate.candidate_id) ?? null
    const ledit = reviews.get(itemKey.layer(id, candidate.candidate_id))?.change ?? {}
    const checks = assessment
      ? Object.fromEntries(CHECKS.map(k => [k, { ...assessment[k], result: (ledit[k] as CheckResult | undefined) ?? assessment[k].result, revised: k in ledit }])) as Layer['checks']
      : null
    const iplType = (ledit.ipl_type as string | undefined) ?? assessment?.ipl_type ?? null
    const fn = candidate.function_id ? fnById.get(candidate.function_id) : undefined
    const components = fn ? functionComponents(fn) : expandIds(safety, candidate.component_ids)
    const causeShared = independent(candidate.candidate_id, 'cause') ? [] : components.filter(c => causeIds.includes(c))
    return {
      candidate, assessment, checks, status: checks ? layerStatus(checks) : 'not_assessed', iplType, credit: iplType ? creditOf(iplType) : 0,
      components, causeShared, sharedWith: [], gate: 'none', gateReason: '',
    }
  })

  // 2. gates: invalid / no type → none; shares a component with the cause → blocked; qualified → credited;
  //    unverified but applicable and independent → pending (counts only in R1p)
  for (const l of layers) {
    const pass = (k: CheckKey) => l.checks?.[k].result === 'pass'
    if (l.status === 'not_assessed') l.gateReason = 'not assessed (P4)'
    else if (l.status === 'invalid' || l.status === 'not_applicable') l.gateReason = l.status.replace('_', ' ')
    else if (!l.iplType || !l.credit) l.gateReason = 'not an IPL type'
    else if (l.causeShared.length) {
      l.gate = 'blocked'
      l.gateReason = `shares ${l.causeShared.join(', ')} with the initiating cause`
    }
    else if (l.status === 'qualified') l.gate = 'credited'
    else if (pass('applicability') && pass('independence')) l.gate = 'pending'
    else l.gateReason = 'unverified, and applicability or independence not shown'
  }
  // 3. layers sharing a component count once: keep qualified before pending, then the larger credit
  const counted: Layer[] = []
  const order = layers.filter(l => l.gate === 'credited' || l.gate === 'pending')
    .sort((a, b) => (a.gate === b.gate ? b.credit - a.credit : a.gate === 'credited' ? -1 : 1))
  for (const l of order) {
    const clash = counted
      .map(c => ({ c, shared: l.components.filter(p => c.components.includes(p)) }))
      .filter(({ c, shared }) => shared.length && !independent(l.candidate.candidate_id, c.candidate.candidate_id))
    if (!clash.length) {
      counted.push(l)
      continue
    }
    for (const { c, shared } of clash) {
      l.sharedWith.push({ id: c.candidate.candidate_id, components: shared })
      c.sharedWith.push({ id: l.candidate.candidate_id, components: shared })
    }
    l.gate = 'blocked'
    l.gateReason = `shares ${clash[0]!.shared.join(', ')} with ${clash[0]!.c.candidate.candidate_id} (counted once)`
  }

  const credited = counted.filter(l => l.gate === 'credited').reduce((n, l) => n + l.credit, 0)
  const pending = counted.filter(l => l.gate === 'pending').reduce((n, l) => n + l.credit, 0)
  const R0 = stage(0)
  const R1 = stage(credited)
  const R1p = stage(credited + pending)

  // 4. proposals: candidates until reviewed; never in R1/R1p; in R2 only when they act on frequency and stay independent
  const usedByCounted = counted.flatMap(l => l.components)
  const actions: ActionEval[] = x.actions.map((action) => {
    const last = reviews.get(itemKey.action(action.action_id))?.last
    const status = (last && PROPOSAL_STATUS[last.action]) || 'candidate'
    const uses = expandIds(safety, action.existing_ids)
    const credit = action.ipl_type && action.effect_on === 'frequency' && COUNTED_STRATEGIES.includes(action.strategy) ? creditOf(action.ipl_type) : 0
    const note
      = status === 'rejected' ? 'rejected by the reviewer'
        : !credit ? (action.effect_on === 'consequence' ? 'claims a lower consequence: needs a consequence reassessment, not applied' : 'no frequency credit')
            : uses.some(u => causeIds.includes(u)) ? `uses ${uses.filter(u => causeIds.includes(u)).join(', ')}, part of the initiating cause`
              : uses.some(u => usedByCounted.includes(u)) ? `shares ${uses.filter(u => usedByCounted.includes(u)).join(', ')} with a layer already counted`
                : ''
    return { action, status, credit, counted: !!credit && !note, note }
  })
  const R2 = stage(credited + pending + actions.filter(a => a.counted).reduce((n, a) => n + a.credit, 0))

  const functions = x.protection?.required_functions ?? []
  const deficiencies = credibility === 'not_credible' ? [] : findDeficiencies(id, functions, layers, R0, R1, R1p)
  const [adequacy, adequacyReason] = judgeAdequacy(credibility, !!x.protection, R1, R1p)
  return {
    deviation: x.deviation, scenario: x.scenario, scenarioReview: x.scenarioReview, endpoint, review: x.review,
    credibility, severity, initiatingEvent: x.initiatingEvent, functions, layers, protectionReviewed: !!x.protection,
    R0, R1, R1p, R2, actions, deficiencies, adequacy, adequacyReason,
  }
}

const gap = (s: Stage | null) => !!s && s.r <= 2 // I or II

function findDeficiencies(id: string, functions: RequiredFunction[], layers: Layer[], R0: Stage | null, R1: Stage | null, R1p: Stage | null): Deficiency[] {
  const out: Deficiency[] = []
  const add = (code: DeficiencyCode, key: string, detail: string, refs: string[]) =>
    out.push({ id: `${id}/${code}${key ? `/${key}` : ''}`, code, endpoint_id: id, title: DEFICIENCY_TITLE[code], detail, refs })
  const result = (l: Layer, k: CheckKey) => l.checks?.[k].result
  const basis = (l: Layer, k: CheckKey) => l.checks?.[k].basis ?? ''

  if (gap(R0)) {
    for (const f of functions) if (!f.candidate_ids.length) add('D1', f.function_id, `${f.kind}: ${f.description}`, [f.function_id])
  }
  for (const l of layers) {
    const cid = l.candidate.candidate_id
    if (l.status === 'not_applicable') add('D2', cid, basis(l, 'applicability'), [cid])
    if (result(l, 'common_cause') === 'fail') add('D3', cid, basis(l, 'common_cause'), [cid])
    for (const s of l.sharedWith) {
      const pair = [cid, s.id].sort()
      if (cid === pair[0]) add('D3', pair.join('+'), `${pair.join(' and ')} share ${s.components.join(', ')}: counted as one layer`, pair)
    }
    const weak = (['effectiveness', 'reliability'] as const).filter(k => result(l, k) === 'fail')
    if (weak.length) add('D4', cid, weak.map(k => basis(l, k)).join(' '), [cid])
    if (l.causeShared.length && (l.status === 'qualified' || l.status === 'unverified')) {
      add('D5', cid, `shares ${l.causeShared.join(', ')} with the initiating cause`, [cid])
    }
    else if (result(l, 'independence') === 'fail') add('D5', cid, basis(l, 'independence'), [cid])
    if (l.status === 'unverified' || result(l, 'auditability') === 'fail') {
      add('D7', cid, l.assessment?.missing_evidence.join('; ') || basis(l, 'auditability'), [cid])
    }
  }
  if (gap(R1)) {
    add('D6', '', gap(R1p)
      ? 'Risk stays I/II even if every pending layer is confirmed.'
      : 'Risk reaches III/IV only if the pending evidence is confirmed.', [])
  }
  return out
}

function judgeAdequacy(credibility: Credibility | null, reviewed: boolean, R1: Stage | null, R1p: Stage | null): [Adequacy, string] {
  if (credibility === 'not_credible') return ['not_credible', 'screened out as not credible']
  if (credibility === null) return ['undetermined', 'credibility not reviewed (P2)']
  if (credibility === 'insufficient_evidence') return ['undetermined', 'credibility needs more evidence']
  if (!reviewed || !R1 || !R1p) return ['undetermined', 'protection not reviewed (P3/P4)']
  if (!gap(R1)) return ['adequate', 'qualified existing layers reach risk III/IV']
  if (!gap(R1p)) return ['undetermined', 'adequate only if the pending evidence is confirmed']
  return ['inadequate', 'risk stays I/II even with every pending layer']
}

// ---- node level ----

export function summarizeAssessment(evals: EndpointEval[], deviationsTotal: number, deviationsAnalysed: number) {
  const reviewed = evals.filter(e => e.adequacy !== 'not_credible')
  const atGap = (k: 'R0' | 'R1' | 'R1p' | 'R2') => reviewed.filter(e => gap(e[k])).length
  const byAdequacy = (a: Adequacy) => evals.filter(e => e.adequacy === a).length
  const deficiencies = Object.fromEntries((Object.keys(DEFICIENCY_TITLE) as DeficiencyCode[])
    .map(c => [c, evals.reduce((n, e) => n + e.deficiencies.filter(d => d.code === c).length, 0)])) as Record<DeficiencyCode, number>
  const incomplete = deviationsAnalysed < deviationsTotal
  const decision: Adequacy = byAdequacy('inadequate') ? 'inadequate'
    : incomplete || byAdequacy('undetermined') || !reviewed.length ? 'undetermined' : 'adequate'
  return {
    endpoints: evals.length, reviewed: reviewed.length, notCredible: byAdequacy('not_credible'),
    gaps: { R0: atGap('R0'), R1: atGap('R1'), R1p: atGap('R1p'), R2: atGap('R2') },
    adequate: byAdequacy('adequate'), inadequate: byAdequacy('inadequate'), undetermined: byAdequacy('undetermined'),
    deficiencies, decision, incomplete,
    proposals: evals.reduce((n, e) => n + e.actions.filter(a => a.status !== 'rejected').length, 0),
  }
}

/** Deficiencies sent to P6: only endpoints that are not already adequate. */
export function deficiencyPayload(evals: EndpointEval[]) {
  return evals
    .filter(e => e.adequacy === 'inadequate' || (e.adequacy === 'undetermined' && e.protectionReviewed))
    .flatMap(e => e.deficiencies.map(d => ({ ...d, risk: { R0: e.R0, R1: e.R1, R1p: e.R1p }, target: 'III or IV' })))
}

/** Proposed devices and changes as an overlay that is never merged into the as-designed graph. */
export function proposedOverlay(evals: EndpointEval[]) {
  return evals.flatMap(e => e.actions
    .filter(a => a.status !== 'rejected')
    .map(a => ({
      action_id: a.action.action_id, endpoint_id: e.endpoint.endpoint_id, status: a.status,
      new_tags: a.action.new_tags, modifies: a.action.existing_ids, attaches_to: a.action.intervention_point_ids,
    })))
}

/** Graph path behind a propagation step (systems/sections stand for their members), or null if none is documented. */
export function stepPath(g: Graph, safety: SafetyLayer | null, step: Pick<Step, 'from_id' | 'to_id'>): string[] | null {
  for (const a of expandIds(safety, [step.from_id])) {
    for (const b of expandIds(safety, [step.to_id])) {
      if (a === b) return [a]
      const p = pathBetween(g, a, b)
      if (p) return p
    }
  }
  return null
}
