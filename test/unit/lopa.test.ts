import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluate, fCategory, referenceMismatch, riskRank, summarize, type CauseReview, type ReferenceRow, type Rules } from '../../app/utils/lopa'

const load = (path: string) => JSON.parse(readFileSync(new URL(`../../backend/static/${path}`, import.meta.url), 'utf-8'))
const rules: Rules = load('lopa_rules.json')
const worksheet: ReferenceRow[] = load('json_ref/01_hazop_worksheet.json').rows

const review = (over: Partial<CauseReview> = {}): CauseReview => ({
  cause_id: 'C1', severity: 3, severity_reason: '', initiating_event: 'valve', initiating_event_reason: '',
  existing_ipls: [], other_safeguards: [], proposed_ipls: [], reference_row: null, verdict: '', ...over,
})
const ipl = (ipl_type: string, ok = true) => ({ tags: [], description: '', ipl_type, independent: ok, effective: ok, auditable: ok, reason: '' })

describe('fCategory', () => {
  it('maps log10 frequency to F-1..F-5 at the decade boundaries', () => {
    expect([0, -1, -1.5, -2, -3, -4, -4.2, -7].map(fCategory)).toEqual([1, 1, 2, 2, 3, 4, 5, 5])
    expect(fCategory(Math.log10(0.1) - 3)).toBe(4) // 1e-4 exactly, despite float error
  })
})

describe('the engineer worksheet follows the same arithmetic', () => {
  // every scored row: L + credits (capped at F-5) and the matrix reproduce the recorded mitigated risk
  for (const row of worksheet.filter(r => r.S && r.L)) {
    it(`${row.id}: ${row.cause.slice(0, 40)}`, () => {
      const credits = row.ipls.reduce((n, i) => n + i.credit, 0)
      const f = Math.min(5, row.L! + credits)
      expect(f).toBe(row.L_after)
      expect(riskRank(rules, f, row.S!)).toBe(row.R_after)
    })
  }

  it('flags the worksheet rows whose unmitigated risk disagrees with the matrix', () => {
    const flagged = worksheet.filter(r => referenceMismatch(rules, r)).map(r => r.id)
    expect(flagged).toEqual(['W10', 'W11']) // S4·L2 is II in the matrix, recorded as I
  })
})

describe('evaluate', () => {
  it('credits only IPLs passing independent / effective / auditable', () => {
    const e = evaluate(rules, review({ existing_ipls: [ipl('operator_response'), ipl('bpcs'), ipl('breather_valve', false)] }))
    expect(e.unmitigated).toEqual({ credits: 0, f: 1, r: 2 }) // UV closed: S3 F-1 → II (worksheet W1)
    expect(e.current).toEqual({ credits: 2, f: 3, r: 3 }) // LAL + operator, IS-10 → III
  })

  it('adds AI proposals and applies engineer overrides', () => {
    const r = review({ severity: 4, existing_ipls: [ipl('bpcs')], proposed_ipls: [{ tags: [], description: '', ipl_type: 'overflow_free', rationale: '' }] })
    expect(evaluate(rules, r).current!.r).toBe(2) // overfill W6-like: S4, 1 credit → F-2 → II
    expect(evaluate(rules, r).improved).toEqual({ credits: 4, f: 5, r: 4 })
    expect(evaluate(rules, r, { proposed: { 0: false } }).improved!.r).toBe(2)
    expect(evaluate(rules, r, { severity: 5, existing: { 0: false } }).current!.r).toBe(1)
  })

  it('gives each proposal its own effect on top of the existing IPLs', () => {
    const proposal = (ipl_type: string) => ({ tags: [], description: '', ipl_type })
    const e = evaluate(rules, review({ severity: 4, existing_ipls: [ipl('bpcs')], proposed_ipls: [proposal('operator_response'), proposal('overflow_free')] }))
    expect(e.current!.r).toBe(2) // S4, 1 credit → F-2 → II
    expect(e.proposed.map(p => p.alone!.r)).toEqual([2, 4]) // +1 → F-3, still II at C-4; +3 → F-5 → IV
    expect(e.improved!.r).toBe(4)
  })

  it('a weekly operator task stays F-1 after one credit (1 → 0.1 per year)', () => {
    expect(evaluate(rules, review({ initiating_event: 'operator_weekly', existing_ipls: [ipl('bpcs')] })).current!.f).toBe(1)
  })

  it('screens out non-credible initiating events', () => {
    const e = evaluate(rules, review({ initiating_event: 'not_credible' }))
    expect([e.unmitigated, e.current, e.improved]).toEqual([null, null, null])
    expect(summarize([e])).toMatchObject({ reviewed: 1, screened: 1, credible: 0 })
  })
})
