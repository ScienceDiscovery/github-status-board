"""Build a public, read-only project management snapshot from GitHub evidence."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import re
import zipfile
from urllib.parse import quote

from .collectors import Context, collect_issues, collect_prs
from .config import Config
from .github import GitHubError
from .reports import artifact_layer, parse_report_zip

REPO_RE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")


def channel(run, rules):
    for kind in ("release", "daily"):
        if any(re.search(pattern, run.get("name", ""), re.I) for pattern in rules.get(kind, [])):
            return kind
    if run.get("event") == "release" or re.search(r"release|version|版本|发布", run.get("name", ""), re.I):
        return "release"
    if run.get("event") == "schedule" or re.search(r"nightly|daily|每日|夜间", run.get("name", ""), re.I):
        return "daily"
    return "gate"


def slim_run(run, rules):
    return {"id": run["id"], "name": run.get("name"), "workflow_id": run.get("workflow_id"),
            "channel": channel(run, rules), "event": run.get("event"), "status": run.get("status"),
            "conclusion": run.get("conclusion"), "branch": run.get("head_branch"), "sha": run.get("head_sha"),
            "attempt": run.get("run_attempt", 1), "created_at": run.get("created_at"),
            "started_at": run.get("run_started_at"), "updated_at": run.get("updated_at"), "url": run.get("html_url"),
            "pull_requests": [p["number"] for p in run.get("pull_requests", [])], "tests": [], "jobs": [],
            "reports_status": "not_inspected"}


def run_details(gh, cfg, run):
    base = f"/repos/{cfg.repo}/actions/runs/{run['id']}"
    try:
        jobs = gh.paginate(base + f"/attempts/{run['attempt']}/jobs", key="jobs", max_pages=2)
        run["jobs"] = [{"name": j.get("name"), "status": j.get("status"), "conclusion": j.get("conclusion"),
                        "url": j.get("html_url"), "failed_steps": [s["name"] for s in j.get("steps", []) if s.get("conclusion") == "failure"]}
                       for j in jobs]
    except GitHubError:
        run["jobs_status"] = "unavailable"
    try:
        artifacts = gh.paginate(base + "/artifacts", key="artifacts", max_pages=3)
    except GitHubError:
        run["reports_status"] = "unavailable"
        return run
    run["reports_status"] = "missing"
    for artifact in artifacts:
        name = artifact["name"]
        if not re.search(r"results|junit|playwright|test.report|dashboard", name, re.I):
            continue
        association = artifact.get("workflow_run") or {}
        if association.get("head_sha") and association["head_sha"] != run["sha"]:
            continue
        # Artifacts survive reruns. Never attribute an earlier attempt to this one.
        if run["attempt"] > 1 and artifact.get("created_at", "") < (run.get("started_at") or ""):
            continue
        entry = {"name": name, "layer": artifact_layer(name), "artifact_id": artifact["id"],
                 "created_at": artifact.get("created_at"), "url": run["url"] + f"/artifacts/{artifact['id']}",
                 "status": "expired" if artifact.get("expired") else "unavailable", "counts": None, "cases": []}
        if not artifact.get("expired"):
            try:
                if artifact.get("size_in_bytes", 0) > cfg.artifact_max_bytes:
                    raise ValueError("artifact over budget")
                parsed = parse_report_zip(gh.download_artifact(cfg.repo, artifact["id"], max_bytes=cfg.artifact_max_bytes))
                if parsed:
                    entry.update(status="available", counts={k: parsed[k] for k in ("tests", "passed", "failed", "skipped", "flaky")},
                                 cases=parsed["cases"], format=parsed["format"])
                else:
                    entry["status"] = "no_counts"
            except (GitHubError, ValueError, OSError, zipfile.BadZipFile, RuntimeError):
                pass
        run["tests"].append(entry)
    if run["tests"]:
        run["reports_status"] = "available" if all(t["counts"] is not None for t in run["tests"]) else "partial"
    return run


def build_project(gh, repo, settings=None):
    if not REPO_RE.fullmatch(repo):
        raise ValueError("expected owner/repository")
    settings = settings or {}
    meta = gh.get(f"/repos/{repo}")
    if meta.get("private") or meta.get("visibility", "public") != "public":
        raise ValueError("public dashboard export only accepts public source repositories")
    cfg = Config(repo=repo, review_sla_days=int(settings.get("review_sla_days", 3)),
                 stale_days=int(settings.get("stale_days", 30)))
    now = datetime.now(timezone.utc)
    context = Context(gh, cfg, now, meta)
    doc = {"schema_version": 1, "generated_at": now.isoformat(), "repository": {
        "name": repo, "url": meta["html_url"], "description": meta.get("description"),
        "default_branch": meta["default_branch"], "stars": meta.get("stargazers_count", 0)},
        "issues": None, "prs": None, "quality": {"runs": [], "workflows": [], "required_checks": None},
        "releases": [], "notices": [], "limits": {"open_issues": 500, "open_prs": 200, "runs": 100, "detailed_runs": 12}}
    # Reuse the existing metadata collectors. No private ops, traffic, auth or security data is exported.
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = {"issues": pool.submit(collect_issues, context), "prs": pool.submit(collect_prs, context)}
        for section, future in pending.items():
            try:
                value = future.result()
                notes = value.pop("notes", [])
                doc[section] = value
                if notes:
                    doc["notices"].append({"section": section, "message": "部分补充信息不可读取，请以 GitHub 原页面为准。"})
            except GitHubError:
                doc["notices"].append({"section": section, "message": "GitHub 数据读取失败；未将缺失数据计为零。"})
    rules = settings.get("workflows", {})
    try:
        raw_runs = gh.get(f"/repos/{repo}/actions/runs", {"per_page": 100}).get("workflow_runs", [])
        runs = sorted([slim_run(r, rules) for r in raw_runs], key=lambda r: r.get("created_at") or "", reverse=True)
        workflows = gh.get(f"/repos/{repo}/actions/workflows").get("workflows", [])
        doc["quality"]["workflows"] = [{k: w.get(k) for k in ("id", "name", "path", "state", "html_url")} for w in workflows]
        # Inspect latest per lane/workflow first, then fill remaining slots with recent runs.
        selected, seen = [], set()
        for run in runs:
            key = (run["workflow_id"], run["channel"])
            if key not in seen:
                seen.add(key)
                selected.append(run)
        selected = (selected + [r for r in runs if r not in selected])[:12]
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda r: run_details(gh, cfg, r), selected))
        doc["quality"]["runs"] = runs
        doc["quality"]["status"] = "available"
    except GitHubError:
        doc["quality"]["status"] = "unavailable"
        doc["notices"].append({"section": "quality", "message": "Actions 数据不可读取，构建与测试结果未知。"})
    try:
        branch = quote(meta["default_branch"], safe="")
        branch_meta = gh.get(f"/repos/{repo}/branches/{branch}")
        doc["quality"]["branch_protected"] = branch_meta.get("protected")
        if branch_meta.get("protected"):
            protection = gh.get(f"/repos/{repo}/branches/{branch}/protection")
            checks = protection.get("required_status_checks") or {}
            doc["quality"]["required_checks"] = list(dict.fromkeys(checks.get("contexts", []) + [c["context"] for c in checks.get("checks", [])]))
    except GitHubError:
        pass
    try:
        for release in gh.get(f"/repos/{repo}/releases", {"per_page": 15}):
            if release.get("draft"):
                continue
            tag = release["tag_name"]
            try:
                sha = gh.get(f"/repos/{repo}/commits/{quote(tag, safe='')}")["sha"]
            except GitHubError:
                sha = None
            matched = [r for r in doc["quality"]["runs"] if sha and r["sha"] == sha and r["channel"] == "release"]
            doc["releases"].append({"tag": tag, "name": release.get("name") or tag, "prerelease": release.get("prerelease"),
                                    "published_at": release.get("published_at"), "url": release["html_url"], "sha": sha,
                                    "validation_run_ids": [r["id"] for r in matched]})
    except GitHubError:
        doc["notices"].append({"section": "releases", "message": "版本列表读取失败。"})
    # Never accidentally include the collector credential in public output.
    if gh.token and gh.token in json.dumps(doc, ensure_ascii=False):
        raise ValueError("credential detected in export")
    return doc
