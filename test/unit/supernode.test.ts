import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildGraph, buildScenario, causeDeviations, flowRanks, mainFlow, makeResolver, type PidFile, type PosFile,
} from '../../app/utils/supernode'

const load = (path: string) => JSON.parse(readFileSync(new URL(`../../backend/static/${path}`, import.meta.url), 'utf-8'))
const pid: PidFile = load('json_pid/01_naphtha_tank_extraction.json')
const pos: PosFile = load('json_pos/01_casue_consequence_naphtha_tank_connection.json')
const g = buildGraph(pid)
const resolve = makeResolver(g.nodes)
const SUPER = 'NODE-100T-01-100P-01AB'
const HPU = 'Hydrogen Production Unit HPU'

describe('buildGraph', () => {
  it('creates supernode, equipment, line and boundary nodes', () => {
    const kinds = (k: string) => g.nodes.filter(n => n.kind === k).map(n => n.id)
    expect(kinds('supernode')).toEqual([SUPER])
    expect(kinds('equipment')).toEqual(['100T-01', '100P-01A', '100P-01B', 'AC-0101'])
    expect(kinds('line')).toHaveLength(13)
    expect(kinds('interlock')).toEqual(['IS-09', 'IS-10', 'IS-28'])
    expect(kinds('boundary')).toContain(HPU)
  })

  it('hangs valves/instruments off the line they sit on', () => {
    expect(g.adj.get('UV-0102-IN')).toContainEqual({ id: '100-P-021-A2-1F-4', kind: 'tag' })
    expect(g.adj.get('IS-10')!.filter(e => e.kind === 'tag')).toHaveLength(4)
  })

  it('attaches tags missing from every line by their location, else to the supernode', () => {
    expect(g.adj.get('LSHH-0102')).toEqual([{ id: '100T-01', kind: 'tag' }])
    expect(g.adj.get('HS-0101A')).toEqual([{ id: SUPER, kind: 'contains' }])
  })
})

describe('makeResolver', () => {
  it('expands A/B pairs and prefers the longest tag', () => {
    expect(resolve('100P-01A/B').sort()).toEqual(['100P-01A', '100P-01B'])
    expect(resolve('PG-0101A / PG-0101B').sort()).toEqual(['PG-0101A', 'PG-0101B'])
    expect(resolve('UV-0102-IN / inlet shutdown valve assembly')).toEqual(['UV-0102-IN'])
  })

  it('matches boundary names and their aliases', () => {
    expect(resolve('Existing Process Unit / B-L')).toEqual(['Existing Process Unit / B-L'])
    expect(resolve('HPU feed line')).toEqual([HPU])
    expect(resolve('Inlet line')).toEqual([])
  })
})

describe('buildScenario', () => {
  const NO_FLOW = 'No Flow / Less Flow'

  it('traces the red consequence path along the flow lines', () => {
    const s = buildScenario(g, resolve, pos, NO_FLOW, 'UV-0102-IN', false)!
    expect(s.causes.map(c => c.cause_id)).toEqual(['FLOW-NL-C02'])
    for (const id of ['100-P-021-A2-1F-4', '100T-01', '100P-01A', '100P-01B', HPU]) expect(s.red.nodes).toContain(id)
    expect(s.red.nodes).not.toContain(SUPER)
    expect(s.red.links[0]).toEqual({ source: 'UV-0102-IN', target: '100-P-021-A2-1F-4' })
    expect(s.blue.nodes.size).toBe(0)
  })

  it('adds blue safeguard paths only in the safeguard mode', () => {
    const s = buildScenario(g, resolve, pos, NO_FLOW, 'UV-0102-IN', true)!
    expect(s.safeguards.map(x => x.tag)).toEqual(expect.arrayContaining(['LSLL-0102', 'IS-10']))
    expect(s.blue.nodes).toContain('IS-10')
    expect(s.blue.links).toContainEqual({ source: 'IS-10', target: '100-P-022-A2-1F-6' })
  })

  it('animates nothing when the node is not a cause source in that deviation', () => {
    const s = buildScenario(g, resolve, pos, 'High Pressure', 'UV-0102-IN', true)!
    expect(s.causes).toEqual([])
    expect(s.red.nodes.size).toBe(0)
  })

  it('lists every deviation a node is a cause source in', () => {
    expect(causeDeviations(pos, resolve, '100P-01A')).toHaveLength(8)
  })
})

describe('mainFlow', () => {
  it('keeps only the stream from the SuperNode start to its end', () => {
    const f = mainFlow(g)
    expect(f.starts).toEqual(['Existing Process Unit / B-L'])
    expect(f.ends).toEqual([HPU])
    expect([...f.nodes].sort()).toEqual([
      '100-P-021-A2-1F-4', '100-P-022-A2-1F-6', '100-P-024-A2-1F-6', '100-P-025-A2-1F-4-A', '100-P-026-A2-1F-4-B',
      '100P-01A', '100P-01B', '100T-01', 'Existing Process Unit / B-L', HPU,
    ].sort())
  })
})

describe('flowRanks', () => {
  it('orders the main stream left to right', () => {
    const r = flowRanks(g)
    const order = ['Existing Process Unit / B-L', '100T-01', '100P-01A', HPU].map(id => r.get(id)!)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})
