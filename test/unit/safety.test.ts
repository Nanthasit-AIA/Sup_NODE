import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { expandIds, functionComponents, graphAliases, missingEvidence, reconcile, type SafetyLayer } from '../../app/utils/safety'
import { buildGraph, buildScenario, makeResolver, pathBetween, type PidFile, type PosFile } from '../../app/utils/supernode'

const load = (path: string) => JSON.parse(readFileSync(new URL(`../../backend/static/${path}`, import.meta.url), 'utf-8'))
const pid: PidFile = load('json_pid/01_naphtha_tank_extraction.json')
const pos: PosFile = load('json_pos/01_casue_consequence_naphtha_tank_connection.json')
const safety: SafetyLayer = load('json_safety/01_safety.json')
const g = buildGraph(pid, safety)
const resolve = makeResolver(g.nodes, graphAliases(safety))

describe('safety layer references', () => {
  it('points only at nodes that exist in the graph', () => {
    const ids = [
      ...safety.elements.flatMap(e => [...(e.members ?? []), ...(e.acts_on ?? [])]),
      ...safety.safety_functions.flatMap(f => [...functionComponents(f), ...f.signals.flat(), ...expandIds(safety, f.protects)]),
      ...safety.aliases.flatMap(a => expandIds(safety, a.ids)),
      ...safety.drawing.flatMap(d => d.pid_ids),
    ].filter(id => id !== 'HUM-OPERATOR') // the operator is a shared component, not a graph node
    expect(ids.filter(id => !g.byId.has(id))).toEqual([])
  })

  it('keeps signal links inside each function', () => {
    for (const f of safety.safety_functions) {
      const parts = new Set([...functionComponents(f), 'LT-0101', 'LT-0102']) // local indicators hang off the transmitters
      expect(f.signals.flat().filter(id => !parts.has(id)), f.id).toEqual([])
    }
  })
})

describe('graph with the safety layer', () => {
  it('adds condition nodes acting on the process', () => {
    expect(g.byId.get('COND-EXT-FIRE')?.kind).toBe('condition')
    expect(g.adj.get('COND-EXT-FIRE')).toContainEqual({ id: '100T-01', kind: 'acts_on' })
    expect(g.byId.has('HUM-OPERATOR')).toBe(false) // acts on nothing directly
  })

  it('follows the IS-09 signal path from the transmitter to the inlet valve', () => {
    expect(pathBetween(g, 'LT-0102', 'UV-0102-IN', ['signal'])).toEqual(['LT-0102', 'LSHH-0102', 'IS-09', 'UY-0101', 'UV-0102-IN'])
    expect(pathBetween(buildGraph(pid), 'LT-0102', 'UV-0102-IN', ['signal'])).toBeNull()
  })

  it('anchors every json-pos cause and target once the aliases are added', () => {
    const devs = pos.cause_consequence_analysis_no_safeguards
    expect(devs.flatMap(d => d.possible_causes).filter(c => !resolve(c.cause_source).length)).toEqual([])
    expect(devs.flatMap(d => d.main_consequence_targets).filter(t => !resolve(t).length)).toEqual([])
    expect(pos.related_ipls_and_safeguards.flatMap(s => s.protected_or_monitored_targets).filter(t => !resolve(t).length)).toEqual([])
    expect(resolve('External environment / fire exposure')).toEqual(['COND-EXT-FIRE', 'COND-AMBIENT'])
    expect(resolve('Vent/relief system')).toContain('PVV-0102')
  })

  it('traces a red path from an external condition', () => {
    const s = buildScenario(g, resolve, pos, 'High Pressure', 'COND-EXT-FIRE', false)!
    expect(s.causes.map(c => c.cause_id)).toEqual(['PRESS-HIGH-C06'])
    expect(s.red.nodes).toContain('100T-01')
    expect(s.unresolvedTargets).toEqual([])
  })
})

describe('reconcile', () => {
  const findings = reconcile(pid, pos, safety, resolve)
  const of = (kind: string) => findings.filter(f => f.kind === kind)

  it('flags tags that differ from the drawing without changing them', () => {
    expect(of('renamed').map(f => f.ids)).toEqual([['UV-0102-IN'], ['UV-0102-OUT'], ['LAH-0102', 'LAL-0102'], ['LSHH-0102', 'LSLL-0102'], ['TAH-0101', 'TAL-0101']])
    expect(pid.instruments.some(i => i.id === 'LAH-0102')).toBe(true)
  })

  it('lists extraction-assigned ids, drawing items json-pid lacks, and source references', () => {
    expect(of('assigned_id').flatMap(f => f.ids)).toContain('CV-100P-01A-DISCH')
    expect(of('missing_in_pid').map(f => f.drawn)).toEqual(['check valve on 100-P-027 to HPU (no tag)', 'suction strainers on 100-P-022 / 100-P-024 (no tags)'])
    expect(of('not_on_drawing')).toEqual([])
    expect(of('reference_note')[0]).toMatchObject({ ids: ['UV-0102-IN'], drawn: 'UV-0101' })
    expect(of('unresolved_text')).toEqual([])
  })

  it('reports json-pos names the resolver cannot place without aliases', () => {
    const bare = reconcile(pid, pos, safety, makeResolver(buildGraph(pid).nodes))
    expect(bare.filter(f => f.kind === 'unresolved_text').map(f => f.drawn)).toContain('Vent/relief system')
  })

  it('lists missing evidence for every function', () => {
    expect(missingEvidence(safety).find(f => f.id === 'SF-IS09')?.missing).toEqual(['setpoint', 'response_time', 'logic_solver', 'sil_or_pfd_basis', 'proof_test'])
  })
})
