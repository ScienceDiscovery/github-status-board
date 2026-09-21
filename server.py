#!/usr/bin/env python3
"""Entry point: ``python3 server.py`` serves the board on 127.0.0.1:8790.

Standard library only. Routes:

    GET  /                  the single-page UI
    GET  /static/<file>     assets
    GET  /api/snapshot      full snapshot (all sections) as JSON
    GET  /api/status        refresh state / last error
    POST /api/refresh       trigger a background refresh (202 if started, 200 if already running)
    GET  /healthz           liveness

``--once`` prints a compact summary of a fresh snapshot and exits (no server).
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import sys
import time
from urllib.parse import urlsplit
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gsb.board import BoardError, BoardStore  # noqa: E402
from gsb.config import Config  # noqa: E402
from gsb.github import GitHub, GitHubError, discover_token  # noqa: E402
from gsb.snapshot import SnapshotStore, build_snapshot, redact_for_disk  # noqa: E402

STORE: SnapshotStore | None = None
BOARD: BoardStore | None = None
CFG: Config | None = None
DETAIL_CACHE: dict[str, tuple[float, dict]] = {}
DETAIL_TTL_S = 300
WRITE_MARKER = "github-status-board"
BOARD_ITEM_RE = re.compile(r"^/api/board/item/(issue|pr)/(\d+)$")


class Handler(BaseHTTPRequestHandler):
    server_version = "github-status-board/0.1"

    def log_message(self, fmt, *args):  # access log with client + user agent, to tell browsers from proxies apart
        agent = (self.headers.get("User-Agent", "-") if getattr(self, "headers", None) else "-")[:70]
        sys.stderr.write("%s %s [%s] - %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), self.client_address[0], agent, fmt % args))

    # ------------------------------------------------------------------ util
    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # --------------------------------------------------------------- routes
    def do_GET(self):  # noqa: N802
        assert STORE is not None and CFG is not None
        route = self.path.split("?", 1)[0]
        if route in ("/", "/index.html"):
            return self._file(CFG.static_dir / "index.html")
        if route.startswith("/static/"):
            rel = route[len("/static/"):]
            target = (CFG.static_dir / rel).resolve()
            if CFG.static_dir.resolve() not in target.parents:
                return self.send_error(HTTPStatus.FORBIDDEN)
            return self._file(target)
        if route == "/api/snapshot":
            status = STORE.status()
            if STORE.data is None:
                return self._json({"snapshot": None, "status": status}, 200)
            return self._json({"snapshot": STORE.data, "status": status})
        if route == "/api/status":
            return self._json(STORE.status())
        if route == "/api/board":
            assert BOARD is not None
            return self._json(BOARD.payload(STORE.data))
        m = BOARD_ITEM_RE.match(route)
        if m:
            return self._json(item_detail(m.group(1), int(m.group(2))))
        if route == "/healthz":
            return self._json({"ok": True})
        if route == "/favicon.ico":  # keep the browser console free of a spurious 404
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return None
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_HEAD(self):  # noqa: N802
        assert STORE is not None
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()

    def do_POST(self):  # noqa: N802
        assert STORE is not None
        route = self.path.split("?", 1)[0]
        if route == "/api/refresh":
            started = STORE.refresh()
            return self._json({"started": started, **STORE.status()}, 202 if started else 200)
        if route.startswith("/api/board/"):
            return self._board_write(route)
        self.send_error(HTTPStatus.NOT_FOUND)

    # ------------------------------------------------------- board writes
    def _same_origin(self) -> bool:
        """Writes need the request marker and, when the browser sends one, a matching Origin.
        The board has no login, so this keeps cross-site pages from mutating it."""
        if self.headers.get("X-Requested-With") != WRITE_MARKER:
            return False
        origin = self.headers.get("Origin")
        return not origin or urlsplit(origin).netloc == self.headers.get("Host")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 200_000:
            raise ValueError("body too large")
        raw = self.rfile.read(length) if length else b""
        doc = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(doc, dict):
            raise ValueError("JSON body must be an object")
        return doc

    def _board_write(self, route: str) -> None:
        assert BOARD is not None and STORE is not None
        if not self._same_origin():
            return self._json({"error": f"写操作需要同源请求并携带 X-Requested-With: {WRITE_MARKER}"}, 403)
        try:
            body = self._read_json()
        except ValueError as err:
            return self._json({"error": f"请求体无效：{err}"}, 400)
        try:
            if route == "/api/board/move":
                result = BOARD.move_item(body.get("id"), body.get("status"), before=body.get("before"), after=body.get("after"))
            elif route.startswith("/api/board/items/"):
                result = BOARD.update_item(route[len("/api/board/items/"):], body)
            elif route == "/api/board/fields":
                result = BOARD.update_fields(body)
            elif route == "/api/board/aliases":
                result = BOARD.set_alias(body.get("login"), body.get("alias"))
            else:
                return self.send_error(HTTPStatus.NOT_FOUND)
        except BoardError as err:
            return self._json({"error": str(err)}, 400)
        return self._json({"ok": True, "result": result, "board": BOARD.payload(STORE.data)})


def item_detail(kind: str, number: int) -> dict:
    """Issue/PR body plus cross-references from the timeline; cached briefly, fetched on demand."""
    assert CFG is not None
    key = f"{kind}:{number}"
    cached = DETAIL_CACHE.get(key)
    if cached and time.time() - cached[0] < DETAIL_TTL_S:
        return cached[1]
    token, _ = discover_token()
    gh = GitHub(token, timeout=30)
    try:
        issue = gh.get(f"/repos/{CFG.repo}/issues/{number}")
        timeline = gh.paginate(f"/repos/{CFG.repo}/issues/{number}/timeline", {"per_page": 100}, max_pages=2)
    except GitHubError as err:
        return {"kind": kind, "number": number, "error": err.to_dict()}
    refs = []
    for ev in timeline or []:
        if ev.get("event") != "cross-referenced":
            continue
        src = (ev.get("source") or {}).get("issue") or {}
        if not src.get("number"):
            continue
        pr = src.get("pull_request") or {}
        refs.append({"number": src["number"], "title": src.get("title"), "url": src.get("html_url"),
                     "kind": "pr" if src.get("pull_request") else "issue",
                     "state": "merged" if pr.get("merged_at") else src.get("state"), "at": ev.get("created_at")})
    detail = {
        "kind": kind, "number": number, "title": issue.get("title"), "body": issue.get("body") or "",
        "url": issue.get("html_url"), "state": issue.get("state"), "author": (issue.get("user") or {}).get("login"),
        "labels": [{"name": l.get("name"), "color": l.get("color")} for l in issue.get("labels") or []],
        "assignees": [(a or {}).get("login") for a in issue.get("assignees") or []],
        "milestone": (issue.get("milestone") or {}).get("title"), "comments": issue.get("comments", 0),
        "created_at": issue.get("created_at"), "updated_at": issue.get("updated_at"), "closed_at": issue.get("closed_at"),
        "cross_references": refs, "fetched_at": time.time(),
    }
    DETAIL_CACHE[key] = (time.time(), detail)
    return detail


def summarize(snapshot: dict) -> str:
    lines = [f"repo={snapshot['repo']} auth={snapshot['auth']} calls={snapshot['api_calls']} took={snapshot['duration_s']}s"]
    for name, sec in snapshot["sections"].items():
        line = f"  [{sec['status']:>7}] {name:<7} {sec['elapsed_s']:>6}s"
        if sec["error"]:
            line += f"  ERROR {sec['error']['kind']}: {sec['error']['message']}"
        for n in sec["notes"]:
            line += f"\n            note {n.get('key')}: {n.get('kind')} {n.get('message')}"
        lines.append(line)
    rate = snapshot.get("rate", {}).get("core")
    if rate:
        lines.append(f"  rate core remaining={rate['remaining']}/{rate['limit']}")
    return "\n".join(lines)


def main(argv=None) -> int:
    global STORE, CFG, BOARD
    parser = argparse.ArgumentParser(description="Local GitHub status board")
    parser.add_argument("--repo", help="owner/name (default: $GSB_REPO or openJiuwen-ai/sciencediscovery)")
    parser.add_argument("--host", help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, help="bind port (default: $GSB_PORT or 8790)")
    parser.add_argument("--refresh-interval", type=int, help="seconds between auto refreshes, 0 disables")
    parser.add_argument("--once", action="store_true", help="collect one snapshot, print a summary, exit")
    parser.add_argument("--dump", metavar="FILE", help="with --once: also write the snapshot JSON here (memory-only parts redacted, like the disk cache)")
    parser.add_argument("--no-initial-refresh", action="store_true", help="serve cached snapshot only until /api/refresh")
    args = parser.parse_args(argv)

    CFG = Config.from_env(repo=args.repo, host=args.host, port=args.port, refresh_interval=args.refresh_interval)

    if args.once:
        snap = build_snapshot(CFG)
        print(summarize(snap))
        if args.dump:
            Path(args.dump).write_text(json.dumps(redact_for_disk(snap), ensure_ascii=False, indent=1), "utf-8")
            print(f"snapshot written to {args.dump}")
        return 0 if all(s["status"] != "error" for s in snap["sections"].values()) else 1

    STORE = SnapshotStore(CFG)
    BOARD = BoardStore(CFG)
    if args.no_initial_refresh:
        if CFG.refresh_interval > 0:
            STORE.cfg.refresh_interval = CFG.refresh_interval
    else:
        STORE.start_auto_refresh()
    server = ThreadingHTTPServer((CFG.host, CFG.port), Handler)
    server.daemon_threads = True
    print(f"github-status-board: http://{CFG.host}:{CFG.port}/  repo={CFG.repo}  cache={CFG.cache_dir}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        STORE.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
