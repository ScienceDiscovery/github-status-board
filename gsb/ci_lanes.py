"""CI history lanes: PR, default branch, daily and release runs on one calendar.

Each lane follows how the source repository triggers its Actions. All lanes
share the same day axis in one fixed display zone; runs of one day stay in
creation order so the page can stack them earliest-first.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
import re

WINDOW_DAYS = 30
# The team reads the board in Asia/Shanghai, which has no daylight saving.
DISPLAY_ZONE = timezone(timedelta(hours=8), "UTC+8")
LANES = (("pr", "PR"), ("main", "主干"), ("daily", "Daily"), ("release", "版本"))
# Mirrors board-config.json so a site without that section still classifies runs.
DEFAULT_RULES = {"gate": ["^CI$"], "daily": ["nightly", "daily", "每日"], "release": ["release", "version", "版本"]}
PR_EVENTS = ("pull_request", "pull_request_target")
FAILED = ("failure", "timed_out", "startup_failure")
CANCELLED = ("cancelled", "skipped")


def parse(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


def window_start(now, days=WINDOW_DAYS, zone=DISPLAY_ZONE):
    """UTC instant of the first displayed local midnight."""
    first = now.astimezone(zone).date() - timedelta(days=days - 1)
    return datetime(first.year, first.month, first.day, tzinfo=zone).astimezone(timezone.utc)


def workflow_name(run, names=None):
    # GitHub names a run after its file path when the workflow file failed to
    # parse; reuse the workflow's real name, else fall back to the file stem.
    name = run.get("name") or ""
    if name and not re.search(r"\.ya?ml$", name):
        return name
    return (names or {}).get(run.get("workflow_id")) or re.sub(r"\.ya?ml$", "", name.rsplit("/", 1)[-1])


def outcome(run):
    if run.get("status") not in (None, "completed"):
        return "running"
    conclusion = run.get("conclusion")
    if conclusion == "success":
        return "success"
    if conclusion in FAILED:
        return "failure"
    if conclusion in CANCELLED:
        return "cancelled"
    return "other"


def lane_of(run, rules=None, default_branch="main"):
    """Return a lane key, "called" for reusable-workflow children, "unknown" or "other"."""
    rules = {**DEFAULT_RULES, **{kind: patterns for kind, patterns in (rules or {}).items() if patterns}}
    name, event = run.get("name") or "", run.get("event")
    matches = lambda kind: any(re.search(pattern, name, re.I) for pattern in rules[kind])
    if event == "workflow_call":
        return "called"
    # Nightly and Release call CI; their own runs already represent that work.
    if matches("release"):
        return "release"
    if matches("daily"):
        return "daily"
    if not matches("gate"):
        return "other"
    if event in PR_EVENTS:
        return "pr"
    if event == "workflow_dispatch":
        return "main"
    if event == "push":
        return "main" if run.get("branch") == default_branch else "other"
    if event is None:
        # Degraded record without its trigger: only a linked PR is certain.
        return "pr" if run.get("pull_requests") else "unknown"
    # CI itself runs on PRs, pushes and dispatch; anything else came from a caller.
    return "called"


def pr_number(run, prs=()):
    linked = run.get("pull_requests") or []
    if linked:
        first = linked[0]
        return first.get("number") if isinstance(first, dict) else first
    if run.get("event") not in PR_EVENTS:
        return None
    # GitHub leaves pull_requests empty for fork PRs. Match the open PR with the
    # same head branch; head repository, SHA and title only break ties.
    created = parse(run.get("created_at"))
    if not created or not run.get("branch"):
        return None
    found = []
    for pr in prs:
        opened, closed = parse(pr.get("created_at")), parse(pr.get("closed_at"))
        if pr.get("head") == run["branch"] and opened and opened <= created and not (closed and closed < created):
            found.append(pr)
    if run.get("head_repo"):
        found = [pr for pr in found if pr.get("head_repo") in (None, run["head_repo"])]
    for same in (lambda pr: pr.get("head_sha") == run.get("sha"), lambda pr: pr.get("title") == run.get("title")):
        if len(found) > 1:
            found = [pr for pr in found if same(pr)] or found
    return found[0].get("number") if len(found) == 1 else None


def build_lanes(runs, *, default_branch, now, rules=None, prs=(), days=WINDOW_DAYS, zone=DISPLAY_ZONE,
                collected_since=None):
    """Group the latest attempt of each run into lanes aligned on one day axis."""
    first = now.astimezone(zone).date() - timedelta(days=days - 1)
    axis = [first + timedelta(days=offset) for offset in range(days)]
    position = {day: index for index, day in enumerate(axis)}
    names = {run.get("workflow_id"): run["name"] for run in runs
             if run.get("name") and not re.search(r"\.ya?ml$", run["name"])}
    latest = {}
    for run in runs:
        previous = latest.get(run.get("id"))
        if previous is None or (run.get("attempt") or 1) > (previous.get("attempt") or 1):
            latest[run.get("id")] = run
    cells = {key: [[] for _ in axis] for key, _ in LANES}
    excluded = Counter()
    for run in latest.values():
        created = parse(run.get("created_at"))
        if not created:
            continue
        # A rerun keeps the run's creation day, so attempts never move columns.
        local = created.astimezone(zone)
        day = position.get(local.date())
        if day is None:
            continue
        name = workflow_name(run, names)
        key = lane_of({**run, "name": name}, rules, default_branch)
        if key not in cells:
            excluded[key] += 1
            continue
        cells[key][day].append((created, run.get("id") or 0, {
            "id": run.get("id"), "attempt": run.get("attempt") or 1, "url": run.get("url"), "workflow": name,
            "event": run.get("event"), "manual": run.get("event") == "workflow_dispatch",
            "status": run.get("status"), "conclusion": run.get("conclusion"), "outcome": outcome(run),
            "branch": run.get("branch"), "sha": (run.get("sha") or "")[:7],
            "pr": pr_number(run, prs), "pr_linked": bool(run.get("pull_requests")),
            "title": (run.get("title") or "")[:120], "created_at": run.get("created_at"),
            "time": local.strftime("%H:%M")}))
    lanes = []
    for key, label in LANES:
        columns = [[cell for _, _, cell in sorted(column, key=lambda item: item[:2])] for column in cells[key]]
        counts = Counter(cell["outcome"] for column in columns for cell in column)
        decided = counts["success"] + counts["failure"]
        lanes.append({"key": key, "label": label, "days": columns, "summary": {
            "total": sum(counts.values()), **{name: counts[name] for name in ("success", "failure", "cancelled", "running", "other")},
            "success_rate": round(counts["success"] * 100 / decided, 1) if decided else None}})
    since = parse(collected_since)
    since = since.astimezone(zone).date() if since else None
    return {"days": [day.isoformat() for day in axis], "window_days": days, "zone": zone.tzname(None),
            "order": "earliest_first", "collected_since": since.isoformat() if since and since > first else None,
            "lanes": lanes, "excluded": dict(excluded)}
