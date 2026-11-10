/**
 * LOPA arithmetic for the backward IPL review (SCG HAZOP-LOPA guideline SD-PS-G-0209):
 * initiating frequency × 0.1^credits → frequency category F-1..F-5 → risk matrix rank I..IV.
 * The AI only supplies judgements (S, initiating event, IPL types, I/E/A); all numbers come from here.
 */

export type Rules = {
  risk_matrix: { rows: number[][] }
  frequency_categories: { f: number; label: string; range: string }[]
  consequence_categories: { c: number; safety: string; environment: string; property: string }[]
  risk_ranks: { r: number; label: string; name: string; action: string }[]
  initiating_events: { id: string; label: string; per_year: number }[]
  ipl_types: { id: string; label: string; group: string; credit: number }[]
}
export type ExistingIpl = {
  tags: string[]; description: string; ipl_type: string
  independent: boolean; effective: boolean; auditable: boolean; reason: string
}
export type ProposedIpl = {
  tags: string[]; description: string; ipl_type: string
  reasoning?: string // why it is needed and why this IPL type
  process_benefit?: string // which part of the process it protects, which consequence it prevents
  protected_targets?: string[]
  rationale?: string // reviews cached before reasoning / process_benefit were split out
}
export type CauseReview = {
  cause_id: string; severity: number; severity_reason: string
  initiating_event: string; initiating_event_reason: string
  existing_ipls: ExistingIpl[]; other_safeguards: string[]; proposed_ipls: ProposedIpl[]
  reference_row: string | null; verdict: string
}
export type DeviationReview = { generated_at: string; seconds: number; model: string; causes: CauseReview[] }
export type ReferenceRow = {
  id: string; parameter: string; deviation: string; cause: string; consequence: string
  S: number | null; L: number | null; R: number | null
  ipls: { text: string; credit: number }[]; safeguards: string
  S_after: number | null; L_after: number | null; R_after: number | null; recommendation: string
}
export type LopaData = {
  rules: Rules; reference: ReferenceRow[]; review: { deviations: Record<string, DeviationReview> }
  running: string[]; errors: Record<string, string>; model: string
}

/** Engineer overrides on top of the AI review (absent = keep the AI value). */
export type Edit = {
  severity?: number
  initiatingEvent?: string
  existing?: Record<number, boolean> // credited?
  proposed?: Record<number, boolean> // included?
}

export const ROMAN = ['', 'I', 'II', 'III', 'IV']
/** Colours of the company risk matrix (Appendix G). */
export const RISK_STYLE = ['', 'bg-[#ef4444] text-white', 'bg-[#f5b400] text-black', 'bg-[#22c3ee] text-black', 'bg-[#86e046] text-black']
export const isGap = (r: number) => r <= 2 // I or II: recommendations required

/** Frequency category from log10(events per year): F-1 ≥ 1e-1, F-2 ≥ 1e-2, … F-5 < 1e-4. */
export function fCategory(log10PerYear: number): number {
  const e = Math.round(log10PerYear * 1e6) / 1e6
  return e >= -1 ? 1 : Math.min(5, Math.ceil(-e))
}

export function riskRank(rules: Rules, f: number, s: number): number {
  return rules.risk_matrix.rows[f - 1]![s - 1]!
}

export type Stage = { credits: number; f: number; r: number }
export type Evaluated = {
  severity: number
  initiatingEvent: Rules['initiating_events'][number]
  existing: { ipl: ExistingIpl; credit: number; valid: boolean; credited: boolean }[]
  proposed: { ipl: ProposedIpl; credit: number; included: boolean; alone: Stage | null }[] // alone = existing IPLs + this one
  // null when the initiating event is screened out as not credible
  unmitigated: Stage | null
  current: Stage | null // with credited existing IPLs
  improved: Stage | null // plus included AI proposals
}

export function evaluate(rules: Rules, review: CauseReview, edit: Edit = {}): Evaluated {
  const creditOf = (type: string) => rules.ipl_types.find(t => t.id === type)?.credit ?? 0
  const severity = edit.severity ?? review.severity
  const initiatingEvent = rules.initiating_events.find(e => e.id === (edit.initiatingEvent ?? review.initiating_event))!
  const existing = review.existing_ipls.map((ipl, i) => {
    const valid = ipl.independent && ipl.effective && ipl.auditable
    return { ipl, credit: creditOf(ipl.ipl_type), valid, credited: edit.existing?.[i] ?? valid }
  })
  const base = initiatingEvent.per_year > 0 ? Math.log10(initiatingEvent.per_year) : null
  const stage = (credits: number): Stage | null => {
    if (base === null) return null
    const f = fCategory(base - credits)
    return { credits, f, r: riskRank(rules, f, severity) }
  }
  const existingCredits = existing.reduce((sum, e) => sum + (e.credited ? e.credit : 0), 0)
  const proposed = review.proposed_ipls.map((ipl, i) => {
    const credit = creditOf(ipl.ipl_type)
    return { ipl, credit, included: edit.proposed?.[i] ?? true, alone: stage(existingCredits + credit) }
  })
  const proposedCredits = proposed.reduce((sum, p) => sum + (p.included ? p.credit : 0), 0)
  return {
    severity, initiatingEvent, existing, proposed,
    unmitigated: stage(0),
    current: stage(existingCredits),
    improved: stage(existingCredits + proposedCredits),
  }
}

/** Node-level answers to "is the protection good / complete / enough after improvement?". */
export function summarize(rows: Evaluated[]) {
  const credible = rows.filter(r => r.unmitigated)
  return {
    reviewed: rows.length,
    screened: rows.length - credible.length,
    credible: credible.length,
    gapsUnmitigated: credible.filter(r => isGap(r.unmitigated!.r)).length,
    gapsCurrent: credible.filter(r => isGap(r.current!.r)).length,
    gapsImproved: credible.filter(r => isGap(r.improved!.r)).length,
    // scenarios that need protection (unmitigated I/II) but have no credited IPL at all
    unprotected: credible.filter(r => isGap(r.unmitigated!.r) && r.current!.credits === 0).length,
    // safeguards someone might assume are IPLs but fail independent / effective / auditable
    rejectedSafeguards: rows.reduce((n, r) => n + r.existing.filter(e => !e.valid).length, 0),
    proposals: rows.reduce((n, r) => n + r.proposed.filter(p => p.included).length, 0),
  }
}

/** Does the engineer worksheet's recorded risk match the matrix for its own S and L? */
export function referenceMismatch(rules: Rules, row: ReferenceRow): string | null {
  const check = (s: number | null, l: number | null, r: number | null, label: string) =>
    s && l && r && riskRank(rules, l, s) !== r ? `${label}: S${s}·L${l} gives ${ROMAN[riskRank(rules, l, s)]} in the matrix, worksheet says ${ROMAN[r]}` : null
  return check(row.S, row.L, row.R, 'Before IPLs') ?? check(row.S_after, row.L_after, row.R_after, 'After IPLs')
}
