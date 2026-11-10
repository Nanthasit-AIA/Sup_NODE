import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CHECKS, deficiencyPayload, evaluateDeviation, foldReviews, itemKey, layerStatus, proposedOverlay, stepPath, summarizeAssessment,
  type Action, type Assessment, type CheckResult, type CheckKey, type DeviationAnalysis, type ReviewEvent,
} from '../../app/utils/assess'
import type { Rules } from '../../app/utils/lopa'
import type { SafetyLayer } from '../../app/utils/safety'
import { buildGraph, type PidFile } from '../../app/utils/supernode'

const load = (path: string) => JSON.parse(readFileSync(new URL(`../../backend/static/${path}`, import.meta.url), 'utf-8'))
const rules: Rules = load('lopa_rules.json')
const safety: SafetyLayer = load('json_safety/01_safety.json')
const V = { source_version: 's', prompt_version: 'p', rules_version: 'r' }

const checks = (over: Partial<Record<CheckKey, CheckResult>> = {}) =>
  Object.fromEntries(CHECKS.map(k => [k, { result: over[k] ?? 'pass', basis: `${k} basis` }])) as Record<CheckKey, { result: CheckResult; basis: string }>
const assess = (endpoint: string, candidate: string, ipl_type: string | null, over: Partial<Record<CheckKey, CheckResult>> = {}): Assessment => ({
  pair_id: `${endpoint}|${candidate}`, endpoint_id: endpoint, candidate_id: candidate, ipl_type, dependency_refs: [], missing_evidence: ['proof test record'], ...checks(over),
})
const candidate = (id: string, fn = true) => ({
  candidate_id: id, function_id: fn ? id : null, component_ids: fn ? [] : [id], description: id, intervention_point_ids: [], mechanism: '', addresses: '',
})
const action = (over: Partial<Action>): Action => ({
  action_id: 'C1-E1-A1', endpoint_id: 'C1-E1', target_deficiency_ids: ['C1-E1/D6'], strategy: 'add_preventive_function', description: 'new SIL 2 low-level trip',
  ipl_type: 'sif_sil2', existing_ids: [], new_tags: ['new LT (independent)'], intervention_point_ids: ['100T-01'], expected_mechanism: '',
  effect_on: 'frequency', possible_dependencies: [], verification_requirements: [], reasoning: '', process_benefit: '', ...over,
})

/** One deviation, cause C1 from the B/L (bpcs_loop, 0.1/yr) to 100T-01 at C-4; cause C2 from the inlet UV. */
function analysis(over: { assessments?: Assessment[]; actions?: Action[]; credibility?: 'credible' | 'not_credible' | 'insufficient_evidence' } = {}): DeviationAnalysis {
  const scenario = (cause: string, source: string) => ({
    cause_id: cause, source_type: 'equipment_or_component', cause_source_ids: [source], initiating_event: '', initiating_event_class: 'bpcs_loop',
    initiating_event_reason: '', local_effect: '', propagation_steps: [], hazard_endpoints: [{ endpoint_id: `${cause}-E1`, element_id: '100T-01', consequence: '' }],
    operating_assumptions: [], evidence_refs: [],
  })
  const review = (cause: string) => ({
    cause_id: cause, scenario_credibility: over.credibility ?? 'credible' as const, credibility_reason: '', unsupported_steps: [],
    endpoints: [{ endpoint_id: `${cause}-E1`, credibility: 'credible' as const, endpoint_type: 'process_safety' as const, hazardous_event: '', severity: 4, severity_reason: '', physical_basis: '', required_evidence: [] }],
  })
  return {
    deviation: 'No Flow / Less Flow', versions: V, status: 'complete', started_at: '',
    stages: {
      p1: { issues: [], scenarios: [scenario('C1', 'Existing Process Unit / B-L'), scenario('C2', 'UV-0102-IN')] },
      p2: { issues: [], reviews: [review('C1'), review('C2')] },
      p3: {
        issues: [],
        endpoints: [
          {
            endpoint_id: 'C1-E1',
            required_functions: [
              { function_id: 'C1-E1-F1', kind: 'preventive', description: 'stop pumping on low level', intervention_point_ids: [], candidate_ids: ['SF-LAL-0101A', 'SF-IS10', 'SF-ZA-0101'] },
              { function_id: 'C1-E1-F2', kind: 'mitigative', description: 'contain a release', intervention_point_ids: [], candidate_ids: [] },
            ],
            candidates: [candidate('SF-LAL-0101A'), candidate('SF-IS10'), candidate('SF-ZA-0101'), candidate('PG-0101', false)],
          },
          { endpoint_id: 'C2-E1', required_functions: [], candidates: [candidate('SF-IS09')] },
        ],
      },
      p4: {
        issues: [],
        assessments: over.assessments ?? [
          assess('C1-E1', 'SF-LAL-0101A', 'operator_response', { reliability: 'unknown', auditability: 'unknown' }),
          assess('C1-E1', 'SF-IS10', 'bpcs'),
          assess('C1-E1', 'SF-ZA-0101', 'operator_response', { auditability: 'unknown' }),
          assess('C1-E1', 'PG-0101', null, { applicability: 'fail' }),
          assess('C2-E1', 'SF-IS09', 'bpcs'),
        ],
      },
    },
    ...(over.actions && { recommendations: { issues: [], generated_at: '', versions: V, deficiency_ids: [], actions: over.actions } }),
  }
}
const event = (item: string, action: ReviewEvent['action'], change: Record<string, unknown> = {}): ReviewEvent => ({
  id: item, at: '', reviewer: 'A. Engineer', role: 'process safety', deviation: 'No Flow / Less Flow', item, action, reason: 'test', evidence: '', change, versions: V, analysis_started_at: null,
})
const run = (a: DeviationAnalysis, events: ReviewEvent[] = []) => evaluateDeviation(rules, safety, a, foldReviews(events))
const ep = (evals: ReturnType<typeof run>, id: string) => evals.find(e => e.endpoint.endpoint_id === id)!
const layer = (e: ReturnType<typeof ep>, id: string) => e.layers.find(l => l.candidate.candidate_id === id)!

describe('layerStatus', () => {
  it('derives the IPL status from the six checks', () => {
    expect(layerStatus(checks())).toBe('qualified')
    expect(layerStatus(checks({ reliability: 'unknown' }))).toBe('unverified')
    expect(layerStatus(checks({ reliability: 'unknown', effectiveness: 'fail' }))).toBe('invalid')
    expect(layerStatus(checks({ applicability: 'fail', effectiveness: 'fail' }))).toBe('not_applicable')
  })
})

describe('credit gates and risk stages', () => {
  const e = ep(run(analysis()), 'C1-E1')

  it('credits only qualified layers in R1; unverified ones only in the pending band', () => {
    expect(layer(e, 'SF-IS10').gate).toBe('credited')
    expect(layer(e, 'SF-LAL-0101A').gate).toBe('pending')
    expect(e.R0).toEqual({ credits: 0, f: 1, r: 1 }) // 0.1/yr × C-4 → I
    expect(e.R1).toEqual({ credits: 1, f: 2, r: 2 })
    expect(e.R1p).toEqual({ credits: 2, f: 3, r: 2 })
  })

  it('counts two alarms that rely on the same operator as one layer', () => {
    expect(layer(e, 'SF-ZA-0101').gate).toBe('blocked')
    expect(layer(e, 'SF-ZA-0101').gateReason).toContain('HUM-OPERATOR')
    expect(e.deficiencies.filter(d => d.code === 'D3').map(d => d.id)).toEqual(['C1-E1/D3/SF-LAL-0101A+SF-ZA-0101'])
  })

  it('never credits a layer that shares a component with the initiating cause', () => {
    const c2 = ep(run(analysis()), 'C2-E1')
    expect(layer(c2, 'SF-IS09').gate).toBe('blocked') // IS-09 closes UV-0102-IN, the valve that failed
    expect(c2.R1!.credits).toBe(0)
    expect(c2.deficiencies.map(d => d.code)).toContain('D5')
    const confirmed = ep(run(analysis(), [event(itemKey.dependency('C2-E1', 'SF-IS09', 'cause'), 'revise', { independent: true })]), 'C2-E1')
    expect(layer(confirmed, 'SF-IS09').gate).toBe('credited')
  })

  it('lists the deficiencies with stable ids', () => {
    expect(e.deficiencies.map(d => d.id).sort()).toEqual([
      'C1-E1/D1/C1-E1-F2', 'C1-E1/D2/PG-0101', 'C1-E1/D3/SF-LAL-0101A+SF-ZA-0101', 'C1-E1/D6', 'C1-E1/D7/SF-LAL-0101A', 'C1-E1/D7/SF-ZA-0101',
    ])
    expect(e.deficiencies.find(d => d.code === 'D6')!.detail).toContain('even if every pending layer')
    expect(e.adequacy).toBe('inadequate')
  })

  it('applies engineer revisions of single checks', () => {
    const revised = ep(run(analysis(), [event(itemKey.layer('C1-E1', 'SF-LAL-0101A'), 'revise', { reliability: 'pass', auditability: 'pass' })]), 'C1-E1')
    expect(layer(revised, 'SF-LAL-0101A').status).toBe('qualified')
    expect(revised.R1!.credits).toBe(2)
    const reset = ep(run(analysis(), [
      event(itemKey.layer('C1-E1', 'SF-LAL-0101A'), 'revise', { reliability: 'pass', auditability: 'pass' }),
      event(itemKey.layer('C1-E1', 'SF-LAL-0101A'), 'revise', { reliability: null }),
    ]), 'C1-E1')
    expect(layer(reset, 'SF-LAL-0101A').status).toBe('unverified')
  })
})

describe('proposals', () => {
  const actions = [
    action({}),
    action({ action_id: 'C1-E1-A2', strategy: 'modify_existing_function', existing_ids: ['IS-10'] }),
    action({ action_id: 'C1-E1-A3', ipl_type: null, effect_on: 'consequence', strategy: 'add_mitigative_function' }),
  ]

  it('never change R1 or R1p, and count in R2 only when independent and acting on frequency', () => {
    const e = ep(run(analysis({ actions })), 'C1-E1')
    expect([e.R1!.credits, e.R1p!.credits]).toEqual([1, 2])
    expect(e.actions.map(a => a.counted)).toEqual([true, false, false])
    expect(e.actions[1]!.note).toContain('IS-10')
    expect(e.actions[2]!.note).toContain('consequence reassessment')
    expect(e.R2).toEqual({ credits: 4, f: 5, r: 4 })
  })

  it('drop out of R2 when the reviewer rejects them', () => {
    const e = ep(run(analysis({ actions }), [event(itemKey.action('C1-E1-A1'), 'reject')]), 'C1-E1')
    expect(e.actions[0]!.status).toBe('rejected')
    expect(e.R2!.credits).toBe(2)
    expect(proposedOverlay([e]).map(o => o.action_id)).toEqual(['C1-E1-A2', 'C1-E1-A3'])
  })
})

describe('credibility and adequacy', () => {
  it('screens out not-credible scenarios without deficiencies', () => {
    const e = ep(run(analysis({ credibility: 'not_credible' })), 'C1-E1')
    expect([e.adequacy, e.deficiencies.length]).toEqual(['not_credible', 0])
  })

  it('keeps missing evidence apart from non-credibility', () => {
    expect(ep(run(analysis({ credibility: 'insufficient_evidence' })), 'C1-E1').adequacy).toBe('undetermined')
  })

  it('is adequate when qualified layers reach III, undetermined when only pending ones do', () => {
    const qualified = [assess('C1-E1', 'SF-IS10', 'sif_sil2'), assess('C1-E1', 'SF-LAL-0101A', 'operator_response')]
    expect(ep(run(analysis({ assessments: qualified })), 'C1-E1').adequacy).toBe('adequate') // 3 credits → F-4 × C-4 → III
    const pending = [assess('C1-E1', 'SF-IS10', 'sif_sil2', { auditability: 'unknown' }), assess('C1-E1', 'SF-LAL-0101A', 'operator_response', { auditability: 'unknown' })]
    const e = ep(run(analysis({ assessments: pending })), 'C1-E1')
    expect([e.adequacy, e.R1!.r, e.R1p!.r]).toEqual(['undetermined', 1, 3])
  })

  it('does not call the node adequate before every deviation is analysed', () => {
    const qualified = [assess('C1-E1', 'SF-IS10', 'sif_sil2'), assess('C1-E1', 'SF-LAL-0101A', 'operator_response'), assess('C2-E1', 'SF-IS09', 'sif_sil2')]
    const evals = run(analysis({ assessments: qualified }), [event(itemKey.dependency('C2-E1', 'SF-IS09', 'cause'), 'revise', { independent: true })])
    expect(evals.map(e => e.adequacy)).toEqual(['adequate', 'inadequate']) // C2: 2 credits → F-3 × C-4 → II, nothing pending
    expect(summarizeAssessment(evals.slice(0, 1), 9, 1).decision).toBe('undetermined')
    expect(summarizeAssessment(evals.slice(0, 1), 1, 1).decision).toBe('adequate')
    expect(summarizeAssessment(run(analysis()), 1, 1).decision).toBe('inadequate')
  })

  it('sends P6 only the deficiencies of endpoints that are not adequate', () => {
    const payload = deficiencyPayload(run(analysis()))
    expect(new Set(payload.map(d => d.endpoint_id))).toEqual(new Set(['C1-E1', 'C2-E1']))
    expect(payload[0]!.risk.R1).toEqual({ credits: 1, f: 2, r: 2 })
  })
})

describe('stepPath', () => {
  const pid: PidFile = load('json_pid/01_naphtha_tank_extraction.json')
  const g = buildGraph(pid, safety)

  it('finds the documented graph path behind a step, expanding sections to their members', () => {
    expect(stepPath(g, safety, { from_id: 'COND-AMBIENT', to_id: '100T-01' })).toEqual(['COND-AMBIENT', '100T-01'])
    expect(stepPath(g, safety, { from_id: 'SEC-INLET', to_id: '100T-01' })).toEqual(['100-P-021-A2-1F-4', '100T-01'])
    expect(stepPath(g, safety, { from_id: 'HUM-OPERATOR', to_id: '100T-01' })).toBeNull()
  })
})
