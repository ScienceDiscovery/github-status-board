"""Branch lines: configured and observed release branches viewed apart.

A run belongs to the line its work targets: a pull request's base branch, or
the branch a push, dispatch or schedule ran on. Everything that targets no
other line (release tags, unmatched runs) stays with the
default branch, so no run is counted twice.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

from .ci_lanes import PR_EVENTS, lane_of, pr_number, workflow_name

KEY_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,30}\Z")


def _historical_refs(entry):
    refs = []
    for item in entry.get("historical_refs") or []:
        if not isinstance(item, dict) or not isinstance(item.get("ref"), str) or not item["ref"]:
            continue
        before = item.get("before")
        try:
            cutoff = datetime.fromisoformat(before.replace("Z", "+00:00"))
            if cutoff.tzinfo is None:
                continue
        except (AttributeError, TypeError, ValueError):
            continue
        alias = {"ref": item["ref"], "before": cutoff.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")}
        if alias not in refs:
            refs.append(alias)
    return refs


def configured_lines(settings, default_branch, *, runs=(), prs=()):
    """Configured lines plus release branches observed in the supplied run window."""
    lines, seen = [], set()
    for entry in (settings or {}).get("branch_lines") or []:
        if not isinstance(entry, dict):
            continue
        key, ref = str(entry.get("key") or ""), str(entry.get("ref") or "")
        if KEY_RE.match(key) and ref and key not in seen and ref not in {line["ref"] for line in lines}:
            seen.add(key)
            line = {"key": key, "ref": ref}
            aliases = _historical_refs(entry)
            if aliases:
                line["historical_refs"] = aliases
            lines.append(line)
    # Discover from stored runs, including PR base branches; never list remote branches or old Actions pages.
    runs, prs = list(runs), list(prs)
    by_number = {pr.get("number"): pr for pr in prs}
    names = {row.get("workflow_id"): row["name"] for row in runs if row.get("name") and not re.search(r"\.ya?ml$", row["name"])}
    refs = set()
    for row in runs:
        ref = target_of(row, prs, by_number)
        if isinstance(ref, str) and ref.startswith(("release/", "releases/")) and ref.split("/", 1)[1]:
            if lane_of({**row, "name": workflow_name(row, names)}, (settings or {}).get("workflows"), ref):
                refs.add(ref)
    for ref in sorted(refs - {line["ref"] for line in lines} - {default_branch}):
        salt = 0
        while True:
            key = "release-" + hashlib.sha256(f"{ref}:{salt}".encode()).hexdigest()[:20]
            if key not in seen:
                break
            salt += 1
        seen.add(key)
        lines.append({"key": key, "ref": ref})
    default = next((line for line in lines if line["ref"] == default_branch), None)
    if not default:
        default = {"key": default_branch if KEY_RE.match(default_branch) else "default", "ref": default_branch}
    return [{**default, "default": True}] + [{**line, "default": False} for line in lines if line is not default]


def target_of(run, prs=(), by_number=None):
    """The branch a run's work targets; None for a PR run that cannot be matched."""
    if run.get("event") not in PR_EVENTS:
        return run.get("branch")
    if run.get("base_branch"):
        return run["base_branch"]
    number = pr_number(run, prs)
    return ((by_number or {}).get(number) or {}).get("base") if number else None


def _historical_line(target, lines, created_at):
    if not created_at:
        return None
    for line in lines:
        if any(alias["ref"] == target and created_at < alias["before"] for alias in line.get("historical_refs", [])):
            return line
    return None


def canonical_branch(branch, lines, created_at=None):
    """Use the current ref for a run from before a branch rename."""
    historical = _historical_line(branch, lines, created_at)
    return historical["ref"] if historical else branch


def line_of(target, lines, created_at=None):
    """Key of the configured line a target branch belongs to; the default otherwise."""
    historical = _historical_line(target, lines, created_at)
    if historical:
        return historical["key"]
    return next((line["key"] for line in lines[1:] if line["ref"] == target), lines[0]["key"])
