import io
import json
import unittest
import zipfile
from datetime import datetime
from unittest.mock import patch

from gsb.collectors import Context, _coverage_probe
from gsb.config import Config
from gsb.testparse import parse_artifact_zip, parse_coverage_file


LCOV = """TN:
SF:/workspace/services/example/src/index.js
FNF:4
FNH:3
BRF:10
BRH:8
LF:20
LH:17
end_of_record
SF:/workspace/packages/example/src/helper.js
FNF:2
FNH:2
BRF:4
BRH:3
LF:10
LH:9
end_of_record
"""


class CoverageParserTests(unittest.TestCase):
    def test_lcov_includes_line_branch_and_function_totals(self):
        coverage = parse_coverage_file("lcov.info", LCOV.encode())

        self.assertEqual(coverage["lines_pct"], 86.67)
        self.assertEqual((coverage["lines_hit"], coverage["lines_found"]), (26, 30))
        self.assertEqual(coverage["branches_pct"], 78.57)
        self.assertEqual((coverage["branches_hit"], coverage["branches_found"]), (11, 14))
        self.assertEqual(coverage["functions_pct"], 83.33)
        self.assertEqual((coverage["functions_hit"], coverage["functions_found"]), (5, 6))

    def test_sciencediscovery_artifact_is_coverage_only(self):
        blob = io.BytesIO()
        with zipfile.ZipFile(blob, "w") as archive:
            archive.writestr("coverage/lcov.info", LCOV)
            archive.writestr("coverage/summary.json", json.dumps({
                "files": 2,
                "scope": "Built Node.js workspace tests",
                "totals": {"lines": {"covered": 26, "total": 30, "percentage": 86.67}},
            }))

        parsed = parse_artifact_zip("node-coverage-deadbeef", blob.getvalue())

        self.assertIsNone(parsed["summary"])
        self.assertIsNone(parsed["run_log"])
        self.assertEqual(len(parsed["coverage"]), 1)
        self.assertEqual(parsed["coverage"][0]["file"], "coverage/lcov.info")

    def test_ci_layer_summary_is_still_recognized(self):
        blob = io.BytesIO()
        with zipfile.ZipFile(blob, "w") as archive:
            archive.writestr("summary.json", json.dumps({
                "layer": "ut",
                "status": "passed",
                "exitCode": 0,
                "outcomes": [{"command": "pnpm test", "exitCode": 0, "durationMs": 1200}],
            }))

        parsed = parse_artifact_zip("ut-results", blob.getvalue())

        self.assertEqual(parsed["summary"]["layer"], "ut")
        self.assertEqual(parsed["summary"]["status"], "passed")
        self.assertEqual(parsed["summary"]["outcomes"][0]["command"], "pnpm test")

    def test_schema_coverage_summary_is_not_a_ci_layer(self):
        blob = io.BytesIO()
        manifest = {
            "schema_version": 1,
            "mode": "full",
            "source_sha": "abc123",
            "groups": [{"name": "packages/example", "files": 1, "totals": {
                "lines": {"covered": 9, "total": 10, "percentage": 90},
                "branches": {"covered": 3, "total": 4, "percentage": 75},
                "functions": {"covered": 2, "total": 2, "percentage": 100},
            }}],
            "totals": {"lines": {"covered": 9, "total": 10, "percentage": 90}},
        }
        with zipfile.ZipFile(blob, "w") as archive:
            archive.writestr("coverage/summary.json", json.dumps(manifest))
            archive.writestr("coverage/groups/packages-example/summary.json", json.dumps({
                **manifest, "groups": None, "group": "packages/example",
            }))

        parsed = parse_artifact_zip("node-coverage-summary-nightly-abc123", blob.getvalue())

        self.assertIsNone(parsed["summary"])
        self.assertEqual(parsed["coverage_manifest"]["source_sha"], "abc123")
        self.assertEqual(parsed["coverage_manifest"]["groups"][0]["name"], "packages/example")

    def test_default_branch_coverage_precedes_newer_pull_request_artifact(self):
        artifacts = [
            {"id": 2, "name": "node-coverage", "branch": "feature/newer", "created_at": "2026-09-21T11:00:00Z"},
            {"id": 1, "name": "node-coverage", "branch": "main", "created_at": "2026-09-21T10:00:00Z"},
        ]
        ctx = Context(gh=object(), cfg=Config(), now=datetime(2026, 9, 21), repo_meta={"default_branch": "main"})

        def load_artifact(_ctx, artifact, _notes):
            return {"coverage": [{"format": "lcov", "lines_pct": 80 + artifact["id"]}]}

        with patch("gsb.collectors._load_artifact", side_effect=load_artifact) as loader:
            result = _coverage_probe(ctx, artifacts, [], {}, [])

        self.assertEqual(loader.call_args.args[1]["id"], 1)
        self.assertEqual(result["value"]["lines_pct"], 81)

    def test_main_group_summaries_compose_over_latest_nightly_baseline(self):
        artifacts = [
            {"id": 3, "name": "node-coverage-summary-pr-17-prsha", "branch": "feature/x",
             "created_at": "2026-09-22T12:00:00Z"},
            {"id": 2, "name": "node-coverage-summary-main-incremental-mainsha", "branch": "main",
             "created_at": "2026-09-22T11:00:00Z"},
            {"id": 1, "name": "node-coverage-summary-nightly-base", "branch": "main",
             "created_at": "2026-09-22T03:30:00Z"},
        ]
        metric = lambda covered, total: {  # noqa: E731 - compact fixture
            "lines": {"covered": covered, "total": total, "percentage": covered * 100 / total},
            "branches": {"covered": covered, "total": total, "percentage": covered * 100 / total},
            "functions": {"covered": covered, "total": total, "percentage": covered * 100 / total},
        }
        manifests = {
            1: {"schema_version": 1, "source_sha": "base", "generated_at": "2026-09-22T03:30:00Z",
                "groups": [{"name": "packages/a", "files": 1, "totals": metric(5, 10)},
                           {"name": "packages/b", "files": 1, "totals": metric(8, 10)}],
                "totals": metric(13, 20)},
            2: {"schema_version": 1, "source_sha": "mainsha", "generated_at": "2026-09-22T11:00:00Z",
                "groups": [{"name": "packages/a", "files": 1, "totals": metric(9, 10)}],
                "totals": metric(9, 10)},
            3: {"schema_version": 1, "source_sha": "prsha", "generated_at": "2026-09-22T12:00:00Z",
                "groups": [{"name": "packages/b", "files": 1, "totals": metric(10, 10)}],
                "totals": metric(10, 10)},
        }
        ctx = Context(gh=object(), cfg=Config(), now=datetime(2026, 9, 22),
                      repo_meta={"default_branch": "main"})

        with patch("gsb.collectors._load_artifact",
                   side_effect=lambda _ctx, artifact, _notes: {"coverage_manifest": manifests[artifact["id"]]}):
            result = _coverage_probe(ctx, artifacts, [], {}, [])

        self.assertEqual(result["baseline"]["totals"]["lines"]["percentage"], 65)
        self.assertEqual(result["current"]["kind"], "incremental")
        self.assertEqual(result["current"]["totals"]["lines"]["percentage"], 85)
        self.assertEqual(result["pull_requests"][0]["number"], 17)
        self.assertEqual(result["pull_requests"][0]["groups"][0]["name"], "packages/b")


if __name__ == "__main__":
    unittest.main()
