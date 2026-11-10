"""S3/S4-A: backward protection-function mapping (P3) and IPL qualification (P4).

P3 works backward from each hazardous endpoint to the protective functions it needs and the
existing safeguards that could perform them, with no credit. P4 judges each endpoint-candidate
pair on six checks. The IPL status (qualified / invalid / not_applicable / unverified), the
dependency gates and every credit are derived from those checks in code (app/utils/assess.ts).
"""
from typing import Literal

from pydantic import BaseModel

P3_SYSTEM = """Stage P3 - backward protection-function mapping. Start from each hazardous endpoint and work backward along its propagation path.
For each endpoint (by endpoint_id):
1. required_functions: the preventive functions (stop the sequence before the endpoint) and mitigative functions (reduce the consequence once it happens) that could protect it. Describe the function, not a piece of equipment, and give its intervention point(s) on the path.
2. candidates for each function: existing safeguards that could perform it. Use an existing safety function (function_id) when one fits, otherwise the component tags. Include the json-pos safeguards listed for this deviation when they relate to this sequence, even doubtful ones: P4 judges them. Give each candidate's intervention point, how it interrupts or mitigates this sequence (mechanism) and which consequence it addresses (addresses). Existing equipment only; a function with no existing candidate keeps an empty list.
Do not judge IPL validity or credit here. One safeguard does not have to protect every endpoint: a pump trip may prevent pump damage but not the loss of downstream feed."""

P4_SYSTEM = """Stage P4 - IPL qualification. For each endpoint-candidate pair (pair_id) decide whether the candidate can be credited as an independent protection layer for that scenario, using only the supplied data.
- ipl_type: the closest Table B2 type, or null if it cannot be any IPL type (for example indication without an alarm). An interlock without a documented SIL is typed bpcs; alarm + operator action is operator_response.
- applicability: does it act on this specific sequence before (or at) the endpoint?
- effectiveness: can it detect and act in time with enough capacity (setpoint, response time, capacity)?
- independence: is it independent of the initiating event, with no shared sensor, logic, final element, utility or person with the cause?
- common_cause: is it independent of the other candidates for the same endpoint? Name shared components in dependency_refs. One operator cannot be credited twice in one scenario.
- reliability: is a PFD / risk-reduction basis documented (SIL, test interval, applicability of the Table B2 value)?
- auditability: is proof testing, inspection or functional verification documented?
Each check returns pass, fail or unknown with its basis. Use unknown when the data needed is missing; that is not a fail. Use fail only when the data shows the criterion is not met.
missing_evidence: what an engineer must supply to resolve each unknown."""

CHECKS = ("applicability", "effectiveness", "independence", "common_cause", "reliability", "auditability")


def p3_schema(element_ids, function_ids, endpoint_ids):
    Element = Literal[tuple(element_ids)]
    Function = (Literal[tuple(function_ids)] | None) if function_ids else None

    class Candidate(BaseModel):
        function_id: Function
        component_ids: list[Element]
        description: str
        intervention_point_ids: list[Element]
        mechanism: str
        addresses: str

    class RequiredFunction(BaseModel):
        kind: Literal["preventive", "mitigative"]
        description: str
        intervention_point_ids: list[Element]
        candidates: list[Candidate]

    class EndpointProtection(BaseModel):
        endpoint_id: Literal[tuple(endpoint_ids)]
        required_functions: list[RequiredFunction]

    class P3(BaseModel):
        endpoints: list[EndpointProtection]

    return P3


def p4_schema(pair_ids, element_ids, ipl_type_ids):
    class Check(BaseModel):
        result: Literal["pass", "fail", "unknown"]
        basis: str

    class Assessment(BaseModel):
        pair_id: Literal[tuple(pair_ids)]
        ipl_type: Literal[tuple(ipl_type_ids)] | None
        applicability: Check
        effectiveness: Check
        independence: Check
        common_cause: Check
        reliability: Check
        auditability: Check
        dependency_refs: list[Literal[tuple(element_ids)]]
        missing_evidence: list[str]

    class P4(BaseModel):
        assessments: list[Assessment]

    return P4


def flatten_p3(parsed, endpoint_ids):
    """Per endpoint: required functions with IDs, and each distinct candidate once with a stable candidate_id."""
    endpoints, issues = [], []
    for ep in parsed.endpoints:
        if any(e["endpoint_id"] == ep.endpoint_id for e in endpoints):
            issues.append(f"P3 returned {ep.endpoint_id} twice; kept the first")
            continue
        functions, candidates = [], {}
        for i, rf in enumerate(ep.required_functions, 1):
            ids = []
            for c in rf.candidates:
                cid = c.function_id or "+".join(sorted(c.component_ids)) or f"{ep.endpoint_id}-F{i}-C{len(ids) + 1}"
                candidates.setdefault(cid, {"candidate_id": cid, **c.model_dump()})
                ids.append(cid)
            functions.append({"function_id": f"{ep.endpoint_id}-F{i}", "kind": rf.kind, "description": rf.description,
                              "intervention_point_ids": rf.intervention_point_ids, "candidate_ids": list(dict.fromkeys(ids))})
        endpoints.append({"endpoint_id": ep.endpoint_id, "required_functions": functions, "candidates": list(candidates.values())})
    issues += [f"P3 skipped endpoint {e}" for e in endpoint_ids if not any(x["endpoint_id"] == e for x in endpoints)]
    return endpoints, issues


def split_p4(parsed, pair_ids):
    assessments, issues = [], []
    for a in parsed.assessments:
        if any(x["pair_id"] == a.pair_id for x in assessments):
            issues.append(f"P4 assessed {a.pair_id} twice; kept the first")
            continue
        d = a.model_dump()
        d["endpoint_id"], d["candidate_id"] = a.pair_id.split("|", 1)
        assessments.append(d)
    issues += [f"P4 skipped {p}" for p in pair_ids if not any(a["pair_id"] == p for a in assessments)]
    return assessments, issues
