/**
 * SuperNode knowledge graph built from a json-pid file, plus the
 * cause → consequence (red) and safeguard (blue) traces read from json-pos.
 * An optional safety layer (json_safety) adds condition nodes and signal links.
 */
import type { SafetyLayer } from './safety'

// ---- json-pid / json-pos shapes (only the fields the UI uses) ----

export type PidLine = {
  line_id: string; from_id: string; to_id: string
  valves: string[]; instruments: string[]; flow_direction: string; context: string
}
export type PidReasoning = {
  deviation: string
  cause_source: { source_tag: string; cause_type: string; cause_context: string }
  propagation_path: { step: number; affected_section: string; effect: string }[]
  hazop_reasoning_context: string
}
export type PidConnection = {
  line_id: string; node: string; node_boundary: string; flow_direction: string; context: string
  included_equipment: string[]; included_lines: string[]; valves: string[]; instruments: string[]
  deviation_reasoning?: PidReasoning[]
}
export type PidFile = {
  process_description?: string
  intention?: string
  equipment: { id: string; name: string; type: string; context: string }[]
  valves: { id: string; type: string; location: string; context: string }[]
  instruments: { id: string; function: string; location: string; context: string }[]
  utility_lines: { utility_type: string; valves: string[]; flow_direction: string; context: string }[]
  connections: PidConnection[]
  line_level_connections: PidLine[]
}
export type PosCause = {
  cause_id: string; cause_source: string; cause: string; local_effect: string; propagated_consequence: string
}
export type PosDeviation = {
  deviation: string; parameter: string; guide_word: string
  possible_causes: PosCause[]; main_consequence_targets: string[]
}
export type PosSafeguard = {
  tag: string; type: string; related_deviations: string[]; related_cause_consequence_logic: string
  protected_or_monitored_targets: string[]; classification_note: string
}
export type PosFile = {
  cause_consequence_analysis_no_safeguards: PosDeviation[]
  related_ipls_and_safeguards: PosSafeguard[]
}
export type CaseData = { id: string; name: string; pid: PidFile; pos: PosFile | null; safety: SafetyLayer | null }

// ---- graph ----

export type NodeKind = 'supernode' | 'equipment' | 'boundary' | 'line' | 'valve' | 'instrument' | 'interlock' | 'utility' | 'condition'
export type LinkKind = 'contains' | 'flow' | 'tag' | 'utility' | 'acts_on' | 'signal'
export const KIND_LABEL: Record<NodeKind, string> = {
  supernode: 'SuperNode', equipment: 'Equipment', boundary: 'Boundary', line: 'Line',
  valve: 'Valve', instrument: 'Instrument', interlock: 'Interlock', utility: 'Utility', condition: 'Condition',
}
/**
 * Category colours. The four hues are validated (dataviz palette, all-pairs) against the
 * reserved highlight colours RED/BLUE; the rest are neutrals told apart by size and layer.
 * Condition (external events, human actions) takes the palette's remaining magenta slot.
 */
export const KIND_COLOR: Record<NodeKind, string> = {
  supernode: '#27272a', equipment: '#eda100', boundary: '#c3c2b7', line: '#52514e',
  valve: '#1baf7a', instrument: '#4a3aa7', interlock: '#008300', utility: '#898781', condition: '#e87ba4',
}
export const RED = '#e34948'
export const BLUE = '#2a78d6'
export type GNode = { id: string; kind: NodeKind; label: string; record?: Record<string, unknown> }
export type GLink = { source: string; target: string; kind: LinkKind }
export type Graph = {
  nodes: GNode[]
  links: GLink[]
  byId: Map<string, GNode>
  adj: Map<string, { id: string; kind: LinkKind }[]>
}
export type Trace = { nodes: Set<string>; links: { source: string; target: string }[] }
export type Resolver = (text: string) => string[]

const TAG_KINDS: NodeKind[] = ['valve', 'instrument', 'interlock']

/** "100-P-021-A2-1F-4" → "P-021" */
export function shortLineLabel(lineId: string): string {
  return lineId.match(/^\d+-([A-Z]+-\d+)/)?.[1] ?? lineId
}

export function buildGraph(pid: PidFile, safety?: SafetyLayer | null): Graph {
  const byId = new Map<string, GNode>()
  const links: GLink[] = []
  const add = (id: string, kind: NodeKind, label = id, record?: Record<string, unknown>) => {
    if (!byId.has(id)) byId.set(id, { id, kind, label, record })
  }

  for (const e of pid.equipment) add(e.id, 'equipment', e.id, e)
  for (const v of pid.valves) add(v.id, 'valve', v.id, v)
  for (const i of pid.instruments) add(i.id, /interlock/i.test(i.function) ? 'interlock' : 'instrument', i.id, i)
  for (const c of pid.connections) add(c.line_id, 'supernode', c.line_id, c)

  // Each P&ID line is a small node between its endpoints; its valves/instruments hang off it.
  const onLine = new Set<string>()
  for (const l of pid.line_level_connections) {
    add(l.line_id, 'line', shortLineLabel(l.line_id), l)
    add(l.from_id, 'boundary')
    add(l.to_id, 'boundary')
    links.push({ source: l.from_id, target: l.line_id, kind: 'flow' }, { source: l.line_id, target: l.to_id, kind: 'flow' })
    for (const [tags, kind] of [[l.valves, 'valve'], [l.instruments, 'instrument']] as const) {
      for (const tag of tags) {
        add(tag, kind)
        onLine.add(tag)
        links.push({ source: l.line_id, target: tag, kind: 'tag' })
      }
    }
  }

  for (const c of pid.connections) {
    for (const eq of c.included_equipment) {
      add(eq, 'equipment')
      links.push({ source: c.line_id, target: eq, kind: 'contains' })
    }
  }

  // Tags not on any line: hang them on the equipment named in their location, else on their SuperNode.
  const resolveNow = makeResolver([...byId.values()])
  for (const n of byId.values()) {
    if (!TAG_KINDS.includes(n.kind) || onLine.has(n.id)) continue
    const host = resolveNow(String(n.record?.location ?? '')).find(id => byId.get(id)?.kind === 'equipment')
    const superNode = pid.connections.find(c => c.valves.includes(n.id) || c.instruments.includes(n.id)) ?? pid.connections[0]
    if (host) links.push({ source: host, target: n.id, kind: 'tag' })
    else if (superNode) links.push({ source: superNode.line_id, target: n.id, kind: 'contains' })
  }

  for (const u of pid.utility_lines) {
    const id = `utility:${u.utility_type}`
    add(id, 'utility', u.utility_type, u)
    for (const v of u.valves) {
      add(v, 'valve')
      links.push({ source: id, target: v, kind: 'utility' })
    }
  }

  // Safety layer: conditions (fire, ambient, operator line-up, …) act on process nodes; safety functions add signal paths.
  for (const e of safety?.elements ?? []) {
    if (!e.acts_on?.length) continue
    add(e.id, 'condition', e.label, e)
    for (const target of e.acts_on) links.push({ source: e.id, target, kind: 'acts_on' })
  }
  const signals = new Set<string>()
  for (const f of safety?.safety_functions ?? []) {
    for (const [source, target] of f.signals) {
      if (signals.has(`${source}→${target}`)) continue
      signals.add(`${source}→${target}`)
      links.push({ source, target, kind: 'signal' })
    }
  }

  const adj = new Map<string, { id: string; kind: LinkKind }[]>()
  for (const l of links) {
    adj.set(l.source, [...(adj.get(l.source) ?? []), { id: l.target, kind: l.kind }])
    adj.set(l.target, [...(adj.get(l.target) ?? []), { id: l.source, kind: l.kind }])
  }
  return { nodes: [...byId.values()], links, byId, adj }
}

// ---- free text → node ids ----

const AB_PAIR = /\b([A-Z0-9]+-\d+)([A-Z])\/([A-Z])\b/g
/** "100P-01A/B" → "100P-01A 100P-01B" */
const expandAB = (s: string) => s.replace(AB_PAIR, '$1$2 $1$3')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "Existing Process Unit / B-L" → ["Existing Process Unit", "B-L"]; "Hydrogen Production Unit HPU" → ["HPU"] */
function boundaryAliases(name: string): string[] {
  const parts = name.split(' / ').map(s => s.trim())
  const last = name.split(' ').at(-1) ?? ''
  return [...(parts.length > 1 ? parts : []), ...(/^[A-Z]{2,}$/.test(last) && last !== name ? [last] : [])]
}

/**
 * Finds which graph nodes a json-pos text field refers to (longest name wins).
 * `aliases` adds named phrases, e.g. "Vent/relief system" → its member nodes.
 */
export function makeResolver(nodes: GNode[], aliases: { text: string; ids: string[] }[] = []): Resolver {
  const names: { re: RegExp; ids: string[]; len: number }[] = []
  const push = (name: string, ids: string[]) => {
    const n = expandAB(name)
    names.push({ re: new RegExp(`(?<![\\w-])${escapeRe(n)}(?![\\w-])`, 'g'), ids, len: n.length })
  }
  for (const n of nodes) {
    if (n.kind === 'supernode' || n.kind === 'utility' || n.kind === 'condition') continue
    push(n.id, [n.id])
    if (n.kind === 'boundary') for (const alias of boundaryAliases(n.id)) push(alias, [n.id])
  }
  for (const a of aliases) push(a.text, a.ids)
  names.sort((a, b) => b.len - a.len)

  return (text) => {
    let rest = expandAB(text)
    const found: string[] = []
    for (const { re, ids } of names) {
      re.lastIndex = 0
      if (!re.test(rest)) continue
      for (const id of ids) if (!found.includes(id)) found.push(id)
      rest = rest.replace(re, ' ')
    }
    return found
  }
}

// ---- path tracing ----

const PASS_THROUGH: NodeKind[] = ['line', 'equipment', 'boundary']
const RED_LINKS: LinkKind[] = ['flow', 'tag', 'acts_on']
const BLUE_LINKS: LinkKind[] = ['flow', 'tag', 'contains']

const emptyTrace = (): Trace => ({ nodes: new Set(), links: [] })

/**
 * Shortest paths from `start` to each goal. Only lines, equipment and boundaries
 * are walked through, so paths follow real piping instead of shortcutting via a
 * shared instrument or the SuperNode hub (a SuperNode is passable only right next to `start`).
 */
export function trace(g: Graph, start: string, goals: string[], linkKinds: LinkKind[]): Trace {
  const parent = new Map<string, string | null>([[start, null]])
  const depth = new Map([[start, 0]])
  const queue = [start]
  while (queue.length) {
    const u = queue.shift()!
    const d = depth.get(u)!
    const kind = g.byId.get(u)?.kind
    if (d > 0 && !(PASS_THROUGH.includes(kind!) || (kind === 'supernode' && d === 1))) continue
    for (const e of g.adj.get(u) ?? []) {
      if (!linkKinds.includes(e.kind) || parent.has(e.id)) continue
      parent.set(e.id, u)
      depth.set(e.id, d + 1)
      queue.push(e.id)
    }
  }

  const result: Trace = { nodes: new Set([start]), links: [] }
  for (const goal of goals) {
    if (!parent.has(goal)) continue
    const path: string[] = []
    for (let x: string | null = goal; x !== null; x = parent.get(x)!) path.unshift(x)
    path.forEach((id, i) => {
      result.nodes.add(id)
      if (i > 0) addLink(result, path[i - 1]!, id)
    })
  }
  return result
}

const PATH_LINKS: LinkKind[] = ['flow', 'tag', 'acts_on', 'signal', 'utility']

/**
 * Shortest chain of graph links between two nodes (by default process, signal and condition
 * links; never through the SuperNode hub), or null. Used to check a stated propagation step.
 */
export function pathBetween(g: Graph, from: string, to: string, kinds = PATH_LINKS, maxHops = 8): string[] | null {
  const parent = new Map<string, string | null>([[from, null]])
  let frontier = [from]
  for (let hop = 0; hop < maxHops && frontier.length && !parent.has(to); hop++) {
    const next: string[] = []
    for (const u of frontier) {
      for (const e of g.adj.get(u) ?? []) {
        if (!kinds.includes(e.kind) || parent.has(e.id) || g.byId.get(e.id)?.kind === 'supernode') continue
        parent.set(e.id, u)
        next.push(e.id)
      }
    }
    frontier = next
  }
  if (!parent.has(to)) return null
  const path: string[] = []
  for (let x: string | null = to; x !== null; x = parent.get(x)!) path.unshift(x)
  return path
}

function addLink(t: Trace, source: string, target: string) {
  if (!t.links.some(l => l.source === source && l.target === target)) t.links.push({ source, target })
}

function mergeTraces(traces: Trace[]): Trace {
  const out = emptyTrace()
  for (const t of traces) {
    t.nodes.forEach(id => out.nodes.add(id))
    t.links.forEach(l => addLink(out, l.source, l.target))
  }
  return out
}

export type Scenario = {
  deviation: PosDeviation
  causes: PosCause[]
  targets: string[]
  unresolvedTargets: string[]
  red: Trace
  safeguards: PosSafeguard[]
  blue: Trace
}

/** What happens when `nodeId` is clicked while `deviationName` is selected. */
export function buildScenario(
  g: Graph, resolve: Resolver, pos: PosFile, deviationName: string, nodeId: string, withSafeguards: boolean,
): Scenario | null {
  const deviation = pos.cause_consequence_analysis_no_safeguards.find(d => d.deviation === deviationName)
  if (!deviation) return null

  const causes = deviation.possible_causes.filter(c => resolve(c.cause_source).includes(nodeId))
  const targets = [...new Set(deviation.main_consequence_targets.flatMap(t => resolve(t)))]
  const unresolvedTargets = deviation.main_consequence_targets.filter(t => resolve(t).length === 0)
  const red = causes.length ? trace(g, nodeId, targets.filter(t => t !== nodeId), RED_LINKS) : emptyTrace()

  const safeguards: PosSafeguard[] = []
  const blueTraces: Trace[] = []
  if (withSafeguards) {
    for (const s of pos.related_ipls_and_safeguards) {
      if (!s.related_deviations.includes(deviation.deviation)) continue
      const tags = resolve(s.tag)
      const isClicked = tags.includes(nodeId)
      const goals = s.protected_or_monitored_targets.flatMap(t => resolve(t)).filter(t => isClicked || red.nodes.has(t))
      if (!isClicked && goals.length === 0) continue
      safeguards.push(s)
      for (const tag of tags) blueTraces.push(trace(g, tag, goals, BLUE_LINKS))
    }
  }
  return { deviation, causes, targets, unresolvedTargets, red, safeguards, blue: mergeTraces(blueTraces) }
}

// ---- lookups for the detail card ----

export function neighborsOf(g: Graph, id: string, kind: NodeKind): GNode[] {
  return (g.adj.get(id) ?? []).map(e => g.byId.get(e.id)!).filter(n => n.kind === kind)
}

/** Deviations in which `id` is a cause source. */
export function causeDeviations(pos: PosFile, resolve: Resolver, id: string): string[] {
  return pos.cause_consequence_analysis_no_safeguards
    .filter(d => d.possible_causes.some(c => resolve(c.cause_source).includes(id)))
    .map(d => d.deviation)
}

export function safeguardEntries(pos: PosFile, resolve: Resolver, id: string): PosSafeguard[] {
  return pos.related_ipls_and_safeguards.filter(s => resolve(s.tag).includes(id))
}

export function pidReasoningFor(pid: PidFile, id: string): PidReasoning[] {
  return pid.connections.flatMap(c => c.deviation_reasoning ?? []).filter(r => r.cause_source.source_tag === id)
}

/** Main process stream: nodes on a directed flow path from a SuperNode's from_id to its to_id. */
export function mainFlow(g: Graph): { nodes: Set<string>; starts: string[]; ends: string[] } {
  const next = new Map<string, string[]>()
  const prev = new Map<string, string[]>()
  for (const l of g.links) {
    if (l.kind !== 'flow') continue
    next.set(l.source, [...(next.get(l.source) ?? []), l.target])
    prev.set(l.target, [...(prev.get(l.target) ?? []), l.source])
  }
  const reach = (start: string, edges: Map<string, string[]>) => {
    const seen = new Set([start])
    const queue = [start]
    while (queue.length) {
      for (const v of edges.get(queue.shift()!) ?? []) {
        if (!seen.has(v)) {
          seen.add(v)
          queue.push(v)
        }
      }
    }
    return seen
  }

  const result = { nodes: new Set<string>(), starts: [] as string[], ends: [] as string[] }
  for (const sn of g.nodes) {
    if (sn.kind !== 'supernode') continue
    const from = String(sn.record?.from_id)
    const to = String(sn.record?.to_id)
    if (!g.byId.has(from) || !g.byId.has(to)) continue
    const toEnd = reach(to, prev)
    for (const id of reach(from, next)) if (toEnd.has(id)) result.nodes.add(id)
    result.starts.push(from)
    result.ends.push(to)
  }
  return result
}

/** Longest-path rank along flow lines (left → right layout hint). */
export function flowRanks(g: Graph): Map<string, number> {
  const out = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const l of g.links) {
    if (l.kind !== 'flow') continue
    out.set(l.source, [...(out.get(l.source) ?? []), l.target])
    indeg.set(l.target, (indeg.get(l.target) ?? 0) + 1)
    if (!indeg.has(l.source)) indeg.set(l.source, 0)
  }
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id)
  const rank = new Map(queue.map(id => [id, 0]))
  while (queue.length) {
    const u = queue.shift()!
    for (const v of out.get(u) ?? []) {
      rank.set(v, Math.max(rank.get(v) ?? 0, rank.get(u)! + 1))
      indeg.set(v, indeg.get(v)! - 1)
      if (indeg.get(v) === 0) queue.push(v)
    }
  }
  return rank
}
