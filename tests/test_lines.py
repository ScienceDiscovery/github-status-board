from datetime import timedelta
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch

from gsb.collectors import collect_ci
from gsb.incremental_project import build_snapshot
from gsb.lines import configured_lines, line_of, target_of
from gsb.sync import Sync
from test_ci_lanes import NOW, RULES, SnapshotLaneTests, points
from test_incremental import REPO

ROOT = Path(__file__).resolve().parents[1]
LINES = [{"key": "jiuwen", "label": "jiuwen", "ref": "feat/jiuwenswarm"}]


class ConfigTests(unittest.TestCase):
    def test_default_branch_comes_first_and_invalid_entries_are_dropped(self):
        lines = configured_lines({"branch_lines": [
            {"key": "jiuwen", "label": "jiuwen", "ref": "feat/jiuwenswarm"}, {"key": "main", "label": "main", "ref": "main"},
            {"key": "Bad Key", "ref": "x"}, {"key": "jiuwen", "ref": "other"}, {"key": "again", "ref": "feat/jiuwenswarm"}, "junk"]}, "main")
        self.assertEqual([(line["key"], line["ref"], line["default"]) for line in lines],
                         [("main", "main", True), ("jiuwen", "feat/jiuwenswarm", False)])
        self.assertEqual(configured_lines({}, "main"), [{"key": "main", "label": "main", "ref": "main", "default": True}])

    def test_runs_belong_to_the_branch_their_work_targets(self):
        lines = configured_lines({"branch_lines": LINES}, "main")
        prs = [dict(number=9, head="swarm-fork", head_repo="fork/source", base="feat/jiuwenswarm",
                    created_at="2026-09-20T00:00:00Z", closed_at=None)]
        by_number = {9: prs[0]}
        cases = [
            (dict(event="push", branch="feat/jiuwenswarm"), "jiuwen"),
            (dict(event="workflow_dispatch", branch="feat/jiuwenswarm"), "jiuwen"),
            (dict(event="pull_request", branch="x", base_branch="feat/jiuwenswarm"), "jiuwen"),
            (dict(event="pull_request", branch="x", pull_requests=[9]), "jiuwen"),
            (dict(event="pull_request", branch="swarm-fork", head_repo="fork/source", created_at="2026-09-21T00:00:00Z"), "jiuwen"),
            (dict(event="pull_request", branch="unknown", created_at="2026-09-21T00:00:00Z"), "main"),
            (dict(event="push", branch="0.3.0"), "main"),
            (dict(event="schedule", branch="main"), "main"),
        ]
        for run, expected in cases:
            self.assertEqual(line_of(target_of(run, prs, by_number), lines), expected, run)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        (ROOT / ".tmp").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / ".tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def source(self):
        gh = SnapshotLaneTests.source(None)
        def raw(ident, event, branch, minutes, **extra):
            created = (NOW - timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")
            return {**gh.runs[1], "id": ident, "event": event, "head_branch": branch, "display_title": f"CI {ident}",
                    "html_url": f"https://github.com/{REPO}/actions/runs/{ident}", "created_at": created, "updated_at": created,
                    "run_started_at": created, **extra}
        gh.runs += [raw(6, "pull_request", "swarm-fix", 8, pull_requests=[{"number": 8, "base": {"ref": "feat/jiuwenswarm"}}]),
                    raw(7, "pull_request", "swarm-fork", 7, head_repository={"full_name": "fork/source"}),
                    raw(8, "workflow_dispatch", "feat/jiuwenswarm", 6), raw(9, "push", "feat/jiuwenswarm", 5)]
        pr = gh.prs[0]
        gh.prs += [{**pr, "number": 8, "head": {"ref": "swarm-fix", "sha": "e" * 40, "repo": {"full_name": REPO}}, "base": {"ref": "feat/jiuwenswarm"},
                    "html_url": f"https://github.com/{REPO}/pull/8"},
                   {**pr, "number": 9, "head": {"ref": "swarm-fork", "sha": "f" * 40, "repo": {"full_name": "fork/source"}}, "base": {"ref": "feat/jiuwenswarm"},
                    "html_url": f"https://github.com/{REPO}/pull/9"}]
        return gh

    def test_each_line_gets_its_own_ci_tests_and_coverage_evidence(self):
        sync = Sync(self.source(), self.root, REPO, settings={"workflows": RULES, "branch_lines": LINES}, now=NOW).collect()
        calls = {}
        def tests(ctx, runs, owns=None):
            calls[ctx.default_branch] = ([run["id"] for run in runs], owns)
            return {"executed": [], "coverage": {}}
        with patch("gsb.incremental_project.public_ops", return_value={}), patch("gsb.incremental_project.public_tests", side_effect=tests):
            doc = build_snapshot(sync)
        self.assertEqual([(line["key"], line["default"]) for line in doc["lines"]], [("main", True), ("jiuwen", False)])
        main, swarm = doc["sections"]["ci"]["data"], doc["line_sections"]["jiuwen"]["ci"]["data"]
        self.assertEqual({lane["key"]: points(lane) for lane in main["lanes"]["lanes"]}, {"pr": [1], "main": [2, 5], "daily": [3], "release": [4]})
        self.assertEqual({lane["key"]: points(lane) for lane in swarm["lanes"]["lanes"]}, {"pr": [6, 7], "main": [8, 9]})
        self.assertEqual([lane["label"] for lane in swarm["lanes"]["lanes"]], ["PR", "jiuwen"])
        self.assertEqual((swarm["default_branch"], swarm["lanes"]["branch"]), ("feat/jiuwenswarm", "feat/jiuwenswarm"))
        self.assertEqual((main["pull_request"]["total"], swarm["pull_request"]["total"], swarm["main"]["total"]), (1, 2, 2))
        self.assertEqual(sorted(calls["main"][0]), [1, 2, 3, 4, 5])
        self.assertEqual(sorted(calls["feat/jiuwenswarm"][0]), [6, 7, 8, 9])
        # Coverage artifacts follow their run; unknown runs follow their branch.
        own = calls["feat/jiuwenswarm"][1]
        self.assertEqual([own({"run_id": 8}), own({"run_id": 2}), own({"run_id": 99, "branch": "feat/jiuwenswarm"}), own({"run_id": 98, "branch": "x"})],
                         [True, False, True, False])
        self.assertEqual(doc["line_sections"]["jiuwen"]["tests"]["data"]["tagged"], None)
        self.assertNotIn("main", doc["line_sections"])

    def test_changing_the_lines_rebuilds_an_unchanged_snapshot(self):
        def build(settings, collect):
            sync = Sync(self.source(), self.root, REPO, settings={"workflows": RULES, **settings}, now=NOW)
            if collect:
                sync.collect()
            else:
                sync.meta = sync.gh.get("/repos/" + REPO)
            with patch("gsb.incremental_project.public_ops", return_value={}), patch("gsb.incremental_project.public_tests", return_value={}), \
                    patch("gsb.incremental_project.collect_ci", wraps=collect_ci) as ci:
                doc = build_snapshot(sync)
            for name, content in {**sync.files(), "site/data/snapshot.json": json.dumps(doc)}.items():
                (self.root / name).parent.mkdir(parents=True, exist_ok=True)
                (self.root / name).write_text(content)
            return doc, ci.call_count
        self.assertEqual(build({}, True)[1], 1)
        doc, built = build({}, False)
        self.assertEqual((len(doc["lines"]), built), (1, 0))
        doc, built = build({"branch_lines": LINES}, False)
        self.assertEqual((sorted(doc["line_sections"]), built), (["jiuwen"], 2))
