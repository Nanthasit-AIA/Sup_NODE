"""Element IDs and process context shared by every assessment stage.

The graph node set mirrors app/utils/supernode.ts buildGraph (json-pid tags, lines, boundaries,
utilities) plus the json_safety enrichment (systems, sections, conditions, safety functions).
Prompts may only cite these IDs; the structured-output schemas enforce it.
"""
from module.lopa import _process_context


def element_ids(pid, safety):
    ids = [e["id"] for e in pid["equipment"]] + [v["id"] for v in pid["valves"]] + [i["id"] for i in pid["instruments"]]
    for line in pid["line_level_connections"]:
        ids += [line["line_id"], line["from_id"], line["to_id"], *line["valves"], *line["instruments"]]
    for c in pid["connections"]:
        ids += c["included_equipment"]
    for u in pid["utility_lines"]:
        ids += [f"utility:{u['utility_type']}", *u["valves"]]
    ids += [e["id"] for e in safety["elements"]] if safety else []
    return list(dict.fromkeys(ids))


def function_ids(safety):
    return [f["id"] for f in safety["safety_functions"]] if safety else []


def context(pid, safety):
    """Process data the model reasons over: json-pid (compact) and the enrichment layer."""
    out = {"process": _process_context(pid)}
    if safety:
        out["enrichment"] = {
            "note": safety["status_note"],
            "elements": safety["elements"],
            "safety_functions": safety["safety_functions"],
            "drawing_notes": [d for d in safety["drawing"] if d.get("note")],
        }
    return out
