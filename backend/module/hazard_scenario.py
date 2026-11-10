"""S1/S2: forward hazard propagation (P1) and credibility / endpoint review (P2).

P1 traces each json-pos cause through the process with no safeguard credited; P2 challenges
that trace and classifies each endpoint. Schemas are built per call so every ID the model
returns must be a real element, cause or endpoint.
"""
from typing import Literal

from pydantic import BaseModel

CREDIBILITY = Literal["credible", "not_credible", "insufficient_evidence"]

P1_SYSTEM = """Stage P1 - forward hazard propagation, unmitigated.
For each cause of this deviation (use its cause_id), trace what physically happens if no safeguard acts. Ignore every alarm, trip, relief device and operator action in this pass: none of them may stop the propagation.
- source_type and cause_source_ids: the elements where the cause starts. External conditions, human actions and process phenomena use the enrichment elements (COND-*, HUM-*, PHEN-*). Use "unresolved" with no IDs only when nothing fits.
- initiating_event: the specific failure or event. initiating_event_class: the closest Table B1 entry (the frequency basis), with initiating_event_reason.
- local_effect: the first effect at the source.
- propagation_steps: ordered steps, each from one element to the next connected element (lines, equipment, boundaries, signal or utility dependencies). Give the physical mechanism (flow, pressure, inventory, thermal, control, timing) and what changes. Follow recycle and utility paths where they matter; do not jump between unconnected elements.
- hazard_endpoints: every distinct end consequence that needs protection review. One cause may have several (for example tank overfill, pump damage from dry running, loss of HPU feed). Give the element_id where it happens (systems and sections, SYS-* / SEC-*, are allowed) and the consequence.
- operating_assumptions: the operating mode and conditions you assumed.
- evidence_refs: the data you relied on, as "json-pos:<cause_id>", "json-pid:<element id>" or "safety:<id>"."""

P2_SYSTEM = """Stage P2 - credibility and endpoint review. You receive the P1 scenarios of one deviation. Challenge them; do not restate them.
For each scenario:
- scenario_credibility (credible / not_credible / insufficient_evidence) in the stated operating mode, with credibility_reason. not_credible needs a physical or procedural reason. The guideline excludes natural events, external impacts, double jeopardy and incredible manual-valve errors, but keeps exceptions for plant experience and design cases: say which applies. Missing data means insufficient_evidence, never not_credible.
- unsupported_steps: P1 steps (by step number) whose mechanism does not hold under the operating assumptions, with the reason.
For each endpoint (by endpoint_id):
- credibility: can the sequence really reach this endpoint?
- endpoint_type: process_safety (loss of containment, fire, explosion, toxic release, injury), equipment_protection (damage without a release) or operability (production or quality loss only).
- hazardous_event: the final event that needs protection review.
- severity (C-1..C-5): from the consequence categories, worst of safety / environment / property, ignoring all safeguards, with severity_reason.
- physical_basis: the mechanism and magnitude that support the endpoint.
- required_evidence: engineering data needed to confirm it (design pressure, overfill volume, NPSH margin, ...)."""


def p1_schema(element_ids, cause_ids, initiating_event_ids):
    Element = Literal[tuple(element_ids)]

    class PropagationStep(BaseModel):
        from_id: Element
        to_id: Element
        mechanism: str
        effect: str

    class HazardEndpoint(BaseModel):
        element_id: Element
        consequence: str

    class Scenario(BaseModel):
        cause_id: Literal[tuple(cause_ids)]
        source_type: Literal["equipment_or_component", "external_condition", "human_action", "process_phenomenon", "unresolved"]
        cause_source_ids: list[Element]
        initiating_event: str
        initiating_event_class: Literal[tuple(initiating_event_ids)]
        initiating_event_reason: str
        local_effect: str
        propagation_steps: list[PropagationStep]
        hazard_endpoints: list[HazardEndpoint]
        operating_assumptions: list[str]
        evidence_refs: list[str]

    class P1(BaseModel):
        scenarios: list[Scenario]

    return P1


def p2_schema(cause_ids, endpoint_ids):
    class StepIssue(BaseModel):
        step: int
        reason: str

    class EndpointReview(BaseModel):
        endpoint_id: Literal[tuple(endpoint_ids)]
        credibility: CREDIBILITY
        endpoint_type: Literal["process_safety", "equipment_protection", "operability"]
        hazardous_event: str
        severity: Literal[1, 2, 3, 4, 5]
        severity_reason: str
        physical_basis: str
        required_evidence: list[str]

    class ScenarioReview(BaseModel):
        cause_id: Literal[tuple(cause_ids)]
        scenario_credibility: CREDIBILITY
        credibility_reason: str
        unsupported_steps: list[StepIssue]
        endpoints: list[EndpointReview]

    class P2(BaseModel):
        reviews: list[ScenarioReview]

    return P2


def number_p1(parsed, cause_ids):
    """Give steps and endpoints stable IDs; report missing or repeated causes."""
    scenarios, issues = [], []
    for s in parsed.scenarios:
        if any(x["cause_id"] == s.cause_id for x in scenarios):
            issues.append(f"P1 returned {s.cause_id} twice; kept the first")
            continue
        d = s.model_dump()
        for i, step in enumerate(d["propagation_steps"], 1):
            step["step"] = i
        for i, e in enumerate(d["hazard_endpoints"], 1):
            e["endpoint_id"] = f"{s.cause_id}-E{i}"
        if not d["hazard_endpoints"]:
            issues.append(f"P1 gave {s.cause_id} no hazard endpoint")
        scenarios.append(d)
    issues += [f"P1 skipped cause {c}" for c in cause_ids if not any(s["cause_id"] == c for s in scenarios)]
    return scenarios, issues


def check_p2(parsed, scenarios):
    reviews = [r.model_dump() for r in parsed.reviews]
    issues = []
    for s in scenarios:
        r = next((r for r in reviews if r["cause_id"] == s["cause_id"]), None)
        if r is None:
            issues.append(f"P2 skipped scenario {s['cause_id']}")
            continue
        reviewed = {e["endpoint_id"] for e in r["endpoints"]}
        issues += [f"P2 skipped endpoint {e['endpoint_id']}" for e in s["hazard_endpoints"] if e["endpoint_id"] not in reviewed]
    return reviews, issues
