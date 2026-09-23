#!/usr/bin/env python3
"""A JSON API in front of the Divinum Officium engine.

The engine is the implementation, not a re-implementation of it: this service
runs the repository's own CGI (``web/cgi-bin/horas/Pofficium.pl``,
``web/cgi-bin/missa/missa.pl``) exactly as the website does, and hands the
resulting page to the reader's parser. The JSON that comes out is the same
shape the Omarchy plugin and the web reader already consume, so nothing above
this layer needs to know an engine exists.

Only the Python standard library is used, and the container it ships in is the
upstream Perl image, which carries python3 for exactly this reason.

  service.py --repo /var/www --port 8080

Routes:

  GET /health
  GET /v1/office/<YYYY-MM-DD>/<Hour>?version=&lang1=&lang2=
  GET /v1/mass/<YYYY-MM-DD>?version=&lang1=&lang2=&votive=&propers=1
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOURS = [
    "Matutinum",
    "Laudes",
    "Prima",
    "Tertia",
    "Sexta",
    "Nona",
    "Vesperae",
    "Completorium",
]

# The CGI each rite runs, and the file that holds it under the web root.
RITES = {
    "office": ("horas", "Pofficium.pl"),
    "mass": ("missa", "missa.pl"),
}

DEFAULT_VERSION = "Rubrics 1960 - 1960"
DEFAULT_LANG1 = "Latin"
DEFAULT_LANG2 = "English"


def load_parser(path: str):
    """The reader's own parser, vendored beside this file."""
    spec = importlib.util.spec_from_file_location("divinum_officium", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Engine:
    """Runs the repository's CGI and parses what it prints."""

    def __init__(self, repo: str, parser_path: str, timeout: int = 180, workers: int = 4):
        self.repo = os.path.abspath(repo)
        self.timeout = timeout
        self.parser = load_parser(parser_path)
        self.slots = threading.BoundedSemaphore(workers)
        # The modules the CGI needs, exactly as the repository's own app.psgi
        # sets them: the engine's library and cgi-bin directories.
        self.perl5lib = ":".join(
            [
                os.path.join(self.repo, "web", "cgi-bin"),
                os.path.join(self.repo, "web", "DivinumOfficium"),
                os.environ.get("PERL5LIB", ""),
            ]
        ).strip(":")

    def script(self, rite: str) -> str:
        folder, name = RITES[rite]
        return os.path.join(self.repo, "web", "cgi-bin", folder, name)

    def run(self, rite: str, params: dict) -> str:
        """One CGI request, exactly as the website makes it."""
        script = self.script(rite)
        environment = dict(os.environ)
        environment["PERL5LIB"] = self.perl5lib
        argv = ["perl", script] + [f"{key}={value}" for key, value in params.items()]
        with self.slots:
            result = subprocess.run(
                argv,
                cwd=os.path.dirname(script),
                capture_output=True,
                timeout=self.timeout,
                env=environment,
            )
        if result.returncode != 0 and not result.stdout:
            raise RuntimeError(result.stderr.decode("utf-8", "replace")[:400] or "the engine failed")
        return result.stdout.decode("utf-8", "replace")

    def payload(self, rite: str, meta: dict, params: dict) -> dict:
        document = self.run(rite, params)
        payload = self.parser.parse_payload(document, meta)
        payload["rite"] = rite
        payload["cached"] = False
        payload["stale"] = False
        payload["source"] = "engine"
        return payload


def parse_date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d")


def office_params(date: datetime, hour: str, version: str, lang1: str, lang2: str) -> dict:
    return {
        "command": "pray" + hour,
        "date1": date.strftime("%m-%d-%Y"),
        "version": version,
        "lang1": lang1,
        "lang2": lang2,
        "content": "1",
    }


def mass_params(
    date: datetime, version: str, lang1: str, lang2: str, votive: str, propers: bool
) -> dict:
    params = {
        "command": "pray",
        "date1": date.strftime("%m-%d-%Y"),
        "version": version,
        "lang1": lang1,
        "lang2": lang2,
        "content": "1",
        "Propers": "1" if propers else "0",
    }
    if votive and votive != "Hodie":
        params["votive"] = votive
    return params


class Handler(BaseHTTPRequestHandler):
    server_version = "DivinumOfficiumApi"
    protocol_version = "HTTP/1.1"
    engine: Engine = None  # set by main()

    # No default access log line per request: the Worker logs what matters.
    def log_message(self, format: str, *args) -> None:
        sys.stderr.write("%s %s\n" % (self.address_string(), format % args))

    def send_json(self, status: int, body: dict) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        # The engine is the source of truth and it is cheap; a short shared
        # cache absorbs repeated asks for the same hour without pretending the
        # answer is static.
        self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802 (the HTTP verb names the method)
        try:
            self.route()
        except subprocess.TimeoutExpired:
            self.send_json(504, {"ok": False, "error": "the engine took too long"})
        except Exception as error:  # one bad request must not end the service
            self.send_json(502, {"ok": False, "error": str(error)[:400]})

    def route(self) -> None:
        parsed = urlparse(self.path)
        query = {key: values[0] for key, values in parse_qs(parsed.query).items()}
        path = parsed.path.rstrip("/") or "/"

        if path == "/health":
            self.send_json(200, {"ok": True, "engine": self.engine.repo, "hours": HOURS})
            return

        parts = [piece for piece in path.split("/") if piece]

        # /v1/day/<date> — the day itself: headline, colour, commemorations.
        # Tertia is the cheapest hour that carries them, so it is the one the
        # engine is asked for.
        if len(parts) == 3 and parts[0] == "v1" and parts[1] == "day":
            date = parse_date(parts[2])
            version = query.get("version") or DEFAULT_VERSION
            lang1 = query.get("lang1") or DEFAULT_LANG1
            lang2 = query.get("lang2") or DEFAULT_LANG2
            payload = self.engine.payload(
                "office",
                {
                    "baseUrl": "engine",
                    "rite": "office",
                    "date": date.strftime("%Y-%m-%d"),
                    "hour": "Tertia",
                    "version": version,
                    "lang1": lang1,
                    "lang2": lang2,
                    "votive": "",
                    "propers": False,
                },
                office_params(date, "Tertia", version, lang1, lang2),
            )
            self.send_json(
                200 if payload.get("sections") else 502,
                {
                    "ok": bool(payload.get("sections")),
                    "date": payload.get("date"),
                    "version": version,
                    "headline": payload.get("title"),
                    "colourKey": payload.get("colorKey"),
                    "colourName": payload.get("colorName"),
                    "commemorations": payload.get("commemorations") or [],
                    "hourTitle": payload.get("hourTitle"),
                    "hour": "Tertia",
                    "source": "engine",
                },
            )
            return

        # /v1/office/<date>/<hour>
        if len(parts) == 4 and parts[0] == "v1" and parts[1] == "office":
            date = parse_date(parts[2])  # ValueError → 502, caught above
            hour = next((name for name in HOURS if name.lower() == parts[3].lower()), None)
            if hour is None:
                self.send_json(404, {"ok": False, "error": f"unknown hour: {parts[3]}"})
                return
            version = query.get("version") or DEFAULT_VERSION
            lang1 = query.get("lang1") or DEFAULT_LANG1
            lang2 = query.get("lang2") or DEFAULT_LANG2
            payload = self.engine.payload(
                "office",
                {
                    "baseUrl": "engine",
                    "rite": "office",
                    "date": date.strftime("%Y-%m-%d"),
                    "hour": hour,
                    "version": version,
                    "lang1": lang1,
                    "lang2": lang2,
                    "votive": "",
                    "propers": False,
                },
                office_params(date, hour, version, lang1, lang2),
            )
            self.send_payload(payload)
            return

        # /v1/mass/<date>
        if len(parts) == 3 and parts[0] == "v1" and parts[1] == "mass":
            date = parse_date(parts[2])
            version = query.get("version") or DEFAULT_VERSION
            lang1 = query.get("lang1") or DEFAULT_LANG1
            lang2 = query.get("lang2") or DEFAULT_LANG2
            votive = query.get("votive") or "Hodie"
            propers = query.get("propers") in ("1", "true", "yes")
            payload = self.engine.payload(
                "mass",
                {
                    "baseUrl": "engine",
                    "rite": "mass",
                    "date": date.strftime("%Y-%m-%d"),
                    "hour": "",
                    "version": version,
                    "lang1": lang1,
                    "lang2": lang2,
                    "votive": votive,
                    "propers": propers,
                },
                mass_params(date, version, lang1, lang2, votive, propers),
            )
            # The missal has no hours: the plugin reads the day's texts.
            payload["hour"] = ""
            self.send_payload(payload)
            return

        self.send_json(404, {"ok": False, "error": f"no route: {path}"})

    def send_payload(self, payload: dict) -> None:
        if not payload.get("sections"):
            payload["ok"] = False
            payload["error"] = (
                payload.get("error") or "the engine returned no sections for this request"
            )
            self.send_json(502, payload)
            return
        payload["ok"] = True
        self.send_json(200, payload)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="/var/www", help="the engine's web root")
    here = os.path.dirname(os.path.abspath(__file__))
    beside = os.path.join(here, "divinum_officium.py")
    vendored = os.path.join(here, "tools", "divinum_officium.py")
    parser.add_argument(
        "--parser",
        default=beside if os.path.exists(beside) else vendored,
        help="the reader's parser (the plugin's own, vendored)",
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--workers", type=int, default=4, help="engine runs in flight")
    args = parser.parse_args(argv)

    Handler.engine = Engine(args.repo, args.parser, args.timeout, args.workers)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"divinum officium api on http://{args.host}:{args.port} (engine: {args.repo})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
