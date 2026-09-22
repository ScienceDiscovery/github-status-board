#!/usr/bin/env python3
"""Generate a static site and commit site/ for the repository's Pages workflow."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil

from gsb.github import GitHub, GitHubError, discover_token
from gsb.project import REPO_RE, build_project

ROOT = Path(__file__).resolve().parent


def deployment_for(repo, settings, target=None):
    deployment = next((value for source, value in settings.get("deployments", {}).items()
                       if source.lower() == repo.lower()), None)
    if deployment and target and target.lower() != deployment["repository"].lower():
        raise ValueError("source repository does not match publishing destination")
    return deployment


def export_site(output, snapshot):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    for name in ("index.html", "app.js", "style.css", "report.js", "board.js", "board-local.js"):
        shutil.copyfile(ROOT / "static" / name, output / name)
    (output / "data").mkdir(exist_ok=True)
    target = output / "data/snapshot.json"
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(target)
    (output / ".nojekyll").write_text("")


def publish(gh, site, repository, branch="main", *, source_token=None):
    if not REPO_RE.fullmatch(repository) or not REPO_RE.fullmatch("owner/" + branch):
        raise ValueError("invalid publishing target")
    prefix = f"/repos/{repository}"
    if gh.get(prefix).get("private"):
        raise ValueError("publishing target must be a public Pages repository")
    # The destination must already contain its deployment workflow. Retain all
    # source files and workflows; the bot's Contents token changes only site/.
    old = gh.get(prefix + "/git/ref/heads/" + branch)["object"]["sha"]
    base_tree = gh.get(prefix + "/git/commits/" + old)["tree"]["sha"]
    files = ["index.html", "app.js", "style.css", "report.js", "board.js", "board-local.js", "data/snapshot.json", ".nojekyll"]
    tree = [{"path": "site/" + p, "mode": "100644", "type": "blob", "content": (Path(site) / p).read_text(encoding="utf-8")} for p in files]
    for entry in tree:
        if any(token and token in entry["content"] for token in (gh.token, source_token)):
            raise ValueError("credential detected in site")

    def write(method, path, body):
        return gh._request(method, gh._url(prefix + path, None), body=body)[0]

    new_tree = write("POST", "/git/trees", {"base_tree": base_tree, "tree": tree})
    commit = write("POST", "/git/commits", {"message": "更新项目看板快照", "tree": new_tree["sha"], "parents": [old]})
    write("PATCH", "/git/refs/heads/" + branch, {"sha": commit["sha"], "force": False})
    return commit["sha"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="openJiuwen-ai/sciencediscovery")
    parser.add_argument("--output", default=str(ROOT / "dist"))
    parser.add_argument("--settings", default=str(ROOT / "board-config.json"))
    parser.add_argument("--publish-repo")
    parser.add_argument("--branch", default="main")
    args = parser.parse_args()
    token, _ = discover_token()
    publish_token = os.environ.get("GSB_PUBLISH_TOKEN", "").strip() or token
    gh = GitHub(token, timeout=30)
    try:
        settings = json.loads(Path(args.settings).read_text())
        deployment = deployment_for(args.repo, settings, args.publish_repo)
        snapshot = build_project(gh, args.repo, settings)
        if deployment:
            snapshot["deployment"] = deployment
        export_site(args.output, snapshot)
        result = {"ok": True, "repo": args.repo, "generated_at": snapshot["generated_at"]}
        if args.publish_repo:
            if not publish_token:
                raise ValueError("publishing requires a token")
            publisher = GitHub(publish_token, timeout=30)
            result["commit"] = publish(publisher, args.output, args.publish_repo, args.branch, source_token=token)
        print(json.dumps(result))
    except (GitHubError, OSError, ValueError) as err:
        # API errors can include request context; expose only a stable category.
        print(json.dumps({"ok": False, "error": getattr(err, "kind", type(err).__name__)}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
