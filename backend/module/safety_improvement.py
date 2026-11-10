"""S5: deficiency-specific corrective actions (P6).

Deficiencies (D1-D7) are computed in code from P3/P4 and the company risk tables
(app/utils/assess.ts) and posted by the page; P6 only proposes actions for them.
A proposal is never installed or qualified: its status starts as "candidate" and only the
engineer review moves it on. Any credit it could earn is computed in code as a conditional projection.
"""
from typing import Literal

from pydantic import BaseModel

P6_SYSTEM = """Stage P6 - corrective actions for diagnosed protection deficiencies. The deficiencies (D1-D7) were computed by code from the P3/P4 results and the company risk tables; take them as given.
Recommend the fewest technically justified actions. Consider, in order: eliminate or reduce the hazard; modify an existing protective function; add an independent preventive or mitigative function; improve proof testing or evidence (for D7); further engineering study. One action may address several deficiencies of the same endpoint. When a deficiency needs no new protection (for example the risk target is met once pending evidence is confirmed), return improve_testing_or_evidence or no_additional_protection_required instead of hardware.
For each action:
- endpoint_id, target_deficiency_ids, strategy, description;
- ipl_type: the Table B2 type if the measure could be credited as an IPL once verified, else null;
- existing_ids: existing elements it uses or modifies; new_tags: new devices written as "new <type>" (for example "new independent level transmitter");
- intervention_point_ids and expected_mechanism;
- effect_on: frequency (prevents the sequence), consequence (reduces severity, needs a consequence reassessment) or evidence_only;
- possible_dependencies: shared components or common-cause concerns with the cause or the existing layers;
- verification_requirements: what engineering must verify before any credit (sizing, setpoint, response time, SIL / PFD, proof test);
- reasoning: why this action for these deficiencies, and how it stays independent;
- process_benefit: which part of the process it protects and which consequence it prevents.
Administrative measures are not independent IPLs unless they meet every criterion. Never describe an action as installed, qualified or approved."""

STRATEGIES = ("eliminate_or_reduce_hazard", "modify_existing_function", "add_preventive_function", "add_mitigative_function",
              "improve_testing_or_evidence", "further_engineering_study", "no_additional_protection_required")


def p6_schema(deficiency_ids, endpoint_ids, element_ids, ipl_type_ids):
    Element = Literal[tuple(element_ids)]

    class Action(BaseModel):
        endpoint_id: Literal[tuple(endpoint_ids)]
        target_deficiency_ids: list[Literal[tuple(deficiency_ids)]]
        strategy: Literal[STRATEGIES]
        description: str
        ipl_type: Literal[tuple(ipl_type_ids)] | None
        existing_ids: list[Element]
        new_tags: list[str]
        intervention_point_ids: list[Element]
        expected_mechanism: str
        effect_on: Literal["frequency", "consequence", "evidence_only"]
        possible_dependencies: list[str]
        verification_requirements: list[str]
        reasoning: str
        process_benefit: str

    class P6(BaseModel):
        actions: list[Action]

    return P6


def number_actions(parsed, deficiencies):
    actions, count = [], {}
    for a in parsed.actions:
        count[a.endpoint_id] = count.get(a.endpoint_id, 0) + 1
        actions.append({"action_id": f"{a.endpoint_id}-A{count[a.endpoint_id]}", **a.model_dump()})
    covered = {d for a in actions for d in a["target_deficiency_ids"]}
    issues = [f"P6 gave no action for {d['id']}" for d in deficiencies if d["id"] not in covered]
    return actions, issues
