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
  GET /v1/day/<YYYY-MM-DD>?version=&calendar=&lang1=&lang2=
  GET /v1/office/<YYYY-MM-DD>/<Hour>?version=&calendar=&lang1=&lang2=
  GET /v1/mass/<YYYY-MM-DD>?version=&calendar=&lang1=&lang2=&votive=&propers=1

The snapshot suite (tests/snapshot.py) drives the same `Engine.office`,
`Engine.mass` and `Engine.day` calls, so the tests pin the API's contract
rather than some parallel path into the engine.
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
DEFAULT_CALENDAR = "Generale"
DEFAULT_LANG1 = "Latin"
DEFAULT_LANG2 = "English"

CALENDARS = (
    "Generale",
    "Urbis",
    "Monacensis",
    "Passaviensis",
    "Ratisbonensis",
    "Spirensis",
    "Brasilia",
    "Ultrajectum",
    "Groningen",
)

# The hour the day itself is read from: cheapest, and it carries the day's
# headline and colour like any other.
DAY_HOUR = "Tertia"


def normalize_calendar(value: str | None) -> str:
    wanted = (value or "").strip()
    if not wanted:
        return DEFAULT_CALENDAR
    for calendar in CALENDARS:
        if calendar.lower() == wanted.lower():
            return calendar
    return DEFAULT_CALENDAR


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

    # The three questions the API answers. The routes and the snapshot suite
    # both come through here, so there is one path into the engine.

    def office(
        self,
        date: datetime,
        hour: str,
        version: str = DEFAULT_VERSION,
        lang1: str = DEFAULT_LANG1,
        lang2: str = DEFAULT_LANG2,
        calendar: str = DEFAULT_CALENDAR,
    ) -> dict:
        calendar = normalize_calendar(calendar)
        return self.payload(
            "office",
            {
                "baseUrl": "engine",
                "rite": "office",
                "date": date.strftime("%Y-%m-%d"),
                "hour": hour,
                "version": version,
                "calendar": calendar,
                "lang1": lang1,
                "lang2": lang2,
                "votive": "",
                "propers": False,
            },
            {
                "command": "pray" + hour,
                "date1": date.strftime("%m-%d-%Y"),
                "version": version,
                "dioecesis": calendar,
                "lang1": lang1,
                "lang2": lang2,
                "content": "1",
            },
        )

    def mass(
        self,
        date: datetime,
        version: str = DEFAULT_VERSION,
        lang1: str = DEFAULT_LANG1,
        lang2: str = DEFAULT_LANG2,
        votive: str = "Hodie",
        propers: bool = False,
        calendar: str = DEFAULT_CALENDAR,
    ) -> dict:
        calendar = normalize_calendar(calendar)
        params = {
            "command": "pray",
            "date1": date.strftime("%m-%d-%Y"),
            "version": version,
            "dioecesis": calendar,
            "lang1": lang1,
            "lang2": lang2,
            "content": "1",
            "Propers": "1" if propers else "0",
        }
        if votive and votive != "Hodie":
            params["votive"] = votive
        payload = self.payload(
            "mass",
            {
                "baseUrl": "engine",
                "rite": "mass",
                "date": date.strftime("%Y-%m-%d"),
                "hour": "",
                "version": version,
                "calendar": calendar,
                "lang1": lang1,
                "lang2": lang2,
                "votive": votive,
                "propers": propers,
            },
            params,
        )
        # The missal has no hours: the reader shows the day's texts.
        payload["hour"] = ""
        return payload

    def day(
        self,
        date: datetime,
        version: str = DEFAULT_VERSION,
        lang1: str = DEFAULT_LANG1,
        lang2: str = DEFAULT_LANG2,
        calendar: str = DEFAULT_CALENDAR,
    ) -> dict:
        calendar = normalize_calendar(calendar)
        payload = self.office(date, DAY_HOUR, version, lang1, lang2, calendar)
        return {
            "ok": bool(payload.get("sections")),
            "date": payload.get("date"),
            "version": version,
            "calendar": calendar,
            "headline": payload.get("title"),
            "colourKey": payload.get("colorKey"),
            "colourName": payload.get("colorName"),
            "commemorations": payload.get("commemorations") or [],
            "hourTitle": payload.get("hourTitle"),
            "hour": DAY_HOUR,
            "source": "engine",
        }


def parse_date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d")


class Handler(BaseHTTPRequestHandler):
    server_version = "DivinumOfficiumApi"
    protocol_version = "HTTP/1.1"
    engine: Engine = None  # set by main()

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

    def query(self) -> dict:
        parsed = urlparse(self.path)
        self.parts = [piece for piece in parsed.path.split("/") if piece]
        return {key: values[0] for key, values in parse_qs(parsed.query).items()}

    def ask(self, payload: dict) -> None:
        """A payload with no sections is not an answer; say so plainly."""
        if not payload.get("sections"):
            payload["ok"] = False
            payload["error"] = (
                payload.get("error") or "the engine returned no sections for this request"
            )
            self.send_json(502, payload)
            return
        payload["ok"] = True
        self.send_json(200, payload)

    def route(self) -> None:
        query = self.query()
        version = query.get("version") or DEFAULT_VERSION
        calendar = normalize_calendar(query.get("calendar") or query.get("dioecesis"))
        lang1 = query.get("lang1") or DEFAULT_LANG1
        lang2 = query.get("lang2") or DEFAULT_LANG2

        if self.parts == ["health"]:
            self.send_json(
                200,
                {
                    "ok": True,
                    "engine": self.engine.repo,
                    "hours": HOURS,
                    "calendars": list(CALENDARS),
                },
            )
            return

        if len(self.parts) == 3 and self.parts[:2] == ["v1", "day"]:
            self.send_json(200, self.engine.day(parse_date(self.parts[2]), version, lang1, lang2, calendar))
            return

        if len(self.parts) == 4 and self.parts[:2] == ["v1", "office"]:
            date = parse_date(self.parts[2])
            hour = next((name for name in HOURS if name.lower() == self.parts[3].lower()), None)
            if hour is None:
                self.send_json(404, {"ok": False, "error": f"unknown hour: {self.parts[3]}"})
                return
            self.ask(self.engine.office(date, hour, version, lang1, lang2, calendar))
            return

        if len(self.parts) == 3 and self.parts[:2] == ["v1", "mass"]:
            self.ask(
                self.engine.mass(
                    parse_date(self.parts[2]),
                    version,
                    lang1,
                    lang2,
                    query.get("votive") or "Hodie",
                    query.get("propers") in ("1", "true", "yes"),
                    calendar,
                )
            )
            return

        path = "/" + "/".join(self.parts)
        self.send_json(404, {"ok": False, "error": f"no route: {path}"})


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    here = os.path.dirname(os.path.abspath(__file__))
    beside = os.path.join(here, "divinum_officium.py")
    vendored = os.path.join(here, "tools", "divinum_officium.py")
    parser.add_argument("--repo", default="/var/www", help="the engine's web root")
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
