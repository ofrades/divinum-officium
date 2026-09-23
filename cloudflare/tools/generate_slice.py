#!/usr/bin/env python3
# Vendored from omarchy-divinum-officium (tools/generate_slice.py).
# Walks the engine and writes one JSON per office or Mass — the golden corpus
# the TypeScript port is measured against.
"""Generate a Divinum Officium API slice: one JSON file per office or Mass.

The dataset is what the Omarchy plugin reads, so the shape is the plugin's
own: the parser in the plugin's divinum_officium.py produces it, and this
generator imports that parser rather than duplicating it.

Two engines are supported:

  local   run the repo's CGI directly with perl
          (web/cgi-bin/horas/Pofficium.pl, web/cgi-bin/missa/missa.pl)
  http    read from a running Divinum Officium server

Layout written under --out:

  index.json                                  slice metadata
  office/<version>/<year>/<MM-DD>/<hour>-<lang1>-<lang2>.json
  mass/<version>/<year>/<MM-DD>/<votive>-<form>-<lang1>-<lang2>.json

Usage:
  generate_slice.py --engine local --repo /srv/divinum-officium \
      --from 2026-01-01 --to 2026-12-31 \
      --version "Rubrics 1960 - 1960" --lang1 Latin --lang2 Portugues \
      --out dist/api

  generate_slice.py --engine http --base-url http://127.0.0.1:8080 ...

Only the Python standard library is used, so it runs inside the upstream
container (which ships python3) as happily as on a workstation.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

RITES = {"office": "/cgi-bin/horas/Pofficium.pl", "mass": "/cgi-bin/missa/missa.pl"}

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

# The missal's own versions list; anything else is mapped by the server.
MASS_VERSIONS = {
    "Rubrics 1960 - 1960",
    "Rubrics 1960 - 2020 USA",
    "Reduced - 1955",
    "Divino Afflatu - 1954",
    "Divino Afflatu - 1939",
    "Tridentine - 1910",
    "Tridentine - 1570",
    "1965-1967",
}


def load_parser(path: str):
    spec = importlib.util.spec_from_file_location("divinum_officium", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def version_slug(version: str) -> str:
    """``Rubrics 1960 - 1960`` -> ``rubrics-1960-1960``, one dash per gap."""
    return re.sub(r"-+", "-", "".join(ch if ch.isalnum() else "-" for ch in version.lower())).strip("-")


def daterange(start: date, end: date):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def local_document(repo: str, rite: str, params: dict, runner) -> str:
    """Run one CGI request against the local repo and return its stdout."""
    script = (
        os.path.join(repo, "web", "cgi-bin", "horas", "Pofficium.pl")
        if rite == "office"
        else os.path.join(repo, "web", "cgi-bin", "missa", "missa.pl")
    )
    argv = ["perl", script] + [f"{key}={value}" for key, value in params.items()]
    result = subprocess.run(
        argv,
        cwd=os.path.dirname(script),
        capture_output=True,
        timeout=180,
        env=runner,
    )
    if result.returncode != 0 and not result.stdout:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[:400])
    return result.stdout.decode("utf-8", "replace")


def http_document(base_url: str, rite: str, params: dict, runner) -> str:
    url = base_url.rstrip("/") + RITES[rite] + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": "omarchy-divinum-officium-generator/0.1"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read().decode("utf-8", "replace")


def write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, path)


def job_office(parser, args, engine, day: date, hour: str, runner):
    meta = {
        "baseUrl": args.base_url if engine == "http" else "local",
        "rite": "office",
        "date": day.isoformat(),
        "hour": hour,
        "version": args.version,
        "lang1": args.lang1,
        "lang2": args.lang2,
        "votive": "",
        "propers": False,
    }
    params = {
        "command": "pray" + hour,
        "date1": day.strftime("%m-%d-%Y"),
        "version": args.version,
        "lang1": args.lang1,
        "lang2": args.lang2,
        "content": "1",
    }
    path = os.path.join(
        args.out,
        "office",
        version_slug(args.version),
        str(day.year),
        day.strftime("%m-%d"),
        f"{hour.lower()}-{args.lang1.lower()}-{args.lang2.lower()}.json",
    )
    if os.path.exists(path) and not args.force:
        return "skip", path
    document = engine("office", params, runner)
    payload = parser.parse_payload(document, meta)
    payload["rite"] = "office"
    payload["cached"] = False
    payload["stale"] = False
    if not payload["sections"]:
        return "empty", path
    write_json(path, payload)
    return "write", path


def job_mass(parser, args, engine, day: date, runner):
    meta = {
        "baseUrl": args.base_url if engine == "http" else "local",
        "rite": "mass",
        "date": day.isoformat(),
        "hour": "",
        "version": args.version,
        "lang1": args.lang1,
        "lang2": args.lang2,
        "votive": args.votive,
        "propers": args.propers,
    }
    params = {
        "command": "pray",
        "date1": day.strftime("%m-%d-%Y"),
        "version": args.version,
        "lang1": args.lang1,
        "lang2": args.lang2,
        "content": "1",
        "Propers": "1" if args.propers else "0",
    }
    if args.votive and args.votive != "Hodie":
        params["votive"] = args.votive
    path = os.path.join(
        args.out,
        "mass",
        version_slug(args.version),
        str(day.year),
        day.strftime("%m-%d"),
        f"{args.votive.lower()}-{'propers' if args.propers else 'full'}-{args.lang1.lower()}-{args.lang2.lower()}.json",
    )
    if os.path.exists(path) and not args.force:
        return "skip", path
    document = engine("mass", params, runner)
    payload = parser.parse_payload(document, meta)
    payload["rite"] = "mass"
    payload["cached"] = False
    payload["stale"] = False
    if not payload["sections"]:
        return "empty", path
    write_json(path, payload)
    return "write", path


def engine_for(name: str, parser, args):
    if name == "http":
        return lambda rite, params, runner: http_document(args.base_url, rite, params, runner)
    return lambda rite, params, runner: local_document(args.repo, rite, params, runner)


def main(argv):
    parser_args = argparse.ArgumentParser(description=__doc__)
    parser_args.add_argument("--engine", choices=["local", "http"], default="local")
    parser_args.add_argument("--repo", default="/srv/divinum-officium", help="checkout for --engine local")
    parser_args.add_argument("--base-url", default="http://127.0.0.1:8080", help="server for --engine http")
    parser_args.add_argument("--parser", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "divinum_officium.py"))
    parser_args.add_argument("--from", dest="start", required=True)
    parser_args.add_argument("--to", dest="end", required=True)
    parser_args.add_argument("--version", default="Rubrics 1960 - 1960")
    parser_args.add_argument("--lang1", default="Latin")
    parser_args.add_argument("--lang2", default="English")
    parser_args.add_argument("--hours", default=",".join(HOURS))
    parser_args.add_argument("--rites", default="office,mass")
    parser_args.add_argument("--votive", default="Hodie")
    parser_args.add_argument("--propers", action="store_true", help="Mass propers only")
    parser_args.add_argument("--out", default="dist/api")
    parser_args.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    parser_args.add_argument("--force", action="store_true")
    args = parser_args.parse_args(argv)

    args.parser = os.path.abspath(args.parser)
    parser = load_parser(args.parser)
    start = datetime.strptime(args.start, "%Y-%m-%d").date()
    end = datetime.strptime(args.end, "%Y-%m-%d").date()
    hours = [h.strip() for h in args.hours.split(",") if h.strip()]
    rites = [r.strip() for r in args.rites.split(",") if r.strip()]

    # The engine runs one process per request; PERL5LIB points at the modules
    # installed beside the checkout, if any.
    runner = dict(os.environ)
    local_lib = os.path.join(os.path.dirname(args.repo.rstrip("/")), "perl-local", "lib", "perl5")
    if os.path.isdir(local_lib):
        runner["PERL5LIB"] = local_lib + (":" + runner["PERL5LIB"] if runner.get("PERL5LIB") else "")

    tasks = []
    for day in daterange(start, end):
        if "office" in rites:
            for hour in hours:
                tasks.append(("office", day, hour))
        if "mass" in rites:
            tasks.append(("mass", day, None))

    engine = engine_for(args.engine, parser, args)

    started = time.time()
    counts = {"write": 0, "skip": 0, "empty": 0, "error": 0}
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = []
        for kind, day, hour in tasks:
            if kind == "office":
                futures.append(pool.submit(job_office, parser, args, engine, day, hour, runner))
            else:
                futures.append(pool.submit(job_mass, parser, args, engine, day, runner))
        for future in concurrent.futures.as_completed(futures):
            try:
                status, path = future.result()
                counts[status] += 1
                if status == "empty":
                    failures.append(path)
            except Exception as error:  # keep going: a slice takes hours
                counts["error"] += 1
                failures.append(str(error)[:200])
            done = sum(counts.values())
            if done % 25 == 0:
                print(f"  {done}/{len(tasks)} {counts}", flush=True)

    index = {
        "generatedAt": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "source": args.base_url if args.engine == "http" else "divinum-officium (local engine)",
        "version": args.version,
        "lang1": args.lang1,
        "lang2": args.lang2,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "hours": hours,
        "rites": rites,
        "votive": args.votive,
        "propers": bool(args.propers),
        "counts": counts,
        "seconds": round(time.time() - started, 1),
    }
    write_json(os.path.join(args.out, "index.json"), index)
    print(json.dumps(index, indent=2))
    if failures:
        print(f"{len(failures)} problem(s), first few:", failures[:5], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
