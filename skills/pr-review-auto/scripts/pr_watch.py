#!/usr/bin/env python3
"""Watch a GitHub PR and print one JSON line per event worth waking the agent for.

Run under the Monitor tool: stdout is the event stream. State lives in
~/.cache/hangar-pr-watch/ so re-arming after the 30 min Monitor cap does not re-emit.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

QUERY = """
query($o:String!,$r:String!,$n:Int!){viewer{login}
 repository(owner:$o,name:$r){pullRequest(number:$n){
  state isDraft mergeable headRefOid url
  reviewThreads(first:100){totalCount nodes{id isResolved isOutdated path line
   root:comments(first:1){nodes{databaseId}}
   comments(last:1){nodes{databaseId author{login} url body}}}}
  reviews(last:30){nodes{databaseId author{login} state commit{oid} body url}}
  comments(last:30){nodes{databaseId author{login} url body}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename
   ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}}
"""
BOT = "coderabbitai"
OK = {"SUCCESS", "SKIPPED", "NEUTRAL"}
PENDING = {"PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"}


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def preview(text, n=240):
    text = re.sub(r"<!--.*?-->", "", text or "", flags=re.S)
    return " ".join(text.split())[:n]


def fetch(owner, repo, number):
    out = subprocess.run(
        ["gh", "api", "graphql", "-f", f"query={QUERY}", "-F", f"o={owner}", "-F", f"r={repo}", "-F", f"n={number}"],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:300])
    data = json.loads(out.stdout, strict=False)
    if data.get("errors"):
        raise RuntimeError(str(data["errors"])[:300])
    return data["data"]["viewer"]["login"], data["data"]["repository"]["pullRequest"]


def snapshot(me, pr):
    head = pr["headRefOid"]
    if pr["reviewThreads"]["totalCount"] > 100:
        raise RuntimeError("more than 100 review threads; the watcher only reads the first page")
    threads = []
    for t in pr["reviewThreads"]["nodes"]:
        if t["isResolved"]:
            continue
        last = (t["comments"]["nodes"] or [{}])[-1]
        threads.append({
            "id": t["id"], "root_comment_id": (t["root"]["nodes"] or [{}])[0].get("databaseId"),
            "path": t["path"], "line": t["line"], "outdated": t["isOutdated"],
            "last_by": (last.get("author") or {}).get("login"), "last_id": last.get("databaseId"),
            "url": last.get("url"), "text": preview(last.get("body")),
        })
    # The agent's own replies must not wake it: a thread only counts by its last foreign note.
    waiting_on_other = [t for t in threads if t["last_by"] != me]
    reviews = [
        {"id": r["databaseId"], "url": r["url"], "nitpicks": "Nitpick comments" in (r["body"] or ""),
         "text": preview(r["body"])}
        for r in pr["reviews"]["nodes"]
        if (r["author"] or {}).get("login") == BOT and (r["commit"] or {}).get("oid") == head
    ]
    bot_comments = [
        {"id": c["databaseId"], "url": c["url"], "text": preview(c["body"])}
        for c in pr["comments"]["nodes"] if (c["author"] or {}).get("login") == BOT
    ]
    checks, coderabbit = {}, None
    nodes = (pr["commits"]["nodes"] or [{}])[0].get("commit", {}).get("statusCheckRollup") or {}
    for c in (nodes.get("contexts") or {}).get("nodes", []):
        if c["__typename"] == "StatusContext":
            name, st = c["context"], c["state"]
        else:
            name, st = c["name"], (c["conclusion"] or c["status"])
        if name == "CodeRabbit":
            coderabbit = st
        else:
            checks[name] = st
    failed = sorted(n for n, s in checks.items() if s not in OK and s not in PENDING)
    pending = sorted(n for n, s in checks.items() if s in PENDING)
    return {
        "head": head, "state": pr["state"], "draft": pr["isDraft"], "mergeable": pr["mergeable"],
        "coderabbit": coderabbit, "threads": threads, "waiting_on_other": waiting_on_other,
        "reviews_on_head": reviews, "bot_comments": bot_comments[-3:], "failed": failed,
        "pending": pending, "url": pr["url"],
    }


def wake_signature(s):
    """What changes here deserves a wake-up; pending CI progress does not."""
    key = {
        "head": s["head"], "coderabbit": s["coderabbit"], "failed": s["failed"],
        "mergeable": s["mergeable"] == "CONFLICTING", "draft": s["draft"],
        "threads": sorted((t["id"], t["last_id"]) for t in s["waiting_on_other"]),
        "reviews": sorted(r["id"] for r in s["reviews_on_head"]),
        "bot_comments": [c["id"] for c in s["bot_comments"]],
    }
    return hashlib.sha1(json.dumps(key, sort_keys=True).encode()).hexdigest()


def ready(s):
    return (s["state"] == "OPEN" and not s["draft"] and s["mergeable"] == "MERGEABLE"
            and s["coderabbit"] == "SUCCESS" and not s["threads"] and not s["failed"] and not s["pending"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pr", type=int)
    ap.add_argument("--repo", default="jeffer1312/hangar")
    ap.add_argument("--interval", type=int, default=60)
    ap.add_argument("--stable", type=int, default=90)
    ap.add_argument("--window", type=int, default=29 * 60)
    ap.add_argument("--duration", type=int, default=24 * 3600)
    ap.add_argument("--reset", action="store_true", help="forget the saved state and emit the current snapshot")
    ap.add_argument("--once", action="store_true", help="print the current snapshot and exit")
    a = ap.parse_args()
    owner, repo = a.repo.split("/")

    if a.once:
        me, pr = fetch(owner, repo, a.pr)
        s = snapshot(me, pr)
        s["ready"] = ready(s)
        emit(s)
        return

    state_file = Path.home() / ".cache" / "hangar-pr-watch" / f"{owner}_{repo}_{a.pr}.json"
    state_file.parent.mkdir(parents=True, exist_ok=True)
    st = {} if a.reset or not state_file.exists() else json.loads(state_file.read_text())
    st.setdefault("started", time.time())
    save = lambda: state_file.write_text(json.dumps(st))  # noqa: E731
    save()

    window_end = time.time() + a.window
    failures, stable_since, stable_sig = 0, 0.0, None
    while True:
        now = time.time()
        if now - st["started"] > a.duration:
            emit({"control": "expired", "pr": a.pr})
            return
        if now > window_end:
            emit({"control": "window_ended", "pr": a.pr})
            return
        try:
            me, pr = fetch(owner, repo, a.pr)
            s = snapshot(me, pr)
        except Exception as e:  # network, auth, rate limit: retry silently, warn once
            failures += 1
            if failures == 3:
                emit({"event": "query_failed", "pr": a.pr, "error": str(e)})
            time.sleep(a.interval)
            continue
        if failures >= 3:
            emit({"event": "query_recovered", "pr": a.pr})
        failures = 0

        if s["state"] != "OPEN":
            emit({"event": "closed", "pr": a.pr, "state": s["state"], "url": s["url"]})
            state_file.unlink(missing_ok=True)
            return

        sig = wake_signature(s)
        if sig != st.get("sig"):
            st["sig"] = sig
            save()
            emit({"event": "change", "pr": a.pr, **{k: v for k, v in s.items() if k != "waiting_on_other"}})

        full = sig + json.dumps([s["pending"], s["mergeable"], len(s["threads"])])
        if ready(s):
            if full != stable_sig:
                stable_sig, stable_since = full, now
            elif now - stable_since >= a.stable and st.get("ready_sig") != full:
                st["ready_sig"] = full
                save()
                emit({"event": "ready", "pr": a.pr, "head": s["head"], "url": s["url"]})
        else:
            stable_sig = None
        time.sleep(a.interval if not ready(s) else min(a.interval, 30))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
