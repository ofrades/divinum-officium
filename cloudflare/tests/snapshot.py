#!/usr/bin/env python3
"""Snapshot the engine's answers, so the API's contract cannot drift.

The API is the engine: ``service.py`` runs the repository's own CGI and hands
the page to the reader's parser. That makes the engine's output the API's
contract, and this suite pins it — one small digest-bearing file per request,
committed beside the tests. Nothing here re-implements anything: the fixtures
run through the same ``Engine.office`` / ``Engine.mass`` calls the routes use,
so a change to the texts, to the engine, or to the parser shows up as a named
section that moved.

  python3 tests/snapshot.py                    compare the fixtures
  python3 tests/snapshot.py --update           re-record them (on purpose)
  python3 tests/snapshot.py --only Laudes      a smaller run while working

For the whole year at a glance — the drift alarm for a weekly upstream sync:

  python3 tests/snapshot.py --sweep 2026 Laudes             compare
  python3 tests/snapshot.py --sweep 2026 Laudes --update    record the baseline

The suite is written for the container the API ships in (the upstream Perl
image, which carries python3), so CI runs it with the same image the API
answers with — see .github/workflows/divinum-api.yml.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE = os.path.dirname(HERE)
REPO_DEFAULT = os.path.dirname(PACKAGE)

DEFAULT_VERSION = "Rubrics 1960 - 1960"
DEFAULT_LANG1 = "Latin"
DEFAULT_LANG2 = "Portugues"

# The liturgical year's sharp edges, plus the hours that lean hardest on the
# engine's fallbacks. Each entry is one date and the hours to ask for; `mass`
# asks the missal instead.
FIXTURES = [
    {"date": "2026-01-01", "hours": ["Laudes", "Tertia", "Vesperae", "Completorium"]},  # octave, I class
    {"date": "2026-02-18", "hours": ["Matutinum", "Laudes", "Vesperae"]},  # Ash Wednesday
    {"date": "2026-03-25", "hours": ["Laudes"], "lang2": "English"},  # Annunciation, second language
    {"date": "2026-04-05", "hours": ["Matutinum", "Laudes", "Vesperae", "Completorium"]},  # Easter
    {"date": "2026-05-14", "hours": ["Laudes", "Vesperae"]},  # Ascension
    {"date": "2026-05-28", "hours": ["Laudes"]},  # Corpus Christi
    {"date": "2026-06-29", "hours": ["Laudes"], "version": "Divino Afflatu - 1939"},  # SS. Peter and Paul
    {"date": "2026-07-14", "hours": ["Laudes", "Vesperae", "Completorium"]},  # a feria in tempore
    {"date": "2026-08-15", "hours": ["Laudes", "Vesperae"]},  # Assumption
    {"date": "2026-09-23", "hours": ["Laudes", "Tertia", "Vesperae"]},  # September Ember Wednesday
    {"date": "2026-11-02", "hours": ["Matutinum", "Laudes"]},  # All Souls
    {"date": "2026-12-24", "hours": ["Vesperae"]},  # Christmas Eve
    {"date": "2026-12-25", "hours": ["Laudes", "Vesperae"]},  # Christmas
    {"date": "2026-01-01", "mass": True},
    {"date": "2026-04-05", "mass": True},
    {"date": "2026-09-23", "mass": True},
    {"date": "2026-12-25", "mass": True},
]


def slug(value: str) -> str:
    out = "".join(character if character.isalnum() else "-" for character in value.lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def load_service(package: str):
    spec = importlib.util.spec_from_file_location("divinum_service", os.path.join(package, "service.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canon_line(line: dict) -> str:
    return "|".join(
        [
            str(line.get("k") or ""),
            str(line.get("marker") or ""),
            str(line.get("text") or ""),
            str(line.get("after") or ""),
        ]
    )


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def digest_of(payload: dict) -> str:
    parts: list[str] = [
        str(payload.get("title") or ""),
        str(payload.get("colorKey") or ""),
        str(payload.get("hourTitle") or ""),
    ]
    for section in payload.get("sections") or []:
        for column in section.get("columns") or []:
            parts.append(str(column.get("label") or ""))
            for line in column.get("lines") or []:
                parts.append(canon_line(line))
    return sha256("\n".join(parts))


def snapshot_of(payload: dict, request: dict) -> dict:
    sections = []
    for section in payload.get("sections") or []:
        columns = []
        for column in section.get("columns") or []:
            lines = column.get("lines") or []
            columns.append(
                {
                    "label": column.get("label") or "",
                    "lines": len(lines),
                    "sha256": sha256("\n".join(canon_line(line) for line in lines)),
                }
            )
        sections.append({"columns": columns})
    return {
        "request": request,
        "title": payload.get("title") or "",
        "colourKey": payload.get("colorKey") or "",
        "hourTitle": payload.get("hourTitle") or "",
        "sectionCount": payload.get("sectionCount") or len(sections),
        "sections": sections,
        "digest": digest_of(payload),
    }


def write_json(path: str, body: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(body, handle, ensure_ascii=False, indent=1, sort_keys=True)
        handle.write("\n")


def read_json(path: str):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def snapshot_path(snapshots: str, request: dict) -> str:
    version = slug(request["version"])
    languages = f"{slug(request['lang1'])}-{slug(request['lang2'])}"
    if request.get("kind") == "mass":
        name = f"mass-{languages}.json"
    else:
        name = f"{request['hour'].lower()}-{languages}.json"
    return os.path.join(snapshots, version, request["date"], name)


def changed_sections(before: dict, after: dict) -> list[str]:
    """Which sections moved, in a form worth reading in a failing run."""
    moved: list[str] = []
    if before.get("digest") == after.get("digest"):
        return moved
    if before.get("title") != after.get("title"):
        moved.append(f"title: {before.get('title')!r} → {after.get('title')!r}")
    if before.get("colourKey") != after.get("colourKey"):
        moved.append(f"colour: {before.get('colourKey')!r} → {after.get('colourKey')!r}")
    was = before.get("sections") or []
    now = after.get("sections") or []
    for index in range(max(len(was), len(now))):
        left = was[index] if index < len(was) else None
        right = now[index] if index < len(now) else None
        if left == right:
            continue
        left_columns = (left or {}).get("columns") or []
        right_columns = (right or {}).get("columns") or []
        for column in range(max(len(left_columns), len(right_columns))):
            a = left_columns[column] if column < len(left_columns) else None
            b = right_columns[column] if column < len(right_columns) else None
            if a == b:
                continue
            label = (b or a or {}).get("label") or "(continued)"
            if a is None:
                moved.append(f"section {index} {label!r} (column {column + 1}): missing → {b['lines']} lines")
            elif b is None:
                moved.append(f"section {index} {label!r} (column {column + 1}): {a['lines']} lines → missing")
            else:
                moved.append(
                    f"section {index} {label!r} (column {column + 1}): "
                    f"{a['lines']} lines {a['sha256'][:8]} → {b['lines']} lines {b['sha256'][:8]}"
                )
    return moved


def requests_from_fixtures() -> list[dict]:
    requests: list[dict] = []
    for fixture in FIXTURES:
        base = {
            "version": fixture.get("version", DEFAULT_VERSION),
            "lang1": fixture.get("lang1", DEFAULT_LANG1),
            "lang2": fixture.get("lang2", DEFAULT_LANG2),
            "date": fixture["date"],
        }
        if fixture.get("mass"):
            requests.append({**base, "kind": "mass", "hour": "mass"})
            continue
        for hour in fixture["hours"]:
            requests.append({**base, "kind": "office", "hour": hour})
    return requests


def run_fixture(engine, request: dict) -> dict:
    day = datetime.strptime(request["date"], "%Y-%m-%d")
    if request["kind"] == "mass":
        payload = engine.mass(day, request["version"], request["lang1"], request["lang2"])
    else:
        payload = engine.office(day, request["hour"], request["version"], request["lang1"], request["lang2"])
    return payload


def sweep(engine, args) -> int:
    """A whole year, one digest per day: the alarm for upstream drift."""
    year = int(args.sweep[0])
    hour = args.sweep[1]
    languages = f"{slug(args.lang1)}-{slug(args.lang2)}"
    name = "mass" if hour.lower() == "mass" else hour.lower()
    path = os.path.join(args.baselines, f"{year}-{name}-{languages}.json")
    baseline = read_json(path) or {}
    today = date(year, 1, 1)
    changed: list[str] = []
    recorded: dict[str, str] = {}
    while today.year == year:
        request = {"kind": "mass" if name == "mass" else "office", "hour": hour, "date": today.isoformat(), "version": args.version, "lang1": args.lang1, "lang2": args.lang2}
        payload = run_fixture(engine, request)
        digest = digest_of(payload)
        recorded[today.isoformat()] = digest
        was = baseline.get(today.isoformat())
        if was is not None and was != digest:
            changed.append(today.isoformat())
        today += timedelta(days=1)
    if args.update:
        write_json(path, recorded)
        print(f"baseline written: {path} ({len(recorded)} days)")
        return 0
    if not baseline:
        print(f"no baseline at {path}; record one with --update")
        return 1
    missing = [day for day in recorded if day not in baseline]
    print(f"sweep {year} {hour} {languages}: {len(recorded)} days, {len(changed)} changed, {len(missing)} new")
    for day in changed[:20]:
        print(f"  changed {day}: {baseline[day][:8]} → {recorded[day][:8]}")
    return 1 if changed or missing else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=REPO_DEFAULT, help="the engine's web root")
    parser.add_argument("--parser", default=os.path.join(PACKAGE, "tools", "divinum_officium.py"))
    parser.add_argument("--fixtures", default=os.path.join(HERE, "snapshots"))
    parser.add_argument("--baselines", default=os.path.join(HERE, "baselines"))
    parser.add_argument("--only", default="", help="keep fixtures whose path mentions this")
    parser.add_argument("--update", action="store_true", help="re-record the snapshots")
    parser.add_argument("--sweep", nargs=2, metavar=("YEAR", "HOUR"), help="a whole year, one digest per day")
    parser.add_argument("--version", default=DEFAULT_VERSION, help="version for --sweep")
    parser.add_argument("--lang1", default=DEFAULT_LANG1)
    parser.add_argument("--lang2", default=DEFAULT_LANG2)
    args = parser.parse_args(argv)

    service = load_service(PACKAGE)
    engine = service.Engine(args.repo, args.parser)

    if args.sweep:
        return sweep(engine, args)

    requests = requests_from_fixtures()
    if args.only:
        requests = [request for request in requests if args.only.lower() in snapshot_path(args.fixtures, request).lower()]

    ok = changed = missing = 0
    moved_report: list[str] = []
    for request in requests:
        path = snapshot_path(args.fixtures, request)
        before = read_json(path)
        payload = run_fixture(engine, request)
        after = snapshot_of(payload, request)
        if before is None:
            missing += 1
            if args.update:
                write_json(path, after)
                missing -= 1
                ok += 1
                print(f"recorded {os.path.relpath(path, HERE)}")
            else:
                print(f"missing  {os.path.relpath(path, HERE)}")
            continue
        if before.get("digest") == after.get("digest") and not args.update:
            ok += 1
            continue
        changed += 1
        if args.update:
            write_json(path, after)
            changed -= 1
            ok += 1
            print(f"updated  {os.path.relpath(path, HERE)}")
            continue
        moved_report.append(os.path.relpath(path, HERE))
        for line in changed_sections(before, after):
            moved_report.append(f"    {line}")

    print(f"\nfixtures {len(requests)}: ok {ok}, changed {changed}, missing {missing}")
    if moved_report:
        print("\nwhat moved:")
        print("\n".join(moved_report))
    return 1 if (changed or missing) else 0


if __name__ == "__main__":
    sys.exit(main())
