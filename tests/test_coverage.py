import io
import json
import tempfile
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from gsb.collectors import Context, _artifact_cache_path, _coverage_probe, _load_artifact
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
            archive.writestr("coverage/summary.md", "# Node test coverage\n")

        parsed = parse_artifact_zip("node-coverage", blob.getvalue())

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

    def test_external_coverage_artifact_uses_its_own_repo_and_cache_namespace(self):
        blob = io.BytesIO()
        with zipfile.ZipFile(blob, "w") as archive:
            archive.writestr("coverage/lcov.info", LCOV)

        class GitHubStub:
            def __init__(self):
                self.downloads = []

            def download_artifact(self, repo, artifact_id, *, max_bytes):
                self.downloads.append((repo, artifact_id, max_bytes))
                return blob.getvalue()

        with tempfile.TemporaryDirectory() as directory:
            cfg = Config(cache_dir=Path(directory))
            github = GitHubStub()
            ctx = Context(gh=github, cfg=cfg, now=datetime(2026, 9, 21))
            artifact = {"id": 42, "name": "sciencediscovery-coverage-deadbeef", "repo": "ScienceDiscovery/github-status-board"}

            parsed = _load_artifact(ctx, artifact, [])

            self.assertEqual(github.downloads[0][:2], ("ScienceDiscovery/github-status-board", 42))
            self.assertEqual(parsed["repo"], "ScienceDiscovery/github-status-board")
            self.assertTrue(_artifact_cache_path(cfg, 42, artifact["repo"]).exists())
            self.assertNotEqual(
                _artifact_cache_path(cfg, 42, artifact["repo"]),
                _artifact_cache_path(cfg, 42, "openJiuwen-ai/sciencediscovery"),
            )


if __name__ == "__main__":
    unittest.main()
