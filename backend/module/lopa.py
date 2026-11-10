"""Backward HAZOP-LOPA review with an LLM.

For each json-pos cause the model judges severity, the initiating event, whether each existing
safeguard is a valid IPL (independent / effective / auditable) and which IPLs are missing.
It never returns credits or risk ranks: those come from static/lopa_rules.json and are computed
in the frontend, so every number stays traceable to the company procedure.
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from openai import OpenAI
from pydantic import BaseModel

RULES = json.loads((Path(__file__).resolve().parent.parent / "static" / "lopa_rules.json").read_text(encoding="utf-8"))

IplType = Literal[tuple(t["id"] for t in RULES["ipl_types"])]
InitiatingEvent = Literal[tuple(e["id"] for e in RULES["initiating_events"])]


class ExistingIpl(BaseModel):
    tags: list[str]
    description: str
    ipl_type: IplType
    independent: bool
    effective: bool
    auditable: bool
    reason: str


class ProposedIpl(BaseModel):
    tags: list[str]
    description: str
    ipl_type: IplType
    reasoning: str  # why: the gap in existing protection and why this IPL type closes it independently
    process_benefit: str  # which part of the process it protects and which consequence it prevents
    protected_targets: list[str]  # equipment / line / boundary tags from the P&ID data


class CauseReview(BaseModel):
    cause_id: str
    severity: Literal[1, 2, 3, 4, 5]
    severity_reason: str
    initiating_event: InitiatingEvent
    initiating_event_reason: str
    existing_ipls: list[ExistingIpl]
    other_safeguards: list[str]
    proposed_ipls: list[ProposedIpl]
    reference_row: str | None
    verdict: str


class DeviationReview(BaseModel):
    causes: list[CauseReview]


SYSTEM = """You are a senior process-safety engineer running a HAZOP-LOPA review that follows the SCG Chemicals HAZOP-LOPA guideline (SD-PS-G-0209). Think BACKWARD: start from each cause and its worst credible consequence ignoring all safeguards, then check whether the existing protection layers are valid IPLs and sufficient, and if not, propose the missing IPLs.

Rules:
1. Severity S (C-1..C-5): rate the ultimate consequence ignoring all safeguards, using the consequence categories (worst of safety / environment / property).
2. Initiating event: pick the closest Table B1 entry. Use "not_credible" for natural events, external impacts, double jeopardy, incredible manual-valve errors or single point of failure; such causes need no IPLs.
3. Existing IPLs: evaluate the safeguards listed for this deviation and what the P&ID shows. A safeguard is an IPL only if it is
   - independent: of the initiating cause and of every other credited IPL (a shared sensor, logic solver or final element is one layer; a control loop that failed as the cause cannot also be an IPL),
   - effective: designed for this scenario and able to act in time,
   - auditable: tested / maintained so its PFD can be validated.
   Pick ipl_type from Table B2; credits come from the table, never invent them. An interlock not yet SIL classified is "bpcs". Alarm + operator action is "operator_response" and needs a sensor independent of the cause and of other credited IPLs. Indicators without alarm, status-only position switches and monitoring instruments go to other_safeguards. A check valve is never the sole IPL for reverse-flow overpressure.
   List every protection you evaluated in existing_ipls with the three judgements (false where it fails) so the engineer can see why it was or was not credited.
4. Risk: mitigated frequency = initiating frequency x 0.1^(sum of credits of IPLs passing all three criteria). F-1 >= 1e-1, F-2 >= 1e-2, F-3 >= 1e-3, F-4 >= 1e-4, F-5 < 1e-4 per year. Risk = risk_matrix.rows[F-1][C-1] (1=I ... 4=IV). Target: III or IV.
5. Proposed IPLs (the backward step): if the mitigated risk is I or II, propose the fewest additional IPLs (Table B2 types) that bring it to III or better. Prefer inherently safer / passive layers, then a SIF with a stated SIL, then alarm + operator response. Each proposal must be independent of the cause and of the existing IPLs and name existing tags or new ones (prefix new instruments with "new "). For each proposal give:
   - reasoning: why it is needed (which existing layer is missing or fails which criterion, the remaining risk gap) and why this IPL type, including how it stays independent;
   - process_benefit: which part of the process it protects (equipment, line, section) and which consequence or hazard it prevents or reduces;
   - protected_targets: the equipment / line / boundary tags from the P&ID data that it protects.
   If the risk is already III or IV, propose nothing unless an existing IPL fails a criterion and a simple fix restores it.
6. reference_row: id of the engineer worksheet row with the same cause and consequence, else null.
7. verdict: one or two sentences: is the protection good, complete, and sufficient after the proposals?
Write concise engineering English."""


def _process_context(pid):
    """The parts of json-pid the model needs, without the bulky reasoning sections."""
    return {
        "intention": pid.get("intention"),
        "process_description": pid.get("process_description"),
        "equipment": pid.get("equipment"),
        "valves": [{k: v[k] for k in ("id", "type", "location")} for v in pid.get("valves", [])],
        "instruments": [{k: i[k] for k in ("id", "function", "location", "context")} for i in pid.get("instruments", [])],
        "utility_lines": pid.get("utility_lines"),
        "lines": [{k: l[k] for k in ("line_id", "from_id", "to_id", "valves", "instruments")} for l in pid.get("line_level_connections", [])],
    }


def review_deviation(pid, pos, reference_rows, deviation_name):
    deviation = next(d for d in pos["cause_consequence_analysis_no_safeguards"] if d["deviation"] == deviation_name)
    safeguards = [s for s in pos["related_ipls_and_safeguards"] if deviation_name in s["related_deviations"]]
    payload = {
        "process": _process_context(pid),
        "deviation": deviation,
        "listed_safeguards_for_this_deviation": safeguards,
        "rules": {k: RULES[k] for k in ("risk_matrix", "frequency_categories", "consequence_categories", "initiating_events", "ipl_types")},
        "engineer_worksheet_rows": reference_rows,
    }
    started = time.time()
    response = OpenAI().responses.parse(
        model=os.environ["OPENAI_MODEL"],
        input=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Review every cause of this deviation, in order, using its cause_id.\n" + json.dumps(payload, ensure_ascii=False)},
        ],
        text_format=DeviationReview,
    )
    if response.output_parsed is None:
        raise ValueError(f"{response.model} returned no structured review (refusal or empty output)")
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seconds": round(time.time() - started, 1),
        "model": response.model,
        "causes": [c.model_dump() for c in response.output_parsed.causes],
    }
