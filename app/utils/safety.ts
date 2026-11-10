/**
 * Safety enrichment layer (backend/static/json_safety): systems and sections, external conditions,
 * safety functions with their signal paths, and the tag list read off the P&ID drawing.
 * It sits on top of json-pid / json-pos and never rewrites them; the reconciliation below only reports.
 */
import type { PidFile, PosFile, Resolver } from './supernode'

export type SafetyElement = {
  id: string
  kind: 'system' | 'section' | 'external_condition' | 'human_action' | 'process_phenomenon'
  label: string
  members?: string[] // system / section: the graph nodes it groups
  acts_on?: string[] // condition: the graph nodes it acts on
  source_refs: string[]
}
export type SafetyFunction = {
  id: string; kind: string; label: string
  sensors: string[]; logic: string[]; final_elements: string[]; utilities: string[]; human: string[]
  signals: [string, string][]
  protects: string[]; action: string; drawing_ref: string
  documented: Record<string, string>
  evidence: Record<string, string | null> // null = not available
}
export type DrawingItem = { page: number; tag: string | null; drawn_as?: string; functions?: string[]; pid_ids: string[]; note?: string }
export type SafetyLayer = {
  case: string; version: string; status_note: string
  elements: SafetyElement[]
  aliases: { text: string; ids: string[] }[]
  safety_functions: SafetyFunction[]
  drawing: DrawingItem[]
}

/** Graph node ids behind enrichment ids: a system or section stands for its members. */
export function expandIds(safety: SafetyLayer | null | undefined, ids: string[]): string[] {
  const byId = new Map(safety?.elements.map(e => [e.id, e]))
  return [...new Set(ids.flatMap(id => byId.get(id)?.members ?? [id]))]
}

/** json-pos wording → graph node ids, for makeResolver. */
export function graphAliases(safety: SafetyLayer | null | undefined) {
  return (safety?.aliases ?? []).map(a => ({ text: a.text, ids: expandIds(safety, a.ids) }))
}

/** Every element a safety function depends on: sensors, logic, final elements, utilities and people. */
export function functionComponents(f: SafetyFunction): string[] {
  return [...new Set([...f.sensors, ...f.logic, ...f.final_elements, ...f.utilities, ...f.human])]
}

export type FindingKind = 'renamed' | 'drawing_note' | 'assigned_id' | 'missing_in_pid' | 'not_on_drawing' | 'reference_note' | 'unresolved_text'
export type Finding = { kind: FindingKind; ids: string[]; drawn: string; note: string }

export const FINDING_LABEL: Record<FindingKind, string> = {
  renamed: 'Tag differs from the drawing',
  drawing_note: 'Drawing inconsistency',
  assigned_id: 'ID assigned by the extraction (no tag on the drawing)',
  missing_in_pid: 'On the drawing, missing from json-pid',
  not_on_drawing: 'In json-pid, not found on the drawing',
  reference_note: 'Tag referenced differently in the source data',
  unresolved_text: 'json-pos name that matches no graph element',
}

/** Cross-checks json-pid, json-pos and the drawing tag list. Reports differences; changes nothing. */
export function reconcile(pid: PidFile, pos: PosFile | null, safety: SafetyLayer, resolve: Resolver): Finding[] {
  const out: Finding[] = []
  const drawnIds = new Set(safety.drawing.flatMap(d => d.pid_ids))
  for (const d of safety.drawing) {
    const drawn = [d.tag ?? d.drawn_as, d.functions?.length && `(${d.functions.join(', ')})`, d.tag && d.drawn_as && `· ${d.drawn_as}`]
      .filter(Boolean).join(' ')
    if (!d.pid_ids.length) out.push({ kind: 'missing_in_pid', ids: [], drawn, note: d.note ?? '' })
    else if (!d.tag) out.push({ kind: 'assigned_id', ids: d.pid_ids, drawn, note: d.note ?? '' })
    else if (d.pid_ids.some(id => id !== d.tag)) out.push({ kind: 'renamed', ids: d.pid_ids.filter(id => id !== d.tag), drawn, note: d.note ?? '' })
    else if (d.note) out.push({ kind: 'drawing_note', ids: d.pid_ids, drawn, note: d.note })
  }
  for (const id of [...pid.equipment, ...pid.valves, ...pid.instruments].map(x => x.id)) {
    if (!drawnIds.has(id)) out.push({ kind: 'not_on_drawing', ids: [id], drawn: '', note: '' })
  }
  for (const r of pid.connections.flatMap(c => c.deviation_reasoning ?? [])) {
    const src = r.cause_source as PidReasoningSource
    if (src.user_referenced_tag && src.user_referenced_tag !== src.source_tag) {
      out.push({ kind: 'reference_note', ids: [src.source_tag], drawn: src.user_referenced_tag, note: src.source_tag_note ?? '' })
    }
  }
  const texts = pos
    ? [
        ...pos.cause_consequence_analysis_no_safeguards.flatMap(d => [...d.possible_causes.map(c => c.cause_source), ...d.main_consequence_targets]),
        ...pos.related_ipls_and_safeguards.flatMap(s => s.protected_or_monitored_targets),
      ]
    : []
  for (const t of new Set(texts)) if (!resolve(t).length) out.push({ kind: 'unresolved_text', ids: [], drawn: t, note: '' })
  return out
}
type PidReasoningSource = { source_tag: string; user_referenced_tag?: string; source_tag_note?: string }

/** Evidence fields still missing per safety function. */
export function missingEvidence(safety: SafetyLayer): { id: string; label: string; missing: string[] }[] {
  return safety.safety_functions
    .map(f => ({ id: f.id, label: f.label, missing: Object.entries(f.evidence).filter(([, v]) => v === null).map(([k]) => k) }))
    .filter(f => f.missing.length)
}
