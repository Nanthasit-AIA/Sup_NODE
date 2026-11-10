from flask import Flask, abort, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO

from decorators import logger

import json, os, re, threading, uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAIError

load_dotenv(Path(__file__).parent / ".env")  # OPENAI_API_KEY, OPENAI_MODEL
from module import lopa as lopa_review  # noqa: E402
from module import assessment  # noqa: E402

STATIC_DIR = Path(__file__).parent / "static"
PID_DIR = STATIC_DIR / "json_pid"
POS_DIR = STATIC_DIR / "json_pos"
REF_DIR = STATIC_DIR / "json_ref"  # engineer HAZOP-LOPA worksheets (scripts/worksheet_to_json.py)
LOPA_DIR = STATIC_DIR / "json_lopa"  # cached AI reviews (baseline single-prompt review, frozen)
SAFETY_DIR = STATIC_DIR / "json_safety"  # enrichment layer: systems, conditions, safety functions, drawing tags
ASSESS_DIR = STATIC_DIR / "json_assess"  # staged assessment results (P1-P4, P6)
REVIEW_DIR = STATIC_DIR / "json_review"  # engineer review decisions, append-only
FILE_RE = re.compile(r"^(\d+)_(.+)\.json$")

app = Flask(__name__)
CORS(app)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def pid_files():
    """Yield (number, name, path) for each json_pid file named like '01_some_name.json'."""
    for path in sorted(PID_DIR.glob("*.json")):
        m = FILE_RE.match(path.name)
        if m:
            yield m.group(1), m.group(2).replace("_", " "), path


def numbered(folder, case_id):
    """First file in folder named like '<case_id>_*.json', or None."""
    return next(iter(sorted(folder.glob(f"{case_id}_*.json"))), None)


def file_tags(pid):
    """Every tag/name a user may search for inside one json_pid file."""
    tags = [e["id"] for e in pid.get("equipment", [])]
    tags += [e["name"] for e in pid.get("equipment", [])]
    tags += [v["id"] for v in pid.get("valves", [])]
    tags += [i["id"] for i in pid.get("instruments", [])]
    tags += [c["line_id"] for c in pid.get("line_level_connections", [])]
    tags += [c["node"] for c in pid.get("connections", [])]
    return tags


@app.get("/api/search")
def search():
    q = request.args.get("q", "").strip().lower()
    results = []
    for num, name, path in pid_files():
        if not q:
            score, matched = 1, []
        elif q.isdigit() and int(q) == int(num):
            score, matched = 4, []
        elif name.startswith(q):
            score, matched = 3, []
        elif q in name or q in path.stem.lower():
            score, matched = 2, []
        else:
            matched = [t for t in file_tags(load_json(path)) if q in t.lower()]
            score = 1 if matched else 0
        if score:
            results.append({"id": num, "name": name, "file": path.name, "matched": matched[:3], "score": score})
    results.sort(key=lambda r: (-r["score"], r["id"]))
    return jsonify(results[:10])


@app.get("/api/case/<case_id>")
def case(case_id):
    pid_path = next((p for num, _, p in pid_files() if num == case_id), None)
    if pid_path is None:
        abort(404, description=f"No json_pid file numbered {case_id}")
    name = FILE_RE.match(pid_path.name).group(2).replace("_", " ")
    pos_path, safety_path = numbered(POS_DIR, case_id), numbered(SAFETY_DIR, case_id)
    logger.info(f"case {case_id}: pid={pid_path.name} pos={pos_path.name if pos_path else None}")
    return jsonify({
        "id": case_id,
        "name": name,
        "pid": load_json(pid_path),
        "pos": load_json(pos_path) if pos_path else None,
        "safety": load_json(safety_path) if safety_path else None,
    })


# One AI review of a deviation takes minutes, so reviews run as background jobs (max 3 at once)
# and the page polls GET /api/lopa/<id>. The lock guards the job state and the cache file.
_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=3)
_running = {}  # case_id -> deviations in progress
_errors = {}  # case_id -> {deviation: message}


def _review_path(case_id):
    return LOPA_DIR / f"{case_id}_lopa.json"


def _review_job(case_id, deviation, pid, pos, reference):
    try:
        logger.info(f"lopa {case_id}: reviewing {deviation!r} with {os.environ.get('OPENAI_MODEL')}")
        result = lopa_review.review_deviation(pid, pos, reference, deviation)
        with _lock:
            path = _review_path(case_id)
            review = load_json(path) if path.exists() else {"deviations": {}}
            review["deviations"][deviation] = result
            LOPA_DIR.mkdir(exist_ok=True)
            path.write_text(json.dumps(review, indent=2, ensure_ascii=False), encoding="utf-8")
            _errors.get(case_id, {}).pop(deviation, None)
    except (OpenAIError, ValueError) as e:  # API failure or a response that does not fit the schema
        logger.error(f"lopa {case_id} {deviation!r}: {e}")
        body = getattr(e, "body", None)  # OpenAI status errors carry the API's error object
        with _lock:
            _errors.setdefault(case_id, {})[deviation] = body.get("message", str(e)) if isinstance(body, dict) else str(e)
    finally:
        with _lock:
            _running[case_id].discard(deviation)


@app.get("/api/lopa/<case_id>")
def lopa(case_id):
    ref_path = numbered(REF_DIR, case_id)
    with _lock:
        path = _review_path(case_id)
        review = load_json(path) if path.exists() else {"deviations": {}}
        running, errors = sorted(_running.get(case_id, ())), dict(_errors.get(case_id, {}))
    return jsonify({
        "rules": lopa_review.RULES,
        "reference": load_json(ref_path)["rows"] if ref_path else [],
        "review": review,
        "running": running,
        "errors": errors,
        "model": os.environ.get("OPENAI_MODEL"),
    })


@app.post("/api/lopa/<case_id>/run")
def lopa_run(case_id):
    """Start AI backward reviews for the given deviations; results land in json_lopa/<case_id>_lopa.json."""
    deviations = (request.get_json(silent=True) or {}).get("deviations") or []
    pid_path, pos_path, ref_path = numbered(PID_DIR, case_id), numbered(POS_DIR, case_id), numbered(REF_DIR, case_id)
    if pid_path is None or pos_path is None:
        abort(404, description=f"Case {case_id} needs both json_pid and json_pos files")
    pid, pos = load_json(pid_path), load_json(pos_path)
    reference = load_json(ref_path)["rows"] if ref_path else []
    known = [d["deviation"] for d in pos["cause_consequence_analysis_no_safeguards"]]
    if not deviations or any(d not in known for d in deviations):
        abort(400, description=f"Deviations must be among {known}")

    with _lock:
        running = _running.setdefault(case_id, set())
        for deviation in deviations:
            if deviation not in running:
                running.add(deviation)
                _pool.submit(_review_job, case_id, deviation, pid, pos, reference)
        now_running = sorted(running)
    return jsonify({"running": now_running}), 202


# ---- staged safety assessment (P1-P4 per deviation, P6 on request, engineer review log) ----
# Same pattern as the LOPA review: background jobs under _lock, the page polls GET /api/assess/<id>.
_assess_running = {}  # case_id -> {deviation: stage being run}
_assess_errors = {}  # case_id -> {deviation: message}
REVIEW_ACTIONS = {"confirm_assessment", "revise", "request_verification", "reject", "accept_for_further_engineering"}


def _assess_inputs(case_id):
    pid_path, pos_path, safety_path = numbered(PID_DIR, case_id), numbered(POS_DIR, case_id), numbered(SAFETY_DIR, case_id)
    if pid_path is None or pos_path is None:
        abort(404, description=f"Case {case_id} needs both json_pid and json_pos files")
    safety = load_json(safety_path) if safety_path else None
    return load_json(pid_path), load_json(pos_path), safety, assessment.versions(pid_path, pos_path, safety_path)


def _read(path, empty):
    return load_json(path) if path.exists() else empty


def _write(path, data):
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _assess_job(case_id, deviation, work):
    """Run one assessment job; record a readable error instead of losing it in the thread pool."""
    try:
        work()
        with _lock:
            _assess_errors.get(case_id, {}).pop(deviation, None)
    except Exception as e:  # API failure, schema mismatch or a bug: show it on the page
        logger.exception(f"assess {case_id} {deviation!r}")
        body = getattr(e, "body", None)
        message = body.get("message", str(e)) if isinstance(body, dict) else f"{type(e).__name__}: {e}"
        with _lock:
            _assess_errors.setdefault(case_id, {})[deviation] = message
    finally:
        with _lock:
            _assess_running.get(case_id, {}).pop(deviation, None)


def _save_analysis(case_id, deviation, result):
    with _lock:
        path = ASSESS_DIR / f"{case_id}_assess.json"
        data = _read(path, {"deviations": {}})
        data["deviations"][deviation] = result  # a new analysis drops recommendations made for the old one
        _write(path, data)


@app.get("/api/assess/<case_id>")
def assess(case_id):
    _, _, safety, current = _assess_inputs(case_id)
    with _lock:
        data = _read(ASSESS_DIR / f"{case_id}_assess.json", {"deviations": {}})
        reviews = _read(REVIEW_DIR / f"{case_id}_review.json", {"events": []})["events"]
        running, errors = dict(_assess_running.get(case_id, {})), dict(_assess_errors.get(case_id, {}))
    return jsonify({"rules": lopa_review.RULES, "safety": safety, "assessment": data, "reviews": reviews,
                    "running": running, "errors": errors, "model": os.environ.get("OPENAI_MODEL"), "versions": current})


@app.post("/api/assess/<case_id>/run")
def assess_run(case_id):
    """Start P1-P4 for the given deviations; a partial earlier run with the same versions resumes."""
    deviations = (request.get_json(silent=True) or {}).get("deviations") or []
    pid, pos, safety, current = _assess_inputs(case_id)
    known = [d["deviation"] for d in pos["cause_consequence_analysis_no_safeguards"]]
    if not deviations or any(d not in known for d in deviations):
        abort(400, description=f"Deviations must be among {known}")

    def work(deviation):
        with _lock:
            previous = _read(ASSESS_DIR / f"{case_id}_assess.json", {"deviations": {}})["deviations"].get(deviation)

        def progress(stage):
            with _lock:
                _assess_running[case_id][deviation] = stage

        logger.info(f"assess {case_id}: analysing {deviation!r} with {os.environ.get('OPENAI_MODEL')}")
        assessment.analyze(pid, pos, safety, deviation, current, previous,
                           save=lambda result: _save_analysis(case_id, deviation, result), progress=progress)

    with _lock:
        running = _assess_running.setdefault(case_id, {})
        for deviation in deviations:
            if deviation not in running:
                running[deviation] = "queued"
                _pool.submit(_assess_job, case_id, deviation, lambda d=deviation: work(d))
        now_running = dict(running)
    return jsonify({"running": now_running}), 202


@app.post("/api/assess/<case_id>/recommend")
def assess_recommend(case_id):
    """Run P6 for the deficiencies the page computed for one fully analysed deviation."""
    body = request.get_json(silent=True) or {}
    deviation, deficiencies = body.get("deviation"), body.get("deficiencies") or []
    pid, _, safety, current = _assess_inputs(case_id)
    analysis = _read(ASSESS_DIR / f"{case_id}_assess.json", {"deviations": {}})["deviations"].get(deviation)
    if not analysis or analysis.get("status") != "complete":
        abort(400, description=f"Run the analysis of {deviation!r} to the end first")
    reviewable = {t["endpoint"]["endpoint_id"] for t in
                  assessment.reviewable_endpoints(analysis["stages"]["p1"]["scenarios"], analysis["stages"]["p2"]["reviews"])}
    ids = [d.get("id") for d in deficiencies]
    if not deficiencies or len(set(ids)) != len(ids) or any(d.get("endpoint_id") not in reviewable for d in deficiencies):
        abort(400, description="Deficiencies must have unique ids and belong to endpoints that passed P2")

    def work():
        result = assessment.recommend(pid, safety, analysis, deficiencies, current)
        with _lock:
            path = ASSESS_DIR / f"{case_id}_assess.json"
            data = _read(path, {"deviations": {}})
            data["deviations"][deviation]["recommendations"] = result
            _write(path, data)

    with _lock:
        running = _assess_running.setdefault(case_id, {})
        if deviation not in running:
            running[deviation] = "P6"
            _pool.submit(_assess_job, case_id, deviation, work)
        now_running = dict(running)
    return jsonify({"running": now_running}), 202


@app.post("/api/assess/<case_id>/review")
def assess_review(case_id):
    """Append one engineer decision to the review log (never edited or deleted)."""
    body = request.get_json(silent=True) or {}
    missing = [k for k in ("reviewer", "role", "deviation", "item", "action", "reason") if not str(body.get(k) or "").strip()]
    if missing or body["action"] not in REVIEW_ACTIONS:
        abort(400, description=f"Need reviewer, role, deviation, item, action ({', '.join(sorted(REVIEW_ACTIONS))}) and a reason")
    *_, current = _assess_inputs(case_id)
    with _lock:
        analysis = _read(ASSESS_DIR / f"{case_id}_assess.json", {"deviations": {}})["deviations"].get(body["deviation"]) or {}
        event = {
            "id": uuid.uuid4().hex[:10],
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            **{k: str(body[k]).strip() for k in ("reviewer", "role", "deviation", "item", "action", "reason")},
            "evidence": str(body.get("evidence") or "").strip(),
            "change": body.get("change") if isinstance(body.get("change"), dict) else {},
            "versions": current,
            "analysis_started_at": analysis.get("started_at"),
        }
        path = REVIEW_DIR / f"{case_id}_review.json"
        log = _read(path, {"events": []})
        log["events"].append(event)
        _write(path, log)
    logger.info(f"review {case_id}: {event['reviewer']} {event['action']} {event['item']}")
    return jsonify({"events": log["events"]}), 201


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
