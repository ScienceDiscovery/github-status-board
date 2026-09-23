"""Public test summaries: parse structured reports without publishing logs or traces."""
from __future__ import annotations

import io
import json
import re
import zipfile
from xml.etree import ElementTree as ET

from .tagged import extract as extract_tagged
from .testparse import parse_run_log, COVERAGE_FILE_RE, parse_coverage_file

FIELDS = ("passed", "failed", "skipped", "flaky")


def totals(cases):
    out = {key: sum(c["status"] == key for c in cases) for key in FIELDS}
    return {"tests": len(cases), **out}


def playwright(doc):
    cases = []

    def walk(suite):
        for spec in suite.get("specs", []):
            for test in spec.get("tests", []):
                states = [r.get("status") for r in test.get("results", [])]
                status = test.get("status")
                # Playwright's outcome accounts for expected failures and retries.
                if status in ("expected", "unexpected", "flaky", "skipped"):
                    outcome = {"expected": "passed", "unexpected": "failed"}.get(status, status)
                elif not states or states[-1] == "skipped":
                    outcome = "skipped"
                elif states[-1] == "passed":
                    outcome = "flaky" if any(s in ("failed", "timedOut") for s in states[:-1]) else "passed"
                else:
                    outcome = "failed"
                cases.append({"name": str(spec.get("title", ""))[:300], "file": str(spec.get("file", suite.get("file", "")))[:300],
                              "project": str(test.get("projectName", ""))[:100], "status": outcome})
        for child in suite.get("suites", []):
            walk(child)

    for suite in doc.get("suites", []):
        walk(suite)
    if not cases:
        stats = doc.get("stats", {})
        if not all(isinstance(stats.get(k), int) and stats[k] >= 0 for k in ("expected", "unexpected", "skipped", "flaky")):
            return None
        counts = dict(zip(FIELDS, (stats[k] for k in ("expected", "unexpected", "skipped", "flaky"))))
        return {"tests": sum(counts.values()), **counts, "cases": [], "format": "playwright"}
    return {**totals(cases), "cases": cases[:500], "format": "playwright"}


def junit(text):
    root = ET.fromstring(text)
    cases = []
    for item in root.iter("testcase"):
        status = ("skipped" if item.find("skipped") is not None else
                  "failed" if item.find("failure") is not None or item.find("error") is not None else
                  "flaky" if item.find("flakyFailure") is not None or item.find("flakyError") is not None else "passed")
        cases.append({"name": str(item.get("name", ""))[:300], "file": str(item.get("file") or item.get("classname", ""))[:300], "status": status})
    if cases:
        return {**totals(cases), "cases": cases[:500], "format": "junit"}
    # Count leaf suites only: parent aggregates must not double-count children.
    counts = {key: 0 for key in ("tests", *FIELDS)}
    suites = [s for s in root.iter("testsuite") if not list(s.iter("testsuite"))[1:]]
    for suite in suites:
        n = int(suite.get("tests", 0))
        failed = int(suite.get("failures", 0)) + int(suite.get("errors", 0))
        skipped = int(suite.get("skipped", 0))
        if min(n, failed, skipped) < 0 or failed + skipped > n:
            raise ValueError("inconsistent JUnit counts")
        counts["tests"] += n
        counts["failed"] += failed
        counts["skipped"] += skipped
        counts["passed"] += n - failed - skipped
    return {**counts, "cases": [], "format": "junit"} if suites else None


def artifact_layer(name):
    name = name.lower()
    if re.search(r"e2e|playwright|end.to.end", name):
        return "e2e"
    if re.search(r"(^|[-_])(st|integration|system)([-_]|$)", name):
        return "st"
    if re.search(r"(^|[-_])(ut|unit)([-_]|$)", name):
        return "unit"
    return "other"


def parse_report_zip(blob):
    """Choose one report family per artifact, avoiding JSON/XML/log double counts."""
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        entries = archive.infolist()
        if len(entries) > 3000 or sum(e.file_size for e in entries) > 160 * 1024 * 1024:
            raise ValueError("report archive exceeds extraction budget")
        reports = {"playwright": [], "tagged": [], "junit": [], "summary": [], "log": []}
        coverage = []
        for item in entries:
            name = item.filename.lower()
            if item.is_dir() or item.file_size > 20 * 1024 * 1024:
                continue
            if not (name.endswith(("results.json", "report.json", ".xml", "run.log", "dashboard-summary.json")) or COVERAGE_FILE_RE.search(name)):
                continue
            text = archive.read(item).decode("utf-8", "replace")
            try:
                if COVERAGE_FILE_RE.search(name):
                    cov = parse_coverage_file(name, text.encode())
                    if cov and isinstance(cov.get("lines_pct"), (int, float)) and 0 <= cov["lines_pct"] <= 100:
                        coverage.append({"file": item.filename.replace("\\", "/").rsplit("/", 1)[-1], **cov})
                    continue
                result = None
                family = ""
                if name.endswith(".json"):
                    doc = json.loads(text)
                    if isinstance(doc, dict) and "suites" in doc:
                        result, family = playwright(doc), "playwright"
                    elif name.endswith("dashboard-summary.json"):
                        counts = {k: doc.get(k) for k in ("tests", *FIELDS)}
                        if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in counts.values()):
                            raise ValueError("invalid counts")
                        if counts["tests"] != sum(counts[k] for k in FIELDS):
                            raise ValueError("inconsistent counts")
                        result, family = {**counts, "cases": [], "format": "summary"}, "summary"
                elif name.endswith(".xml"):
                    result, family = junit(text), "junit"
                elif name.endswith("run.log"):
                    parsed = parse_run_log(text)
                    if parsed['totals'].get('tests'):
                        # Retain numeric breakdowns, never command lines or raw output.
                        keys = ('tests', 'passed', 'failed', 'skipped', 'framework')
                        commands = [{**{k: c.get(k) for k in keys}, 'label': f'命令 {i+1}'} for i, c in enumerate(parsed['commands'])]
                        packages = [{**{k: c.get(k) for k in keys}, 'package': c['package']} for c in parsed['packages']]
                        result, family = {**parsed['totals'], "flaky": 0, "cases": [], "format": "log", 'commands': commands, 'packages': packages}, "log"
                if result:
                    reports[family].append(result)
            except (ValueError, TypeError, AttributeError, ET.ParseError):
                continue
        # The tagged harness reconciles every planned case, so its summary is a
        # count source; a planned case without a pass or skip counts as failed.
        tagged = extract_tagged(archive)
        for part in tagged:
            result = part["result"] or {}
            planned, passed, skipped = result.get("planned"), result.get("passed"), result.get("skipped") or 0
            if planned is not None and passed is not None and passed + skipped <= planned:
                reports["tagged"].append({"tests": planned, "passed": passed, "failed": planned - passed - skipped,
                                          "skipped": skipped, "flaky": 0, "cases": []})
        for family in ("summary", "playwright", "tagged", "junit", "log"):
            if reports[family]:
                counts = {k: sum(r.get(k, 0) for r in reports[family]) for k in ("tests", *FIELDS)}
                return {**counts, "format": family, "cases": [c for r in reports[family] for c in r["cases"]][:500], "coverage": coverage, "tagged": tagged, **({k: [v for r in reports[family] for v in r[k]] for k in ("commands", "packages")} if family == "log" else {})}
        if coverage or tagged:
            return {"tests": None, "coverage": coverage, "tagged": tagged}
    return None
