"""Staged safety assessment (improvement plan S1-S6).

analyze() runs P1 -> P2 -> P3 -> P4 for one deviation and saves after every stage, so a failed run
resumes from the last finished stage. recommend() runs P6 for deficiencies the page computed.
Each result records model, time, token use and the source / prompt / rules versions it came from.
The model returns judgements only; statuses, gates, deficiencies and risk are computed in app/utils/assess.ts.
"""
import hashlib
import json
import os
import time
from datetime import datetime, timezone

from openai import OpenAI

from module import hazard_scenario as hs
from module import ipl_qualification as iq
from module import safety_improvement as si
from module.lopa import RULES
from module.safety_graph import context, element_ids, function_ids

POLICY = """You support a process-safety HAZOP-LOPA review (SCG Chemicals guideline SD-PS-G-0209) of one SuperNode of a process. You are a decision-support tool, not a certification or IPL-design authority.
Shared rules:
1. Ground every engineering claim in element IDs from the supplied data, in supplied evidence, or in an assumption you state explicitly.
2. Never invent tags, PFD values, initiating-event frequencies, setpoints, capacities, response times or proof-test evidence. A new device is written as "new <type>" and is never treated as existing.
3. Keep these apart: not_credible (the sequence cannot reasonably happen), not_applicable (a safeguard does not act on this sequence), invalid (it fails an IPL criterion), insufficient_evidence / unknown (the data needed to judge is missing).
4. A component whose failure is the initiating event is never an independent protection layer for that scenario.
5. Proposed or unverified layers never reduce as-is risk. Credits, frequencies and risk ranks are calculated by code from the company tables: never state or assume them.
6. Tie every corrective action to a specific endpoint and deficiency.
7. When material information is missing, say what is missing instead of guessing.
8. Fit the schema exactly; code checks every ID, enum and reference.
The engineer's HAZOP worksheet is deliberately not provided. Write concise engineering English."""

PROMPT_VERSION = hashlib.sha256("\n".join(
    [POLICY, hs.P1_SYSTEM, hs.P2_SYSTEM, iq.P3_SYSTEM, iq.P4_SYSTEM, si.P6_SYSTEM, "schema-1"]).encode()).hexdigest()[:12]
RULES_VERSION = hashlib.sha256(json.dumps(RULES, sort_keys=True).encode()).hexdigest()[:12]


def versions(*source_paths):
    digest = hashlib.sha256(b"".join(p.read_bytes() for p in source_paths if p)).hexdigest()[:12]
    return {"source_version": digest, "prompt_version": PROMPT_VERSION, "rules_version": RULES_VERSION}


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ask(stage_system, payload, schema):
    started = time.time()
    response = OpenAI().responses.parse(
        model=os.environ["OPENAI_MODEL"],
        input=[
            {"role": "system", "content": POLICY + "\n\n" + stage_system},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        text_format=schema,
    )
    if response.output_parsed is None:
        raise ValueError(f"{response.model} returned no structured output (refusal or empty)")
    usage = response.usage and {"input_tokens": response.usage.input_tokens, "output_tokens": response.usage.output_tokens}
    return response.output_parsed, {"seconds": round(time.time() - started, 1), "model": response.model, "usage": usage}


def reviewable_endpoints(scenarios, reviews):
    """Endpoints that go on to protection review: everything P2 did not rule out as not credible."""
    out = []
    for s in scenarios:
        review = next((r for r in reviews if r["cause_id"] == s["cause_id"]), None)
        if review and review["scenario_credibility"] == "not_credible":
            continue
        for e in s["hazard_endpoints"]:
            er = next((x for r in reviews for x in r["endpoints"] if x["endpoint_id"] == e["endpoint_id"]), None)
            if er and er["credibility"] == "not_credible":
                continue
            out.append({"scenario": {k: s[k] for k in ("cause_id", "source_type", "cause_source_ids", "initiating_event",
                                                       "initiating_event_class", "propagation_steps")},
                        "endpoint": e, "review": er})
    return out


def analyze(pid, pos, safety, deviation_name, current_versions, previous=None, save=lambda result: None, progress=lambda stage: None):
    deviation = next(d for d in pos["cause_consequence_analysis_no_safeguards"] if d["deviation"] == deviation_name)
    cause_ids = [c["cause_id"] for c in deviation["possible_causes"]]
    elements = element_ids(pid, safety)
    ctx = context(pid, safety)
    resumable = previous and previous.get("status") == "partial" and previous.get("versions") == current_versions
    reuse = previous["stages"] if resumable else {}
    result = {"deviation": deviation_name, "versions": current_versions, "status": "partial",
              "started_at": previous["started_at"] if resumable else _now(), "stages": {}}

    def stage(name, run):
        if name not in reuse:
            progress(name.upper())
            reuse[name] = run()
        result["stages"][name] = reuse[name]
        save(result)
        return reuse[name]

    def p1():
        events = [e for e in RULES["initiating_events"] if e["per_year"] > 0]  # credibility is P2's call
        parsed, meta = _ask(hs.P1_SYSTEM, {**ctx, "deviation": deviation, "initiating_events": events},
                            hs.p1_schema(elements, cause_ids, [e["id"] for e in events]))
        scenarios, issues = hs.number_p1(parsed, cause_ids)
        return {**meta, "issues": issues, "scenarios": scenarios}

    scenarios = stage("p1", p1)["scenarios"]
    endpoint_ids = [e["endpoint_id"] for s in scenarios for e in s["hazard_endpoints"]]

    def p2():
        if not endpoint_ids:
            return {"skipped": "P1 produced no endpoints", "issues": [], "reviews": []}
        parsed, meta = _ask(hs.P2_SYSTEM, {**ctx, "deviation": deviation_name, "scenarios": scenarios,
                                           "consequence_categories": RULES["consequence_categories"]},
                            hs.p2_schema([s["cause_id"] for s in scenarios], endpoint_ids))
        reviews, issues = hs.check_p2(parsed, scenarios)
        return {**meta, "issues": issues, "reviews": reviews}

    targets = reviewable_endpoints(scenarios, stage("p2", p2)["reviews"])
    target_ids = [t["endpoint"]["endpoint_id"] for t in targets]

    def p3():
        if not targets:
            return {"skipped": "no credible endpoint", "issues": [], "endpoints": []}
        listed = [s for s in pos["related_ipls_and_safeguards"] if deviation_name in s["related_deviations"]]
        parsed, meta = _ask(iq.P3_SYSTEM, {**ctx, "deviation": deviation_name, "listed_safeguards_for_this_deviation": listed,
                                           "endpoints": targets},
                            iq.p3_schema(elements, function_ids(safety), target_ids))
        endpoints, issues = iq.flatten_p3(parsed, target_ids)
        return {**meta, "issues": issues, "endpoints": endpoints}

    protection = stage("p3", p3)["endpoints"]
    pairs = [{"pair_id": f"{ep['endpoint_id']}|{c['candidate_id']}",
              "scenario_and_endpoint": next(t for t in targets if t["endpoint"]["endpoint_id"] == ep["endpoint_id"]),
              "candidate": c,
              "other_candidates_for_this_endpoint": [o["candidate_id"] for o in ep["candidates"] if o is not c]}
             for ep in protection for c in ep["candidates"]]

    def p4():
        if not pairs:
            return {"skipped": "no candidate safeguard", "issues": [], "assessments": []}
        pair_ids = [p["pair_id"] for p in pairs]
        parsed, meta = _ask(iq.P4_SYSTEM, {**ctx, "ipl_types": RULES["ipl_types"], "pairs": pairs},
                            iq.p4_schema(pair_ids, elements, [t["id"] for t in RULES["ipl_types"]]))
        assessments, issues = iq.split_p4(parsed, pair_ids)
        return {**meta, "issues": issues, "assessments": assessments}

    stage("p4", p4)
    result.update(status="complete", finished_at=_now())
    save(result)
    return result


def recommend(pid, safety, analysis, deficiencies, current_versions):
    """P6 for the posted deficiencies of one analysed deviation."""
    stages = analysis["stages"]
    endpoint_ids = list(dict.fromkeys(d["endpoint_id"] for d in deficiencies))
    targets = {t["endpoint"]["endpoint_id"]: t for t in reviewable_endpoints(stages["p1"]["scenarios"], stages["p2"]["reviews"])}
    endpoints = [{**targets[e],
                  "protection": next((p for p in stages["p3"]["endpoints"] if p["endpoint_id"] == e), None),
                  "assessments": [a for a in stages["p4"]["assessments"] if a["endpoint_id"] == e]}
                 for e in endpoint_ids]
    parsed, meta = _ask(si.P6_SYSTEM, {**context(pid, safety), "deviation": analysis["deviation"], "ipl_types": RULES["ipl_types"],
                                       "deficiencies": deficiencies, "endpoints": endpoints},
                        si.p6_schema([d["id"] for d in deficiencies], endpoint_ids, element_ids(pid, safety),
                                     [t["id"] for t in RULES["ipl_types"]]))
    actions, issues = si.number_actions(parsed, deficiencies)
    return {**meta, "generated_at": _now(), "versions": current_versions, "deficiency_ids": [d["id"] for d in deficiencies],
            "issues": issues, "actions": actions}
