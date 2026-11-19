#!/usr/bin/env python3
"""Birdwatch local analytics service and static dashboard."""
import argparse
import base64
import hmac
import ipaddress
import json
import mimetypes
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from birdwatch import analytics
from birdwatch.capture import ApiError, capture, string
from birdwatch.database import connection, initialize, new_project

ROOT = Path(__file__).resolve().parent
PUBLIC = {"/api/capture", "/birdwatch.js"}


def local_host(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "Birdwatch"
    sys_version = ""
    timeout = 12

    def log_message(self, fmt, *args):
        # Leave event filters, visitor IDs, and keys out of access logs.
        if len(args) > 1:
            super().log_message("%s %s", self.command, args[1])

    def respond(self, status, payload, content_type="application/json", extra=None):
        data = payload if isinstance(payload, bytes) else json.dumps(payload, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store" if self.route.startswith("/api") else "no-cache")
        if self.route in PUBLIC:
            self.send_header("Access-Control-Allow-Origin", "*")
        else:
            self.send_header("Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def guard(self):
        if self.route in PUBLIC:
            return
        auth = self.server.password
        host = self.headers.get("Host", "")
        hostname = urlsplit("//"+host).hostname
        if not auth and not local_host(hostname or ""):
            raise ApiError(403, "Use the loopback address to access this dashboard")
        if auth:
            expected = "Basic " + base64.b64encode(("admin:"+auth).encode()).decode()
            if not hmac.compare_digest(self.headers.get("Authorization","").encode(), expected.encode()):
                raise ApiError(401, "Dashboard sign-in required")
        origin = self.headers.get("Origin")
        if origin and origin not in ("http://"+host, "https://"+host):
            raise ApiError(403, "Dashboard requests must be same-origin")

    def body(self):
        if self.headers.get_content_type() != "application/json":
            raise ApiError(415, "Send application/json")
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(400, "Supply a Content-Length header")
        try:
            size = int(self.headers["Content-Length"])
        except (ValueError, TypeError):
            raise ApiError(411, "Supply a Content-Length header")
        if not 0 < size <= 1024*1024:
            raise ApiError(413, "Body must be between 1 byte and 1 MiB")
        try:
            body = json.loads(self.rfile.read(size).decode())
        except (UnicodeError, ValueError, RecursionError):
            raise ApiError(400, "Invalid JSON")
        if not isinstance(body, dict):
            raise ApiError(400, "Expected a JSON object")
        return body

    def api(self, db, query):
        if self.route == "/api/capture" and self.command == "POST":
            return 200, capture(db, self.body())
        if self.route == "/api/projects":
            if self.command == "POST":
                name = string(self.body().get("name"), "name", 60).strip()
                return 201, {"id":new_project(db, name)}
            if self.command == "GET":
                rows = db.execute("SELECT id,name,sample_as_of FROM projects ORDER BY id")
                return 200, {"projects":[dict(r) for r in rows]}
        match = re.fullmatch(r"/api/projects/([0-9]{1,18})/(overview|events|people|names|funnel|setup)", self.route)
        if not match or self.command != "GET":
            raise ApiError(404, "Unknown endpoint")
        project = db.execute("SELECT * FROM projects WHERE id=?", (int(match[1]),)).fetchone()
        if not project:
            raise ApiError(404, "Project not found")
        params = {k:v[0] for k,v in query.items()}
        days = params.get("days", "7")
        if days not in ("1","7","14","30"):
            raise ApiError(400, "Select a supported date range")
        days = int(days)
        offset = params.get("offset","0")
        if not re.fullmatch(r"[0-9]{1,9}",offset):
            raise ApiError(400, "Invalid page offset")
        kind = match[2]
        if kind == "setup":
            result = dict(project)
        elif kind == "overview":
            result = analytics.overview(db, project, days)
        elif kind == "names":
            result = {"names":analytics.event_names(db,project)}
        elif kind == "events":
            result = analytics.events(db,project,days,params.get("q",""),params.get("person",""),
                                      params.get("name",""),int(offset))
        elif kind == "people":
            result = analytics.people(db,project,days,params.get("q",""),int(offset))
        else:
            result = analytics.funnel(db, project, days, string(params.get("first"),"first",128),
                                      string(params.get("second"),"second",128))
        return 200, result

    def dispatch(self):
        self.route = ""
        try:
            url = urlsplit(self.path)
            self.route = url.path
            self.guard()
            if self.command == "OPTIONS" and self.route == "/api/capture":
                self.respond(204, b"", extra={"Access-Control-Allow-Methods":"POST, OPTIONS",
                                               "Access-Control-Allow-Headers":"Content-Type"})
                return
            if self.route.startswith("/api/"):
                with connection(self.server.database) as db:
                    if self.command == "GET":
                        db.execute("BEGIN")  # All panels reflect one consistent read snapshot.
                    status, payload = self.api(db, parse_qs(url.query, max_num_fields=20))
                self.respond(status, payload)
                return
            if self.command not in ("GET","HEAD"):
                raise ApiError(405, "Method not allowed")
            path = self.route.lstrip("/") or "index.html"
            if path not in ("index.html","birdwatch.js","favicon.svg") and not re.fullmatch(r"assets/[\w.-]+",path):
                raise ApiError(404, "File not found")
            file = ROOT / "static" / path
            if not file.is_file():
                raise ApiError(404, "File not found")
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            self.respond(200, file.read_bytes(), mime)
        except ApiError as err:
            extra = {"WWW-Authenticate":'Basic realm="Birdwatch", charset="UTF-8"'} if err.status == 401 and self.route not in PUBLIC else None
            self.respond(err.status, {"error":str(err)}, extra=extra)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return
        except ValueError:
            self.respond(400, {"error":"Invalid request"})
        except sqlite3.OperationalError:
            self.respond(503, {"error":"Database unavailable. Retry the request."})

    do_GET = do_HEAD = do_POST = do_OPTIONS = dispatch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("BIRDWATCH_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=os.environ.get("BIRDWATCH_PORT", "8123"))
    default_db = ROOT / "data" / "birdwatch.sqlite3"
    parser.add_argument("--db", default=os.environ.get("BIRDWATCH_DB", str(default_db)))
    parser.add_argument("--no-demo", action="store_true", help="Initialize a fresh database with an empty project")
    args = parser.parse_args()
    password = os.environ.get("BIRDWATCH_PASSWORD", "")
    if not local_host(args.host) and not password:
        parser.error("Set BIRDWATCH_PASSWORD before binding to a network interface")
    if not (ROOT/"static"/"index.html").exists():
        parser.error("Missing dashboard bundle. Run npm ci and npm run build inside ui/")
    with ThreadingHTTPServer((args.host,args.port), Handler) as server:
        server.database, server.password = args.db, password
        initialize(args.db, not args.no_demo)
        print(f"Birdwatch listening at http://{args.host}:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
