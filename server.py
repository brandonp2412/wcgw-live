#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("WCGW_LIVE_HOST", "127.0.0.1")
PORT = int(os.environ.get("WCGW_LIVE_PORT", "18117"))
UNIT = os.environ.get("WCGW_LIVE_UNIT", "wcgw.service")
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
STARTED_AT = time.time()


def journal_args(*extra: str) -> list[str]:
    return ["journalctl", "--user", "-u", UNIT, *extra, "-o", "json", "--no-pager"]


def parse_journal_line(line: str) -> dict | None:
    try:
        raw = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return None

    message = raw.get("MESSAGE", "")
    if not isinstance(message, str):
        message = str(message)

    try:
        timestamp = int(raw.get("__REALTIME_TIMESTAMP", "0")) / 1_000_000
    except (TypeError, ValueError):
        timestamp = time.time()

    return {
        "ts": timestamp,
        "message": message,
        "pid": raw.get("_PID"),
        "identifier": raw.get("SYSLOG_IDENTIFIER") or raw.get("_COMM") or "wcgw",
    }


def get_history(lines: int) -> list[dict]:
    proc = subprocess.run(
        journal_args("-n", str(lines)),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    entries: list[dict] = []
    for line in proc.stdout.splitlines():
        parsed = parse_journal_line(line)
        if parsed:
            entries.append(parsed)
    return entries


def service_state() -> str:
    proc = subprocess.run(
        ["systemctl", "--user", "is-active", UNIT],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return proc.stdout.strip() or "unknown"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args) -> None:
        return

    def send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path in {"/", "/index.html"}:
            self.send_file(STATIC / "index.html", "text/html; charset=utf-8")
            return
        if parsed.path == "/app.css":
            self.send_file(STATIC / "app.css", "text/css; charset=utf-8")
            return
        if parsed.path == "/app.js":
            self.send_file(STATIC / "app.js", "text/javascript; charset=utf-8")
            return
        if parsed.path == "/api/history":
            query = parse_qs(parsed.query)
            try:
                requested = int(query.get("lines", ["1600"])[0])
            except ValueError:
                requested = 1600
            lines = max(100, min(requested, 5000))
            entries = get_history(lines)
            self.send_json({"unit": UNIT, "entries": entries})
            return
        if parsed.path == "/api/status":
            self.send_json(
                {
                    "unit": UNIT,
                    "state": service_state(),
                    "viewerUptime": int(time.time() - STARTED_AT),
                    "now": time.time(),
                }
            )
            return
        if parsed.path == "/api/stream":
            self.stream_journal()
            return
        if parsed.path == "/healthz":
            self.send_json({"ok": True, "source": UNIT})
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def stream_journal(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        proc = subprocess.Popen(
            journal_args("-n", "0", "-f"),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=1,
        )
        try:
            self.wfile.write(b": wcgw-live connected\n\n")
            self.wfile.flush()
            assert proc.stdout is not None
            for line in proc.stdout:
                parsed = parse_journal_line(line)
                if not parsed:
                    continue
                payload = json.dumps(parsed, separators=(",", ":")).encode()
                self.wfile.write(b"data: " + payload + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"wcgw-live: http://{HOST}:{PORT} <- {UNIT}", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
