"""Lightweight current views backed by the complete public history."""
from copy import deepcopy
from datetime import timedelta
import hashlib
from zoneinfo import ZoneInfo

from .board import BoardStore
from .ci_lanes import build_lanes, window_start
from .collectors import Context, collect_ci, summarize_issues, summarize_prs, days_between
from .history import read_json, encode
from .public_sections import public_ops, public_tests, envelope
from .sync import stamp, date


SUPPLEMENT_TESTS_VERSION = 3
COVERAGE_TIMEZONE = ZoneInfo("Asia/Shanghai")


def _tests_revision(runs):
    identity = [[row["id"], row["attempt"], row.get("status"), row.get("conclusion"), row.get("updated_at")]
                for row in runs]
    return hashlib.sha256(encode(identity).encode()).hexdigest()[:16]


def _coverage_run(history, run_id, created_at):
    """Find the attempt that owned an artifact created for a workflow run."""
    if not run_id or not created_at:
        return None
    created = date(created_at)
    candidates = []
    for key, row in history.rows("runs"):
        if row.get("id") != run_id or not row.get("started_at"):
            continue
        if date(row["started_at"]) <= created:
            candidates.append((row.get("attempt", 1), key, row))
    if not candidates:
        return None
    _, key, row = max(candidates)
    return key, row


def _persist_coverage_summaries(history, coverage, default_branch):
    """Attach compact, complete coverage evidence to its canonical run record."""
    for language, dataset in (coverage.get("languages") or {}).items():
        for item in dataset.get("history", []):
            matched = _coverage_run(history, item.get("run_id"), item.get("created_at"))
            if not matched:
                continue
            key, index = matched
            if index.get("branch") != default_branch or index.get("conclusion") != "success":
                continue
            record = history.get("runs", key)
            if not record:
                continue
            summary = {k: item.get(k) for k in ("artifact", "run_id", "created_at", "sha", "kind", "totals")}
            summary["language"] = language
            summaries = {row.get("artifact"): row for row in record.get("coverage_summaries", [])}
            summaries[summary["artifact"]] = summary
            updated = sorted(summaries.values(), key=lambda row: (row.get("created_at") or "", row.get("artifact") or ""))
            if updated != record.get("coverage_summaries", []):
                record["coverage_summaries"] = updated
                history.put("runs", record)


def _daily_coverage_history(history, default_branch):
    """Latest successful complete result per Beijing calendar day and language."""
    daily = {}
    for key, index in history.rows("runs"):
        if index.get("branch") != default_branch or index.get("conclusion") != "success":
            continue
        record = history.get("runs", key)
        for item in (record or {}).get("coverage_summaries", []):
            created_at, language = item.get("created_at"), item.get("language")
            if not created_at or language not in ("node", "python"):
                continue
            day = date(created_at).astimezone(COVERAGE_TIMEZONE).date().isoformat()
            candidate = {**item, "day": day, "attempt": record.get("attempt")}
            identity = (language, day)
            previous = daily.get(identity)
            if not previous or (candidate["created_at"], candidate.get("artifact") or "") > (previous["created_at"], previous.get("artifact") or ""):
                daily[identity] = candidate
    return {
        language: sorted((row for (lang, _), row in daily.items() if lang == language), key=lambda row: row["day"])
        for language in ("node", "python")
    }


def build_snapshot(sync):
    history, state, meta = sync.history, sync.state, sync.meta
    old = read_json(history.root / "site/data/snapshot.json", {})
    supplements = read_json(history.root / ".sync/supplements.json", {})
    midnight = sync.now.replace(hour=0, minute=0, second=0)
    cutoff = stamp(midnight - timedelta(days=30))
    progress = sync.progress()
    # A successful poll with no changed records does not manufacture a Pages
    # deployment. Daily aging and health metadata still get a regular refresh.
    cache_upgrade = supplements.get("tests_version") != SUPPLEMENT_TESTS_VERSION
    # Snapshots published before the CI lanes existed are rebuilt once.
    old_ci = ((old.get("sections") or {}).get("ci") or {}).get("data") or {}
    old_tests = ((old.get("sections") or {}).get("tests") or {}).get("data")
    cache_upgrade = cache_upgrade or "lanes" not in old_ci or (isinstance(old_tests, dict) and "tagged" not in old_tests)
    if (not history.changed and not sync.tagged.changed and not cache_upgrade and old.get("sync") == progress
            and old.get("generated_at", "")[:10] == stamp(midnight)[:10]):
        return old
    cfg = sync.cfg
    cfg.stale_days = int(sync.settings.get("stale_days", 30))
    cfg.review_sla_days = int(sync.settings.get("review_sla_days", 3))
    def aged(rows):
        for row in rows:
            row["age_days"] = days_between(midnight, row.get("created_at"))
            row["idle_days"] = days_between(midnight, row.get("updated_at"))
        return rows
    open_issues = aged(history.select("issues", lambda r: r["state"] == "open"))
    closed_issues = aged(history.select("issues", lambda r: r["state"] == "closed" and (r.get("closed_at") or "") >= cutoff))
    open_prs = aged(history.select("prs", lambda r: r["state"] == "open"))
    closed_prs = aged(history.select("prs", lambda r: r["state"] == "closed" and (r.get("closed_at") or "") >= cutoff))
    counts = {"closed_total": history.aggregate.get("issues:state:closed", 0)}
    for days in (7, 30):
        lo = stamp(midnight - timedelta(days=days))[:10]
        for label, field in (("opened", "created_at"), ("closed", "closed_at")):
            prefix = "issues:" + field + ":"
            counts[f"{label}_{days}d"] = sum(v for k, v in history.aggregate.items() if k.startswith(prefix) and k[len(prefix):] >= lo)
    labels = {label["name"]: label for issue in open_issues for label in issue.get("labels", [])}
    issues = summarize_issues(open_issues, closed_issues, list(labels.values()), counts, cfg)
    prs = summarize_prs(open_prs, closed_prs, cfg, midnight)
    # The ordinary tabs/board show current work; archived objects are retrieved
    # by shard in History. Never prune canonical records when creating previews.
    issues["preview_total"] = len(issues["items"])
    prs["preview_total"] = len(prs["items"])
    issues["items"] = issues["items"][:200]
    issues["closed_recent"] = issues["closed_recent"][:100]
    prs["items"] = prs["items"][:200]
    runs = history.select("runs", limit=100)
    for run in runs:
        for report in run.get("tests", []):
            report["cases"] = []  # old renderer contract; no testcase records
    # Historical attempts remain in History. Current quality cards and CI rates
    # use the latest attempt for each run to avoid double counting reruns.
    index = {}
    for key, row in history.rows("runs"):
        previous = index.get(row["id"])
        if not previous or row["attempt"] > previous["attempt"]:
            index[row["id"]] = row
    # Index shards written before "event" joined the index lack the trigger;
    # read it from the record without rewriting those shards.
    for ident, row in list(index.items()):
        if "event" not in row:
            index[ident] = {**row, "event": (history.get("runs", history_key(row)) or {}).get("event")}
    runs = [r for r in runs if r["attempt"] == index[r["id"]]["attempt"]]
    class StoredCI:
        def get(self, path, params=None):
            if path.endswith("/actions/workflows"):
                return {"workflows": list({r["workflow_id"]: {"id": r["workflow_id"], "name": r["name"], "html_url": r["url"]} for r in index.values()}.values())}
            ident = path.split("/runs/")[1].split("/")[0]
            row = index.get(int(ident))
            record = history.get("runs", history_key(row)) if row else None
            return {"jobs": [{**j, "html_url": j["url"], "steps": [{"name": s, "conclusion": "failure"} for s in j.get("failed_steps", [])]} for j in (record or {}).get("jobs", [])]}
        def paginate(self, *_a, **_kw):
            return [{**r, "head_branch": r["branch"], "head_sha": r["sha"], "run_attempt": r["attempt"],
                     "html_url": r["url"], "run_started_at": r.get("started_at"), "display_title": r.get("title")}
                    for r in sorted(index.values(), key=lambda r: (r["created_at"], r["id"]), reverse=True)]
    ctx = Context(StoredCI(), cfg, midnight, meta)
    ci = collect_ci(ctx)
    # Lanes read complete records (event, linked PRs, head repository) for the
    # displayed window only, plus the PRs that were open during it.
    start = stamp(window_start(sync.now))
    lane_runs = [history.get("runs", history_key(row)) or row for row in index.values() if (row.get("created_at") or "") >= start]
    lane_prs = [history.get("prs", key) for key, row in history.rows("prs")
                if not row.get("closed_at") or row["closed_at"] >= start]
    ci["lanes"] = build_lanes(lane_runs, default_branch=meta["default_branch"], now=sync.now,
                              rules=sync.settings.get("workflows"), prs=[pr for pr in lane_prs if pr],
                              collected_since=None if progress["backfill"].get("runs", {}).get("complete")
                              else min((row["created_at"] for row in index.values()), default=None))
    wrap = lambda data: {"status": "ok", "data": data, "notes": [], "error": None}
    day = stamp(midnight)[:10]
    day_changed = supplements.get("day") != day
    tests_revision = _tests_revision(runs)
    tests_changed = (day_changed or cache_upgrade or supplements.get("tests_revision") != tests_revision
                     or "tests" not in supplements)
    if day_changed or "ops" not in supplements or tests_changed:
        public_ctx = Context(sync.gh.gh, cfg, midnight, meta)
        if day_changed or "ops" not in supplements:
            # Repository operations are intentionally a daily snapshot.
            supplements["ops"] = envelope(lambda: public_ops(public_ctx))
        if tests_changed:
            # Actions artifacts are live evidence: refresh when the source run set
            # changes, while retaining the daily fallback for repository-tree data.
            supplements["tests"] = envelope(lambda: public_tests(public_ctx, runs))
            supplements["tests_revision"] = tests_revision
            supplements["tests_version"] = SUPPLEMENT_TESTS_VERSION
        supplements["day"] = day
        state["supplements_changed"] = True
        history.changed[".sync/supplements.json"] = encode(supplements)
    tests = deepcopy(supplements.get("tests", wrap({})))
    if isinstance(tests.get("data"), dict):
        tests["data"]["tagged"] = sync.tagged.view()
    coverage = (tests.get("data") or {}).get("coverage") or {}
    _persist_coverage_summaries(history, coverage, meta.get("default_branch"))
    daily_coverage = _daily_coverage_history(history, meta.get("default_branch"))
    for language, dataset in (coverage.get("languages") or {}).items():
        dataset["history"] = daily_coverage.get(language, [])
    latest_reports = {}
    for r in runs:
        for t in r["tests"]:
            latest_reports.setdefault(t["name"], (r, t))
    if tests.get("data"):
        # Refresh test metrics without re-fetching the repository tree/Codecov.
        tests["data"]["executed"] = [{"artifact": t["name"], "layer": "ut" if t["layer"] == "unit" else t["layer"],
            "status": "incomplete" if t.get("counts") is None else "failed" if t["counts"]["failed"] else "unstable" if t["counts"]["flaky"] or t["counts"]["skipped"] else "passed",
            "run_id": r["id"], "sha": r["sha"], "attempt": r["attempt"], "branch": r["branch"], "created_at": r["updated_at"],
            "totals": t.get("counts"), "duration_ms": None, "detail": {"files": [], "failures": [], "projects": [], "stats": {}}}
            for r, t in latest_reports.values()]
    for row in history.select("runs", lambda r: bool(r.get("channel")), limit=100):
        if row.get("coverage") and tests.get("data") and not tests["data"].get("coverage", {}).get("languages"):
            tests["data"]["coverage"].update(source=f"Actions run {row['id']} / attempt {row['attempt']}", value=row["coverage"][0])
            break
    releases = history.select("releases", limit=30)
    for release in releases:
        release["validation_run_ids"] = [r["id"] for r in runs if r["sha"] == release["sha"] and r["channel"] == "release"]
    repo = {k: meta.get(k) for k in ("description", "default_branch", "language", "pushed_at")}
    repo.update(stars=meta.get("stargazers_count"), forks=meta.get("forks_count"), license=(meta.get("license") or {}).get("spdx_id"))
    doc = {"schema_version": 2, "generated_at": stamp(sync.now), "repo": sync.repo, "repo_url": meta["html_url"],
           "repository": {"name": sync.repo, "url": meta["html_url"], **repo}, "sync": progress,
           "history": {"manifest": "./data/history/manifest.json", "totals": history.manifest["totals"]},
           "issues": issues, "prs": prs, "quality": {"runs": runs, "required_checks": old.get("quality", {}).get("required_checks"),
               "workflows": ci["workflows"], "status": "available"}, "releases": releases, "notices": [],
           "sections": {"repo": wrap(repo), "issues": wrap(issues), "prs": wrap(prs), "ci": wrap(ci),
                        "tests": tests, "ops": supplements.get("ops", wrap({}))},
           "config": {"artifact_names": cfg.artifact_names, "stale_days": cfg.stale_days, "review_sla_days": cfg.review_sla_days, "pr_idle_days": cfg.pr_idle_days}}
    doc["board"] = BoardStore(cfg, persist=False).payload(doc)
    doc["details"] = {f"{kind}:{r['number']}": {"body": r.get("body", ""), "cross_references": []}
                      for kind, rows in (("issue", issues["items"] + issues["closed_recent"]), ("pr", prs["items"] + prs["recent_merged"] + prs["recent_closed_unmerged"])) for r in rows}
    return doc


def history_key(row):
    return f"{row['id']}-{row['attempt']}"
