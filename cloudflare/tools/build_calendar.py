#!/usr/bin/env python3
"""Build the API's calendar artifact: the engine's own choice of office per day.

The API never re-derives which office wins a date. At deploy time this script
asks the engine itself — the same `precedence()` the website uses — and records
only the *selection*: the winning file, the commemorations, the rank, the rule,
the vesper index. The texts stay in the repository and are assembled per
request; this artifact is the map, not the territory.

It patches a **copy** of the engine (a few lines, in a temporary directory), so
the checkout in the repository stays pristine and upstream stays upstream.

Usage:
  tools/build_calendar.py --repo ~/divinum-officium --perl-lib ~/perl-local/lib/perl5 \
      --version "Rubrics 1960 - 1960" --years 2026,2027 --out .assets/calendar
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

DUMP_PARAM = "dumpordo"

PATCH_ANCHOR = "precedence($date1);    #fills our hashes et variables"

PATCH = """
# --- dumpordo: build-time only, added by the API's calendar builder ---------
# Emits the engine's own resolution for this date as JSON and stops before
# anything is rendered. Only the *selection* travels: which file wins, what it
# commemorates, the rank, the rule, the vesper index, and the headline and
# colour the page would print. The texts themselves are not dumped.
if (strictparam('dumpordo')) {
  use JSON::PP;
  my $headline = setheadline();
  my %dump = (
    date        => $date1,
    version     => $version,
    winner      => $winner,
    commemoratio => $commemoratio,
    scriptura   => $scriptura,
    commune     => $commune,
    communetype => $communetype,
    rank        => $rank,
    rule        => $rule,
    duplex      => $duplex,
    vespera     => $vespera,
    headline    => $headline,
    colourKey   => liturgical_color($headline),
    titles      => [@dayname],
  );
  print "Content-type: application/json; charset=utf-8\\n\\n";
  # No `utf8` layer: the engine's strings already are UTF-8 bytes.
  print JSON::PP->new->canonical->encode(\\%dump);
  exit;
}
# --- end dumpordo ----------------------------------------------------------
"""


def slug(value: str) -> str:
    return re.sub(r"-+", "-", "".join(ch if ch.isalnum() else "-" for ch in value.lower())).strip("-")


def prepare_engine(repo: str, workdir: str) -> str:
    cgi = os.path.join(repo, "web", "cgi-bin")
    www = os.path.join(repo, "web", "www")
    if not os.path.isdir(cgi) or not os.path.isdir(www):
        raise SystemExit(f"{repo} does not look like a Divinum Officium checkout")
    shutil.copytree(cgi, os.path.join(workdir, "web", "cgi-bin"))
    os.symlink(www, os.path.join(workdir, "web", "www"))
    entry = os.path.join(workdir, "web", "cgi-bin", "horas", "officium.pl")
    raw = open(entry, encoding="utf-8", errors="replace").read()
    if PATCH_ANCHOR not in raw:
        raise SystemExit("the engine moved: `precedence($date1);` not found in officium.pl")
    open(entry, "w", encoding="utf-8").write(raw.replace(PATCH_ANCHOR, PATCH_ANCHOR + PATCH, 1))
    return os.path.join(workdir, "web", "cgi-bin", "horas")


def one_day(horas_dir: str, perl_lib: str, version: str, day: str) -> dict:
    env = dict(os.environ)
    env["PERL5LIB"] = perl_lib + (":" + env["PERL5LIB"] if env.get("PERL5LIB") else "")
    result = subprocess.run(
        [
            "perl", "Pofficium.pl",
            "command=prayPrima",
            f"date1={day.strftime('%m-%d-%Y')}",
            f"version={version}",
            "lang1=Latin",
            "lang2=Latin",
            DUMP_PARAM + "=1",
        ],
        cwd=horas_dir,
        capture_output=True,
        timeout=180,
        env=env,
    )
    output = result.stdout.decode("utf-8", "replace")
    marker = output.find("\n\n")
    if marker < 0:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[:200] or "no output")
    payload = json.loads(output[marker + 2 :])

    def iso(value: str) -> str:
        match = re.match(r"^(\d{2})-(\d{2})-(\d{4})$", text(value))
        return f"{match.group(3)}-{match.group(1)}-{match.group(2)}" if match else text(value)

    def text(value) -> str:
        # The engine leaves several of these undef on days where they do not
        # apply (a Sunday has no commemoration, an un-transferred day no
        # scriptura), and undef arrives as null.
        return str(value if value is not None else "").strip()

    # Only the selection travels; the loaded texts are dropped here on purpose.
    return {
        "date": iso(payload["date"]),
        "winner": text(payload.get("winner")),
        "commemoratio": text(payload.get("commemoratio")),
        "scriptura": text(payload.get("scriptura")),
        "commune": text(payload.get("commune")),
        "communetype": text(payload.get("communetype")),
        "rank": text(payload.get("rank")),
        "rule": text(payload.get("rule")),
        "headline": text(payload.get("headline")),
        "colourKey": text(payload.get("colourKey")),
        "duplex": payload.get("duplex", 0),
        "vespera": payload.get("vespera", 0),
        "titles": [text(t) for t in (payload.get("titles") or [])],
    }


def main(argv: list[str]) -> int:
    from datetime import date, timedelta

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--perl-lib", required=True)
    parser.add_argument("--version", default="Rubrics 1960 - 1960")
    parser.add_argument("--years", default=str(date.today().year))
    parser.add_argument("--out", default=".assets/calendar")
    parser.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    args = parser.parse_args(argv)

    years = [int(y.strip()) for y in args.years.split(",") if y.strip()]
    os.makedirs(args.out, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="ordo-engine-") as workdir:
        horas = prepare_engine(args.repo, workdir)
        for year in years:
            days = []
            day = date(year, 1, 1)
            while day.year == year:
                days.append(day)
                day += timedelta(days=1)

            selection = {}
            failures = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
                futures = {pool.submit(one_day, horas, args.perl_lib, args.version, d): d for d in days}
                for future in concurrent.futures.as_completed(futures):
                    try:
                        record = future.result()
                        selection[record["date"]] = record
                    except Exception as error:
                        failures.append(f"{futures[future]}: {str(error)[:120]}")

            path = os.path.join(args.out, slug(args.version), f"{year}.json")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "version": args.version,
                        "year": year,
                        "generatedBy": "divinum-officium engine (precedence)",
                        "days": selection,
                    },
                    handle,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
            size = os.path.getsize(path)
            print(f"{year}: {len(selection)} days, {size/1024:.0f} KB → {path}")
            if failures:
                print(f"  {len(failures)} failed: {failures[:3]}", file=sys.stderr)

    # The API's /v1/index.json answers from this: which versions exist, and for
    # which years. Written last so a half-built run never advertises itself.
    index_path = os.path.join(args.out, "index.json")
    index = {"generatedBy": "divinum-officium engine (precedence)", "versions": {}}
    for entry in sorted(os.listdir(args.out)):
        version_dir = os.path.join(args.out, entry)
        if not os.path.isdir(version_dir):
            continue
        years = sorted(int(name[:4]) for name in os.listdir(version_dir) if name.endswith(".json"))
        latest = os.path.join(version_dir, f"{years[-1]}.json") if years else None
        version_name = args.version
        if latest:
            version_name = json.load(open(latest, encoding="utf-8"))["version"]
        index["versions"][entry] = {"version": version_name, "years": years}
    with open(index_path, "w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"index → {index_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
