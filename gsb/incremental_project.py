"""Lightweight current views backed by the complete public history."""
from copy import deepcopy
from datetime import timedelta
import hashlib

from .board import BoardStore
from .collectors import Context, collect_ci, summarize_issues, summarize_prs, days_between
from .history import read_json, encode
from .public_sections import public_ops, public_tests, envelope
from .sync import stamp, date


SUPPLEMENT_TESTS_VERSION = 2


def _tests_revision(runs):
    identity = [[row["id"], row["attempt"], row.get("status"), row.get("conclusion"), row.get("updated_at")]
                for row in runs]
    return hashlib.sha256(encode(identity).encode()).hexdigest()[:16]


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
    if (not history.changed and not cache_upgrade and old.get("sync") == progress
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
