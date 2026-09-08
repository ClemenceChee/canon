#!/usr/bin/env python3
"""
Deterministic additive growth of the committed refunds fixture corpus
(DEC-18 — every DEC-17 emission floor reachable WITH MARGIN).

Reads the committed refunds observation/score HTTP pages, authors NEW traces
(v4 row shape; rows are deep copies of in-corpus exemplars so field/key
conventions match byte-for-byte), then re-packs ALL rows into fresh
startTime-desc pages (Langfuse v2 paging order) and regenerates the archive
envelope JSONLs (chain order, dedupe by first occurrence, frozen clock).

Growth added (DEC-18 pattern map):
  refund_task      tr_refund_7, tr_refund_8          refund-standard majority +2
                                                       (tool-choice floor 4 w/ margin)
  chargeback_task  tr_charge_5..tr_charge_10         6 charge-reversal double-call
                                                       traces: tr_charge_5/6/10
                                                       after-error, tr_charge_7/8/9
                                                       after-timeout -> 7 supporting
                                                       traces incl. both causes
                                                       (side-effect-retry floor 5)
  dispute_task     tr_dispute_6..tr_dispute_11 (gpt-4o), tr_dispute_12 (gpt-4o-mini)
                                                       -> 9 costlier + 3 cheap = 12
                                                       (model-usage floor 8 w/ margin)

Two duplicate-id lines (obs_refund_tool_1, obs_charge_tool_2) ride the LAST
observation page as the pure dedupe fixture (review N3 / DEC-19: the tail rows
are byte-identical re-serves and are allowed to sit out of startTime order).

Run:  python3 scripts/grow-refunds-corpus.py   (from the repo root)
Refuses to run twice (the new trace ids already exist).
"""

import collections
import glob
import json
import os
from copy import deepcopy
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OBS_DIR = os.path.join(REPO, "tests/fixtures/langfuse-http/refunds/observations/pages")
SCORE_DIR = os.path.join(REPO, "tests/fixtures/langfuse-http/refunds/scores/pages")
ARCHIVE_DIR = os.path.join(REPO, "tests/fixtures/archive/refunds")
INGEST_AT = "2025-09-01T12:00:00.000Z"
PROJECT = "prj-refunds"
PAGE_SIZE = 8

NEW_TRACES = [
    "tr_refund_7", "tr_refund_8",
    "tr_charge_5", "tr_charge_6", "tr_charge_7", "tr_charge_8", "tr_charge_9", "tr_charge_10",
    "tr_dispute_6", "tr_dispute_7", "tr_dispute_8", "tr_dispute_9", "tr_dispute_10",
    "tr_dispute_11", "tr_dispute_12",
]


def load(path):
    with open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8"), object_pairs_hook=collections.OrderedDict)


def store(path, obj, indent=2):
    with open(path, "w") as f:
        json.dump(obj, f, indent=indent, ensure_ascii=False)
        f.write("\n")


def pages_of(directory):
    files = sorted(glob.glob(os.path.join(directory, "page-*.json")))
    return [load(f) for f in files], files


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def toms(t):
    return int(
        datetime.strptime(t, "%Y-%m-%dT%H:%M:%S.%fZ")
        .replace(tzinfo=timezone.utc)
        .timestamp()
        * 1000
    )


def add_minutes(root_ms, minutes):
    return iso(root_ms + minutes * 60_000)


def find(kind, name=None, level=None, model=None, rows=None):
    for r in rows:
        if kind is not None and r.get("type") != kind:
            continue
        if name is not None and r.get("name") != name:
            continue
        if level is not None and r.get("level") != level:
            continue
        if model is not None and r.get("model") != model:
            continue
        return deepcopy(r)
    raise SystemExit(f"no exemplar kind={kind} name={name} level={level} model={model}")


def find_score(name, data_type, source, skind, rows):
    for s in rows:
        if s.get("name") != name or s.get("dataType") != data_type or s.get("source") != source:
            continue
        if (s.get("subject") or {}).get("kind") != skind:
            continue
        return deepcopy(s)
    raise SystemExit(f"no score exemplar name={name} type={data_type} src={source} skind={skind}")


# ---------------- load committed corpus ----------------
obs_pages, obs_files = pages_of(OBS_DIR)
score_pages, score_files = pages_of(SCORE_DIR)
old_rows = [r for p in obs_pages for r in p["data"]]
old_scores = [s for p in score_pages for s in p["data"]]
old_ids = {r["id"] for r in old_rows} | {s["id"] for s in old_scores}

if any(tid in {r["traceId"] for r in old_rows} for tid in NEW_TRACES):
    raise SystemExit("refusing to run twice: grown trace ids already exist")

USED = set(old_ids)


def new_obs_id(base):
    if base not in USED:
        USED.add(base)
        return base
    n = 2
    while f"{base}_{n}" in USED:
        n += 1
    USED.add(f"{base}_{n}")
    return f"{base}_{n}"


new_rows = []


def mint_and_emit(rows):
    for r in rows:
        # ids were minted (and reserved) via new_obs_id before emit
        new_rows.append(r)


def set_common(r, rid, task, tag, parent=None, level=None, status="", trace_name=None):
    r["traceId"] = rid
    r["projectId"] = PROJECT
    r["environment"] = "production"
    r["version"] = "1.0.0"
    r["traceName"] = trace_name or task
    r["tags"] = [tag]
    r["statusMessage"] = status
    if parent is not None:
        r["parentObservationId"] = parent
        r["isRootObservation"] = False
    if level is not None:
        r["level"] = level
    return r


# ================= refund_task: tr_refund_7 / tr_refund_8 =================
def refund_trace(tid, root_ms, case_no, sess, user, obs_prefix, root_end_s):
    base = root_ms
    t = (lambda s: iso(base + s * 1000))
    a = set_common(find("AGENT", name="refund-agent", rows=old_rows), tid, "refund_task", "refund")
    a.update({
        "id": new_obs_id(f"obs_{obs_prefix}_agent"), "name": "refund-agent",
        "isRootObservation": True, "parentObservationId": None,
        "startTime": t(0), "endTime": t(root_end_s), "latency": root_end_s * 1000,
        "input": f"Handle refund R-{case_no}.", "output": "Refund issued to customer via standard flow.",
        "sessionId": sess, "userId": user,
    })
    rows = [a]
    sp = set_common(find("SPAN", name="post-refund-check", rows=old_rows), tid, "refund_task", "refund", parent=a["id"])
    sp.update({"id": new_obs_id(f"obs_{obs_prefix}_span"), "startTime": t(1), "endTime": t(2),
               "latency": 1000, "input": f"verify refund R-{case_no}", "output": "ok"})
    rows.append(sp)
    tool = set_common(find("TOOL", name="refund-standard", rows=old_rows), tid, "refund_task", "refund", parent=a["id"])
    tool.update({"id": new_obs_id(f"obs_{obs_prefix}_tool"), "startTime": t(3), "endTime": t(6),
                 "latency": 3000, "input": f"refund order O-{case_no}",
                 "output": f"refund scheduled (id rf_{case_no})"})
    rows.append(tool)
    g = set_common(find("GENERATION", model="gpt-4o-mini", rows=old_rows), tid, "refund_task", "refund", parent=a["id"])
    g.update({"id": new_obs_id(f"obs_{obs_prefix}_gen"), "name": "refund-summary",
              "startTime": t(8), "endTime": t(10), "latency": 2000,
              "input": f"Summarise refund R-{case_no} outcome", "output": "Refund issued via standard flow."})
    rows.append(g)
    nt = set_common(find("TOOL", name="notify-customer", rows=old_rows), tid, "refund_task", "refund", parent=a["id"])
    nt.update({"id": new_obs_id(f"obs_{obs_prefix}_notify"), "startTime": t(11), "endTime": t(12),
               "latency": 1000, "input": f"notify customer of refund R-{case_no}", "output": "email sent"})
    rows.append(nt)
    mint_and_emit(rows)


refund_trace("tr_refund_7", toms("2025-08-31T20:30:00.000Z"), 7007, "sess_refund_7", "user_71", "refund7", 13)
refund_trace("tr_refund_8", toms("2025-08-31T19:40:00.000Z"), 7008, "sess_refund_8", "user_72", "refund8", 13)

# ================= chargeback_task: tr_charge_5..10 =================
def chargeback_trace(tid, root_ms, case_no, sess, user, obs_prefix, mode, model):
    """mode: 'after-error' (first call ERROR) | 'after-timeout' (gateway WARN between calls)."""
    base = root_ms
    t = (lambda s: iso(base + s * 1000))
    a = set_common(find("AGENT", name="chargeback-agent", rows=old_rows), tid, "chargeback_task", "chargeback")
    a.update({
        "id": new_obs_id(f"obs_{obs_prefix}_agent"), "name": "chargeback-agent",
        "isRootObservation": True, "parentObservationId": None,
        "startTime": t(0), "endTime": t(24), "latency": 24000,
        "input": f"Handle chargeback cb-{case_no}.", "output": "Charge reversed, case opened, bank notified.",
        "sessionId": sess, "userId": user,
    })
    rows = [a]
    aid = a["id"]
    ls = set_common(find("SPAN", name="ledger-lookup", rows=old_rows), tid, "chargeback_task", "chargeback", parent=aid)
    ls.update({"id": new_obs_id(f"obs_{obs_prefix}_span_l"), "startTime": t(1), "endTime": t(2),
               "latency": 1000, "input": f"lookup charge chg-{case_no}", "output": "charge found"})
    rows.append(ls)
    cl = set_common(find("TOOL", name="charge-lookup", rows=old_rows), tid, "chargeback_task", "chargeback", parent=aid)
    cl.update({"id": new_obs_id(f"obs_{obs_prefix}_tool_cl"), "startTime": t(2), "endTime": t(4),
               "latency": 2000, "input": f"read charge chg-{case_no}", "output": "status: disputed"})
    rows.append(cl)

    if mode == "after-error":
        first = set_common(find("TOOL", name="charge-reversal", level="ERROR", rows=old_rows),
                           tid, "chargeback_task", "chargeback", parent=aid, status="bank rejected reversal")
        first.update({"id": new_obs_id(f"obs_{obs_prefix}_tool_r1"), "level": "ERROR",
                      "startTime": t(4), "endTime": t(5), "latency": 1000,
                      "input": f"reverse chg-{case_no}", "output": "rejected: insufficient funds"})
    else:
        first = set_common(find("TOOL", name="charge-reversal", rows=old_rows),
                           tid, "chargeback_task", "chargeback", parent=aid)
        first.update({"id": new_obs_id(f"obs_{obs_prefix}_tool_r1"), "level": "INFO",
                      "startTime": t(4), "endTime": t(5), "latency": 1000,
                      "input": f"reverse chg-{case_no}", "output": "pending confirmation"})
    rows.append(first)

    g1 = set_common(find("GENERATION", model=model, rows=old_rows), tid, "chargeback_task", "chargeback", parent=aid)
    g1.update({"id": new_obs_id(f"obs_{obs_prefix}_gen_s"), "name": "case-summary",
               "startTime": t(5), "endTime": t(7), "latency": 2000,
               "input": f"Summarise cb-{case_no}", "output": "Summary written."})
    rows.append(g1)

    if mode == "after-timeout":
        gtw = set_common(find("SPAN", name="gateway-timeout", level="WARN", rows=old_rows),
                         tid, "chargeback_task", "chargeback", parent=aid, status="charge gateway timeout")
        gtw.update({"id": new_obs_id(f"obs_{obs_prefix}_span_to"), "level": "WARN",
                    "startTime": t(7), "endTime": t(12), "latency": 5000,
                    "input": f"await reversal ack chg-{case_no}", "output": "no ack received"})
        rows.append(gtw)

    ret = set_common(find("TOOL", name="charge-reversal", rows=old_rows), tid, "chargeback_task", "chargeback", parent=aid)
    ret.update({"id": new_obs_id(f"obs_{obs_prefix}_tool_r2"), "level": "INFO",
                "startTime": t(12) if mode == "after-timeout" else t(7),
                "endTime": t(15) if mode == "after-timeout" else t(10),
                "latency": 3000, "input": f"reverse chg-{case_no}",
                "output": f"reversed (id rev_{case_no})"})
    rows.append(ret)

    bw = set_common(find("SPAN", name="bank-watch", rows=old_rows), tid, "chargeback_task", "chargeback", parent=aid)
    bw.update({"id": new_obs_id(f"obs_{obs_prefix}_span_bw"),
               "startTime": t(15) if mode == "after-timeout" else t(10),
               "endTime": t(18) if mode == "after-timeout" else t(13),
               "latency": 3000, "input": "watch bank call", "output": "eventually accepted",
               "statusMessage": "" if mode == "after-timeout" else "bank delayed"})
    rows.append(bw)

    co = set_common(find("TOOL", name="case-open", rows=old_rows), tid, "chargeback_task", "chargeback", parent=aid)
    co.update({"id": new_obs_id(f"obs_{obs_prefix}_tool_co"),
               "startTime": t(18) if mode == "after-timeout" else t(13),
               "endTime": t(20) if mode == "after-timeout" else t(15),
               "latency": 2000, "input": f"open internal case cb-{case_no}",
               "output": f"case CA-{case_no} opened"})
    rows.append(co)

    g2 = set_common(find("GENERATION", model=model, rows=old_rows), tid, "chargeback_task", "chargeback", parent=aid)
    g2.update({"id": new_obs_id(f"obs_{obs_prefix}_gen_n"), "name": "case-notes",
               "startTime": t(20) if mode == "after-timeout" else t(15),
               "endTime": t(22) if mode == "after-timeout" else t(17),
               "latency": 2000, "input": f"Write notes cb-{case_no}", "output": "Notes written."})
    rows.append(g2)

    nb = set_common(find("TOOL", name="notify-bank", rows=old_rows), tid, "chargeback_task", "chargeback", parent=aid)
    nb.update({"id": new_obs_id(f"obs_{obs_prefix}_tool_nb"),
               "startTime": t(22) if mode == "after-timeout" else t(17),
               "endTime": t(24) if mode == "after-timeout" else t(19),
               "latency": 2000, "input": f"notify bank of reversal chg-{case_no}", "output": "bank notified"})
    rows.append(nb)
    mint_and_emit(rows)


chargeback_trace("tr_charge_5",  toms("2025-08-27T01:10:00.000Z"), 5005, "sess_charge_5",  "user_73",  "chg5",  "after-error",   "gpt-4o-mini")
chargeback_trace("tr_charge_6",  toms("2025-08-27T02:20:00.000Z"), 5006, "sess_charge_6",  "user_74",  "chg6",  "after-error",   "gpt-4o-mini")
chargeback_trace("tr_charge_7",  toms("2025-08-27T03:30:00.000Z"), 5007, "sess_charge_7",  "user_75",  "chg7",  "after-timeout", "gpt-4o-mini")
chargeback_trace("tr_charge_8",  toms("2025-08-27T04:45:00.000Z"), 5008, "sess_charge_8",  "user_76",  "chg8",  "after-timeout", "gpt-4o-mini")
chargeback_trace("tr_charge_9",  toms("2025-08-27T06:05:00.000Z"), 5009, "sess_charge_9",  "user_77",  "chg9",  "after-timeout", "gpt-4o")
chargeback_trace("tr_charge_10", toms("2025-08-27T07:15:00.000Z"), 5010, "sess_charge_10", "user_78",  "chg10", "after-error",   "gpt-4o-mini")

# ================= dispute_task: tr_dispute_6..12 =================
def dispute_trace(tid, root_ms, case_no, sess, user, obs_prefix, model, failed):
    base = root_ms
    t = (lambda s: iso(base + s * 1000))
    a = set_common(find("AGENT", name="dispute-agent", rows=old_rows), tid, "dispute_task", "dispute")
    a.update({
        "id": new_obs_id(f"obs_{obs_prefix}_agent"), "name": "dispute-agent",
        "isRootObservation": True, "parentObservationId": None,
        "startTime": t(0), "endTime": t(21), "latency": 21000,
        "input": f"Handle dispute ds-{case_no}.",
        "output": "Dispute processed." if not failed else "Dispute escalated.",
        "sessionId": sess, "userId": user,
    })
    rows = [a]
    aid = a["id"]
    pl = set_common(find("SPAN", name="policy-lookup", rows=old_rows), tid, "dispute_task", "dispute", parent=aid)
    pl.update({"id": new_obs_id(f"obs_{obs_prefix}_span_p"), "startTime": t(1), "endTime": t(2),
               "latency": 1000, "input": f"read policy for dispute ds-{case_no}", "output": "policy ok"})
    rows.append(pl)
    do = set_common(find("TOOL", name="dispute-open", rows=old_rows), tid, "dispute_task", "dispute", parent=aid)
    do.update({"id": new_obs_id(f"obs_{obs_prefix}_tool_o"), "startTime": t(3), "endTime": t(5),
               "latency": 2000, "input": f"open dispute ds-{case_no}", "output": f"docket D-{case_no}"})
    rows.append(do)
    g1 = set_common(find("GENERATION", model=model, rows=old_rows), tid, "dispute_task", "dispute", parent=aid)
    g1.update({"id": new_obs_id(f"obs_{obs_prefix}_gen_s"), "name": "dispute-summary",
               "startTime": t(6), "endTime": t(8), "latency": 2000,
               "input": f"Summarise dispute ds-{case_no}", "output": "Summary written."})
    rows.append(g1)
    eu = set_common(find("TOOL", name="evidence-upload", rows=old_rows), tid, "dispute_task", "dispute", parent=aid)
    eu.update({"id": new_obs_id(f"obs_{obs_prefix}_tool_e"), "startTime": t(10), "endTime": t(12),
               "latency": 2000, "input": f"upload evidence ds-{case_no}", "output": "evidence filed"})
    rows.append(eu)
    dc = set_common(find("TOOL", name="dispute-check", rows=old_rows), tid, "dispute_task", "dispute", parent=aid)
    if failed:
        dc.update({"id": new_obs_id(f"obs_{obs_prefix}_tool_c"), "level": "WARN",
                   "startTime": t(13), "endTime": t(15), "latency": 2000,
                   "input": f"assess evidence ds-{case_no}", "output": "evidence insufficient",
                   "statusMessage": "evidence insufficient"})
    else:
        dc.update({"id": new_obs_id(f"obs_{obs_prefix}_tool_c"), "level": "INFO",
                   "startTime": t(13), "endTime": t(15), "latency": 2000,
                   "input": f"assess evidence ds-{case_no}", "output": "evidence ok"})
    rows.append(dc)
    g2 = set_common(find("GENERATION", model=model, rows=old_rows), tid, "dispute_task", "dispute", parent=aid)
    g2.update({"id": new_obs_id(f"obs_{obs_prefix}_gen_d"), "name": "decision-letter",
               "startTime": t(16), "endTime": t(18), "latency": 2000,
               "input": f"Draft decision ds-{case_no}",
               "output": "Decision letter drafted." if not failed else "Escalation recommended."})
    rows.append(g2)
    if model == "gpt-4o":
        g3 = set_common(find("GENERATION", model="gpt-4o", rows=old_rows), tid, "dispute_task", "dispute", parent=aid)
        g3.update({"id": new_obs_id(f"obs_{obs_prefix}_gen_e"), "name": "escalation-note",
                   "startTime": t(18), "endTime": t(20), "latency": 2000,
                   "input": f"Note escalation ds-{case_no}", "output": "Escalation noted."})
        rows.append(g3)
    mint_and_emit(rows)


dispute_trace("tr_dispute_6",  toms("2025-08-28T14:00:00.000Z"), 6006, "sess_dispute_6",  "user_79",  "dsp6",  "gpt-4o",      False)
dispute_trace("tr_dispute_7",  toms("2025-08-29T06:00:00.000Z"), 6007, "sess_dispute_7",  "user_80",  "dsp7",  "gpt-4o",      False)
dispute_trace("tr_dispute_8",  toms("2025-08-29T14:30:00.000Z"), 6008, "sess_dispute_8",  "user_81",  "dsp8",  "gpt-4o",      False)
dispute_trace("tr_dispute_9",  toms("2025-08-30T09:00:00.000Z"), 6009, "sess_dispute_9",  "user_82",  "dsp9",  "gpt-4o",      False)
dispute_trace("tr_dispute_10", toms("2025-08-30T22:30:00.000Z"), 6010, "sess_dispute_10", "user_83",  "dsp10", "gpt-4o",      False)
dispute_trace("tr_dispute_11", toms("2025-08-31T08:00:00.000Z"), 6011, "sess_dispute_11", "user_84",  "dsp11", "gpt-4o",      True)
dispute_trace("tr_dispute_12", toms("2025-08-31T11:00:00.000Z"), 6012, "sess_dispute_12", "user_85",  "dsp12", "gpt-4o-mini", False)

print(f"authored new observation rows: {len(new_rows)}")

# ---------------- merge unique rows + sort desc + page pack ----------------
all_rows = []
seen = set()
for p in obs_pages:
    for r in p["data"]:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        all_rows.append(r)
for r in new_rows:
    assert r["id"] not in seen
    seen.add(r["id"])
    all_rows.append(r)

all_rows.sort(key=lambda r: (r.get("startTime") or "", r["id"]), reverse=True)

# duplicate-id fixture lines (byte-identical re-serves) ride the LAST page
dup_content = []
for r in all_rows:
    if r["id"] in ("obs_refund_tool_1", "obs_charge_tool_2") and not any(
        d["id"] == r["id"] for d in dup_content
    ):
        dup_content.append(deepcopy(r))

# parent/root discipline
by_id = {r["id"]: r for r in all_rows}
for r in all_rows:
    p = r.get("parentObservationId")
    if p:
        parent = by_id.get(p)
        assert parent is not None, f"missing parent {p} of {r['id']}"
        assert parent["traceId"] == r["traceId"], f"cross-trace parent on {r['id']}"
    if r.get("isRootObservation") is True:
        assert p is None, f"root-with-parent {r['id']}"

pages = [all_rows[i:i + PAGE_SIZE] for i in range(0, len(all_rows), PAGE_SIZE)]
# monotonicity is verified on the unique-row pages BEFORE the dup lines ride
# the last page (they are byte-identical re-serves and sit out of order —
# review N3 / DEC-19, the documented dedupe-fixture artifact)
for idx, pg in enumerate(pages):
    starts = [r.get("startTime") or "" for r in pg]
    assert starts == sorted(starts, reverse=True), f"page {idx + 1} not startTime-desc"
    if idx + 1 < len(pages):
        assert min(starts) >= max(r.get("startTime") or "" for r in pages[idx + 1]), \
            f"page {idx + 1}/{idx + 2} boundary not monotonic"
last_page = pages[-1]
last_ids = {r["id"] for r in last_page}
for d in dup_content:
    if d["id"] not in last_ids:
        last_page.append(d)
        last_ids.add(d["id"])
# last page now carries the documented dup-line artifact (out-of-order tail)

print(f"unique observation rows: {len(all_rows)}; obs pages: {len(pages)}; "
      f"lines (incl. {len(dup_content)} dup re-serves): {sum(len(p) for p in pages)}")

# ---------------- scores ----------------
def make_score(name, data_type, value, source, skind, tid, timestamp, obs_id=None,
               comment=None, author=None):
    s = find_score(name, data_type, source, skind, old_scores)
    sub = s.setdefault("subject", collections.OrderedDict())
    sub["kind"] = skind
    sub["id"] = obs_id if skind == "OBSERVATION" else tid
    sub["traceId"] = tid
    s["id"] = new_score_id(name)
    s["projectId"] = PROJECT
    s["traceId"] = tid
    s["dataType"] = data_type
    s["value"] = value
    s["source"] = source
    s["timestamp"] = timestamp
    s["environment"] = "production"
    if author:
        s["authorUserId"] = author
    else:
        s.pop("authorUserId", None)
    if comment is not None:
        s["comment"] = comment
    else:
        s.pop("comment", None)
    return s


NEW_SCORE_PREFIX = {
    "no-side-effect-retry": "score_doublecall_", "reversal-accuracy": "score_obs_",
    "chargeback-outcome": "score_charge_", "dispute-outcome": "score_dispute_",
    "model-efficiency": "score_eff_", "refund-correctness": "score_refund_",
}


def new_score_id(name):
    base = NEW_SCORE_PREFIX[name]
    n = 1
    while f"{base}{n}" in USED:
        n += 1
    USED.add(f"{base}{n}")
    return f"{base}{n}"


new_scores = []


def add_score(*args, **kw):
    s = make_score(*args, **kw)
    assert s["id"] not in {x["id"] for x in old_scores}
    new_scores.append(s)


# refund correctness evals
add_score("refund-correctness", "NUMERIC", 1, "EVAL", "TRACE", "tr_refund_7",
          add_minutes(toms("2025-08-31T20:30:00.000Z"), 10), comment="Correctly issued refund")
add_score("refund-correctness", "NUMERIC", 1, "EVAL", "TRACE", "tr_refund_8",
          add_minutes(toms("2025-08-31T19:40:00.000Z"), 10), comment="Correctly issued refund")

# chargeback evals: outcome + no-side-effect-retry False on every new double-call trace
cb = {
    "tr_charge_5": ("2025-08-27T01:10:00.000Z", 1), "tr_charge_6": ("2025-08-27T02:20:00.000Z", 1),
    "tr_charge_7": ("2025-08-27T03:30:00.000Z", 1), "tr_charge_8": ("2025-08-27T04:45:00.000Z", 1),
    "tr_charge_9": ("2025-08-27T06:05:00.000Z", 1), "tr_charge_10": ("2025-08-27T07:15:00.000Z", 0),
}
for tid, (root, val) in cb.items():
    root_ms = toms(root)
    add_score("chargeback-outcome", "NUMERIC", val, "EVAL", "TRACE", tid, add_minutes(root_ms, 20))
    add_score("no-side-effect-retry", "BOOLEAN", False, "EVAL", "TRACE", tid,
              add_minutes(root_ms, 30), comment="charge-reversal called twice")

# reversal-accuracy annotations on three retry calls (after-error and after-timeout)
for tid, root, prefix in [
    ("tr_charge_5", "2025-08-27T01:10:00.000Z", "chg5"),
    ("tr_charge_7", "2025-08-27T03:30:00.000Z", "chg7"),
    ("tr_charge_9", "2025-08-27T06:05:00.000Z", "chg9"),
]:
    retry = [r["id"] for r in new_rows if r["traceId"] == tid and r["id"].startswith(f"obs_{prefix}_tool_r2")]
    assert retry, f"no retry row for {tid}"
    add_score("reversal-accuracy", "BOOLEAN", False, "ANNOTATION", "OBSERVATION", tid,
              add_minutes(toms(root), 25), obs_id=retry[0],
              comment="duplicate reversal attempted", author="reviewer@acme")

# dispute evals
dp = {
    "tr_dispute_6": ("2025-08-28T14:00:00.000Z", 1), "tr_dispute_7": ("2025-08-29T06:00:00.000Z", 1),
    "tr_dispute_8": ("2025-08-29T14:30:00.000Z", 1), "tr_dispute_9": ("2025-08-30T09:00:00.000Z", 1),
    "tr_dispute_10": ("2025-08-30T22:30:00.000Z", 1), "tr_dispute_11": ("2025-08-31T08:00:00.000Z", 0),
    "tr_dispute_12": ("2025-08-31T11:00:00.000Z", 1),
}
for tid, (root, val) in dp.items():
    add_score("dispute-outcome", "NUMERIC", val, "EVAL", "TRACE", tid, add_minutes(toms(root), 20))
# model-efficiency on costlier gpt-4o dispute runs
add_score("model-efficiency", "NUMERIC", 0.4, "EVAL", "TRACE", "tr_dispute_9",
          add_minutes(toms("2025-08-30T09:00:00.000Z"), 35),
          comment="gpt-4o cost 12x mini with no faster resolution")
add_score("model-efficiency", "NUMERIC", 0.5, "EVAL", "TRACE", "tr_dispute_11",
          add_minutes(toms("2025-08-31T08:00:00.000Z"), 35),
          comment="costlier model on failed resolution")

print(f"authored new score rows: {len(new_scores)}")

all_scores = [deepcopy(s) for s in old_scores] + new_scores
all_scores.sort(key=lambda s: (s.get("timestamp") or "", s["id"]), reverse=True)
score_pages = [all_scores[i:i + PAGE_SIZE] for i in range(0, len(all_scores), PAGE_SIZE)]
print(f"score rows {len(all_scores)} -> {len(score_pages)} pages")

# ---------------- write fresh pages ----------------
for f in obs_files:
    os.remove(f)
for f in score_files:
    os.remove(f)


def write_pages(directory, prefix, pages):
    for idx, body in enumerate(pages, start=1):
        out = collections.OrderedDict()
        out["data"] = body
        meta = collections.OrderedDict()
        meta["cursor"] = f"{prefix}-{idx}" if idx < len(pages) else None
        out["meta"] = meta
        store(os.path.join(directory, f"page-{idx:02d}.json"), out)


write_pages(OBS_DIR, "cursor-obs", pages)
write_pages(SCORE_DIR, "cursor-scores", score_pages)

# ---------------- regenerate archive envelopes ----------------
def archive_lines(page_chunks, kind):
    lines = []
    seen = set()
    for page_ord, chunk in enumerate(page_chunks, start=1):
        for row in chunk:
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            env = collections.OrderedDict()
            env["v"] = 1
            env["kind"] = kind
            env["fetchedAt"] = INGEST_AT
            env["projectId"] = PROJECT
            env["source"] = "langfuse-v4"
            env["page"] = page_ord
            env["row"] = row
            lines.append(json.dumps(env, ensure_ascii=False, separators=(",", ":")))
    return lines


obs_archive = archive_lines(pages, "observation")
score_archive = archive_lines(score_pages, "score")
with open(os.path.join(ARCHIVE_DIR, "observations.jsonl"), "w") as f:
    f.write("\n".join(obs_archive) + "\n")
with open(os.path.join(ARCHIVE_DIR, "scores.jsonl"), "w") as f:
    f.write("\n".join(score_archive) + "\n")
print(f"archive obs lines: {len(obs_archive)}; score lines: {len(score_archive)}")

# ---------------- summary (for scenarios.ts) ----------------
bytrace = collections.defaultdict(list)
for r in all_rows:
    bytrace[r["traceId"]].append(r)
infos = {}
for tid, rs in bytrace.items():
    root = next((x for x in rs if x.get("isRootObservation") is True), rs[0])
    infos[tid] = {
        "task": root.get("traceName"), "agent": root.get("name"),
        "start": root.get("startTime"), "rows": len(rs),
    }
print("== traces ==")
for tid in sorted(infos, key=lambda t: infos[t]["start"]):
    i = infos[tid]
    print(f"{tid} | {i['task']} | {i['agent']} | {i['start']} | {i['rows']} rows")
print("taskKeys:", sorted({i["task"] for i in infos.values()}))
print("agents:", sorted({i["agent"] for i in infos.values()}))
print("traces:", len(infos))
print("models per dispute trace:", {
    tid: sorted({r.get("model") for r in bytrace[tid] if r.get("model")})
    for tid in bytrace if infos[tid]["task"] == "dispute_task"
})
