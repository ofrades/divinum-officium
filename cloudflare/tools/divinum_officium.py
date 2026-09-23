#!/usr/bin/env python3
# Vendored from omarchy-divinum-officium (divinum_officium.py).
# The corpus must be in the reader's own format, so the reader's parser is the
# one that writes it.
"""Fetch and parse the traditional Roman liturgy from a Divinum Officium server.

Divinum Officium (https://github.com/DivinumOfficium/divinum-officium) renders
both books as an HTML table: one row per section (Incipit, Hymnus, Psalmi,
Capitulum, Oratio, ... for the breviary; Introitus, Oratio, Lectio, Evangelium,
... for the missal), one cell per language. This helper turns that table into
JSON the Omarchy shell plugin can draw directly, and caches it so a bar widget
does not hammer the server.

Only the Python standard library is used.

Usage:
  divinum_officium.py office --date 2026-09-23 --hour Prima \
      --version "Rubrics 1960 - 1960" --calendar Generale \
      --lang1 Latin --lang2 English \
      [--base-url https://divinumofficium.hu] [--ttl 21600] [--refresh]
  divinum_officium.py mass --date 2026-09-23 [--votive C9] [--propers] \
      [--version "Rubrics 1960 - 1960"] [--lang1 Latin] [--lang2 English]
  divinum_officium.py clear-cache
  divinum_officium.py cache-path

Output: a single JSON object on stdout, always with an "ok" field.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.1.0"
DEFAULT_BASE_URL = "https://divinumofficium.hu"
DEFAULT_TTL = 6 * 3600
DEFAULT_CALENDAR = "Generale"
# robots.txt on the public mirrors asks for Crawl-delay: 10.
CRAWL_DELAY_SECONDS = 10

# The two books the server renders, and the CGI that renders each.
RITES = {
    "office": "/cgi-bin/horas/Pofficium.pl",
    "mass": "/cgi-bin/missa/missa.pl",
}

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


def normalize_calendar(value: str | None) -> str:
    wanted = (value or "").strip()
    if not wanted:
        return DEFAULT_CALENDAR
    for calendar in CALENDARS:
        if calendar.lower() == wanted.lower():
            return calendar
    return DEFAULT_CALENDAR

# Divinum Officium paints the day title with one of these names. "black" is the
# Roman "white or ferial" class (setfont omits COLOR for it), "grey" is the real
# black of requiems. The plugin renders both a name and a swatch.
COLOR_NAMES = {
    "": "White",
    "black": "White",
    "white": "White",
    "red": "Red",
    "green": "Green",
    "purple": "Violet",
    "blue": "Marian Blue",
    "grey": "Black",
    "gold": "Gold",
}


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #


def cache_dir() -> str:
    root = os.environ.get("XDG_CACHE_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache"
    )
    path = os.path.join(root, "omarchy", "divinum-officium")
    os.makedirs(path, exist_ok=True)
    return path


def collapse(text: str) -> str:
    """Squeeze HTML-era whitespace without touching the liturgical marks."""
    text = text.replace("\u00a0", " ").replace("\u2002", " ").replace("\u2003", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text)
    return text.strip()


def strip_tags(fragment: str) -> str:
    return collapse(html.unescape(re.sub(r"<[^>]+>", "", fragment)))


def iso_to_do_date(value: str) -> str:
    """``2026-09-23`` -> ``09-23-2026``, the format Pofficium.pl expects."""
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", value)
    if match:
        year, month, day = match.groups()
        return f"{month}-{day}-{year}"
    return value


def relative_date(value: str) -> str:
    from datetime import date, timedelta

    today = date.today()
    if value == "today":
        return today.isoformat()
    if value == "tomorrow":
        return (today + timedelta(days=1)).isoformat()
    if value == "yesterday":
        return (today - timedelta(days=1)).isoformat()
    return value


def rite_params(rite: str, args: argparse.Namespace, date_iso: str) -> dict:
    """The query string a rite needs. Kept pure so the tests can check it."""
    params = {
        "date1": iso_to_do_date(date_iso),
        "version": args.version,
        "dioecesis": normalize_calendar(getattr(args, "calendar", DEFAULT_CALENDAR)),
        "lang1": args.lang1,
        "lang2": args.lang2,
        "content": "1",
    }
    if rite == "mass":
        params["command"] = "pray"
        # Unset votive means the Mass of the day; Propers=1 leaves out the
        # Ordinary, which is how the server's own toggle works.
        if getattr(args, "votive", "Hodie") not in ("", "Hodie"):
            params["votive"] = args.votive
        params["Propers"] = "1" if getattr(args, "propers", False) else "0"
    else:
        params["command"] = "pray" + args.hour
    return params


# --------------------------------------------------------------------------- #
# HTML -> structured sections
# --------------------------------------------------------------------------- #

RE_ROW = re.compile(r"<TR\b[^>]*>(.*?)(?=<TR\b|</TABLE>|$)", re.S | re.I)
RE_TD = re.compile(r"<TD\b[^>]*>(.*?)(?=<TD\b|</TR>|</TABLE>|$)", re.S | re.I)
RE_LABEL = re.compile(
    r"<FONT\b[^>]*SIZE=['\"]?\+1['\"]?[^>]*>\s*<B>\s*<I>(.*?)</I>\s*</B>\s*</FONT>",
    re.S | re.I,
)
RE_NOTE = re.compile(
    r"<FONT\b[^>]*SIZE=['\"]?-1['\"]?[^>]*>\s*\{(.*?)\}\s*</FONT>", re.S | re.I
)
RE_H2 = re.compile(r"<H2\b[^>]*>(.*?)</H2>", re.S | re.I)
RE_HEADLINE = re.compile(r"<P\b[^>]*ALIGN=['\"]?CENTER['\"]?[^>]*>(.*?)</P>", re.S | re.I)
RE_FONT_OPEN = re.compile(r"<FONT\b([^>]*)>", re.I)
RE_RUBRIC = re.compile(r"^\s*<FONT\b[^>]*>\s*<I>(.*?)</I>\s*</FONT>(.*)$", re.S | re.I)
RE_VERSE = re.compile(
    r"^\s*<FONT\b[^>]*SIZE=['\"]?1['\"]?[^>]*>(.*?)</FONT>(.*)$", re.S | re.I
)

# The missal prints a green part number top-right in the cell it introduces,
# and both books carry their own in-page jumps ("Top", "Next"). Neither is text
# of the office; the popup links (a rubric's cross-reference) keep their words.
RE_PART_NUMBER = re.compile(
    r"<DIV\b[^>]*ALIGN=['\"]?RIGHT['\"]?[^>]*>.*?</DIV>", re.S | re.I
)
RE_PAGE_JUMP = re.compile(
    r"<A\b[^>]*HREF=['\"]?#(?:top|\d+)['\"]?[^>]*>.*?</A>", re.S | re.I
)

# Short italic signposts that stand on their own: "Ant.", "Psalmus 53", "℣.".
MARKERS = {
    "ant.",
    "ant",
    "antiphona",
    "antiphon",
    "℣.",
    "℟.",
    "v.",
    "r.",
    "℣",
    "℟",
    "versus",
    "verse",
    "responsorium",
    "responsory",
    "capitulum",
    "chapter",
    "little chapter",
    "hymnus",
    "hymn",
    "oratio",
    "prayer",
    "lectio",
    "lectio brevis",
    "lesson",
    "short reading",
    "psalmus",
    "psalm",
    "psalmi",
    "psalms",
    "canticum",
    "canticle",
    "prex",
    "preces",
    "pater",
    "ave",
    "credo",
    "gloria",
    "symbolum",
    "invitatorium",
    "martyrologium",
    "martyrology",
    "conclusio",
    "conclusion",
    "divinum auxilium",
    "sacrosanctae",
    "kyrie",
    "benedictio",
    "benediction",
    "absolutio",
    "jube domne",
    "jube domine",
    "initium",
    "incipit",
    "alleluia",
    "laus tibi",
    "de officio capituli",
    "the capitular office",
    "start",
}

TITLE_WORDS = (
    "psalmus",
    "canticum",
    "hymnus",
    "lectio",
    "capitulum",
    "oratio",
    "antiphona",
    "invitatorium",
    "responsorium",
    "psalm",
    "canticle",
    "lesson",
    "chapter",
    "prayer",
    "hymn",
)


def classify_line(segment: str) -> dict | None:
    """Turn one ``<BR>``-delimited line into a marked-up line dict."""
    if not segment.strip():
        return None

    verse = RE_VERSE.match(segment)
    if verse:
        marker = strip_tags(verse.group(1))
        rest = strip_tags(verse.group(2))
        if re.match(r"^\d+\s*[:.]\s*\d+", marker):
            return {"k": "verse", "marker": marker, "text": rest}

    rubric = RE_RUBRIC.match(segment)
    if rubric:
        label = strip_tags(rubric.group(1))
        rest = strip_tags(rubric.group(2))
        if label.lower().startswith(TITLE_WORDS):
            return {"k": "title", "text": label, "after": rest}
        if label.lower() in MARKERS or len(label) <= 24:
            return {"k": "rubric", "marker": label, "text": rest}

    text = strip_tags(segment)
    if not text:
        return None
    return {"k": "text", "text": text}


def parse_cell(cell: str) -> dict:
    """Parse one language cell: its label, its note, and the lines beneath."""
    cell = RE_PART_NUMBER.sub("", cell)
    cell = RE_PAGE_JUMP.sub("", cell)
    label = ""
    note = ""
    match = RE_LABEL.search(cell)
    if match:
        label = strip_tags(match.group(1))
        cell = cell[match.end() :]
    match = RE_NOTE.search(cell)
    if match:
        note = strip_tags(match.group(1))
        cell = cell[: match.start()] + cell[match.end() :]

    segments = re.split(r"<BR\b[^>]*/?>", cell, flags=re.I)
    lines = [line for line in (classify_line(seg) for seg in segments) if line]
    return {"label": label, "note": note, "lines": lines}


def parse_payload(document: str, meta: dict) -> dict:
    """Parse a Pofficium.pl page into the JSON the plugin consumes."""
    lowered = document.lower()
    start = lowered.find("<body")
    body = document[start:] if start >= 0 else document

    title = ""
    color_raw = ""
    commemorations: list[str] = []
    head = RE_HEADLINE.search(body)
    if head:
        inner = head.group(1)
        font = re.search(r"<FONT\b[^>]*>(.*?)</FONT>", inner, re.S | re.I)
        if font:
            title = strip_tags(font.group(1))
            attrs = RE_FONT_OPEN.search(font.group(0))
            attrs = attrs.group(1) if attrs else ""
        else:
            title = strip_tags(inner)
            attrs = ""
        color = re.search(r"COLOR=['\"]?([a-zA-Z#0-9]+)", attrs, re.I)
        color_raw = color.group(1) if color else ""
        for span in re.findall(r"<I>(.*?)</I>", inner, re.S | re.I):
            text = strip_tags(span)
            if text and text != title:
                commemorations.append(text)

    hour_title = ""
    headings = [strip_tags(m) for m in RE_H2.findall(body)]
    if headings:
        hour_title = headings[0]

    sections = []
    for row in RE_ROW.findall(body):
        cells = [cell for cell in RE_TD.findall(row) if cell.strip()]
        if not cells:
            continue
        columns = [parse_cell(cell) for cell in cells]
        if not any(column["lines"] for column in columns):
            continue
        sections.append({"columns": columns})

    # setfont() leaves COLOR off for black, which is the white/ferial class.
    color_key = (color_raw or "").strip().lower() or "black"
    if color_key.startswith("#") and not re.match(r"^#[0-9a-f]{3,8}$", color_key):
        color_key = "black"

    payload = dict(meta)
    payload.update(
        {
            "ok": True,
            "title": title,
            "commemorations": commemorations,
            "hourTitle": hour_title,
            "colorKey": color_key,
            "colorName": COLOR_NAMES.get(color_key, "—"),
            "sections": sections,
            "sectionCount": len(sections),
        }
    )
    return payload


# --------------------------------------------------------------------------- #
# fetching + caching
# --------------------------------------------------------------------------- #


def rate_limit(cache: str) -> None:
    """Honour the mirrors' Crawl-delay: 10 between network requests."""
    stamp = os.path.join(cache, "last-fetch")
    try:
        with open(stamp) as handle:
            last = float(handle.read().strip())
    except (OSError, ValueError):
        last = 0.0
    wait = CRAWL_DELAY_SECONDS - (time.time() - last)
    if wait > 0:
        time.sleep(wait)
    with open(stamp, "w") as handle:
        handle.write(str(time.time()))


def fetch(
    base_url: str,
    rite: str,
    params: dict,
    cache: str,
    timeout: int = 45,
    headers: dict | None = None,
    delay: bool = True,
) -> str:
    url = base_url.rstrip("/") + RITES.get(rite, RITES["office"])
    request_headers = {
        "User-Agent": (
            "omarchy-divinum-officium/" + VERSION + " "
            "(+https://github.com/ofrades/omarchy-divinum-officium)"
        ),
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en",
    }
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(
        url + "?" + urllib.parse.urlencode(params), headers=request_headers
    )
    # A private API of one's own is not a volunteer mirror: it needs no
    # Crawl-delay, and its owner knows the traffic it gets.
    if delay:
        rate_limit(cache)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def api_url_for(base_url: str, rite: str, date_iso: str, hour: str) -> str:
    """The API's own route for a rite — it answers with the reader's payload."""
    if rite == "mass":
        return f"{base_url.rstrip('/')}/v1/mass/{date_iso}"
    return f"{base_url.rstrip('/')}/v1/office/{date_iso}/{hour}"


def fetch_api(url: str, params: dict, timeout: int = 45) -> dict:
    """Ask the API for a payload; it is already in the reader's own shape."""
    request = urllib.request.Request(
        url + "?" + urllib.parse.urlencode(params),
        headers={
            "User-Agent": (
                "omarchy-divinum-officium/" + VERSION + " "
                "(+https://github.com/ofrades/omarchy-divinum-officium)"
            ),
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def cache_key(meta: dict) -> str:
    material = "|".join(
        str(meta.get(key, ""))
        for key in (
            "baseUrl",
            "rite",
            "date",
            "hour",
            "version",
            "calendar",
            "lang1",
            "lang2",
            "votive",
            "propers",
        )
    )
    digest = hashlib.sha1(material.encode("utf-8")).hexdigest()[:12]
    return f"{meta['date']}-{meta['rite']}-{meta.get('hour') or meta.get('votive') or 'mass'}-{digest}.json"


def read_cache(path: str, ttl: int) -> tuple[dict | None, bool]:
    try:
        with open(path) as handle:
            stored = json.load(handle)
    except (OSError, ValueError):
        return None, False
    payload = stored.get("payload")
    if not isinstance(payload, dict):
        return None, False
    age = time.time() - float(stored.get("fetchedAt", 0))
    return payload, age <= ttl


def office(args: argparse.Namespace) -> dict:
    cache = cache_dir()
    date_iso = relative_date(args.date)
    rite = "mass" if args.command == "mass" else "office"

    # A private API answers the same CGI paths and takes Access service-token
    # headers; a public server takes neither.
    api_url = (getattr(args, "api_url", "") or "").strip()
    mirror_url = args.base_url.rstrip("/")
    api_hours = [h.strip() for h in (getattr(args, "api_hours", "") or "").split(",") if h.strip()]
    api_serves_hour = bool(api_url) and (
        not api_hours or rite == "mass" or getattr(args, "hour", "") in api_hours
    )
    base_url = api_url.rstrip("/") if api_serves_hour else mirror_url
    api_headers = {}
    if api_url and getattr(args, "access_client_id", "") and getattr(args, "access_client_secret", ""):
        api_headers = {
            "CF-Access-Client-Id": args.access_client_id,
            "CF-Access-Client-Secret": args.access_client_secret,
        }

    meta = {
        "baseUrl": base_url,
        "rite": rite,
        "date": date_iso,
        "hour": getattr(args, "hour", "") if rite == "office" else "",
        "version": args.version,
        "calendar": normalize_calendar(getattr(args, "calendar", DEFAULT_CALENDAR)),
        "lang1": args.lang1,
        "lang2": args.lang2,
        "votive": getattr(args, "votive", "Hodie") if rite == "mass" else "",
        "propers": bool(getattr(args, "propers", False)) if rite == "mass" else False,
        "fetchedAt": int(time.time()),
    }
    path = os.path.join(cache, cache_key(meta))

    if not args.refresh:
        payload, fresh = read_cache(path, args.ttl)
        if payload is not None and fresh:
            payload = dict(payload)
            payload["cached"] = True
            payload["stale"] = False
            return payload

    if api_serves_hour:
        try:
            api_params = {
                "version": args.version,
                "calendar": meta["calendar"],
                "lang1": args.lang1,
                "lang2": args.lang2,
            }
            if rite == "mass":
                votive = getattr(args, "votive", "") or "Hodie"
                if votive != "Hodie":
                    api_params["votive"] = votive
                if getattr(args, "propers", False):
                    api_params["propers"] = "1"
            payload = fetch_api(
                api_url_for(base_url, rite, date_iso, meta["hour"]),
                api_params,
            )
            if payload.get("ok") is True:
                payload["cached"] = False
                payload["stale"] = False
                payload["source"] = api_url
                try:
                    with open(path, "w") as handle:
                        json.dump({"fetchedAt": time.time(), "payload": payload}, handle)
                except OSError:
                    pass
                return payload
            api_error = str(payload.get("error", "the API did not have this hour"))
        except Exception as error:  # urllib raises a family of errors here
            api_error = f"{api_url} unreachable: {error}"
        args_dict = {"apiError": api_error}
        # The public mirror is the fallback for a private API miss. Re-key the
        # cache and metadata too, so a successful mirror response never shares
        # a cache entry with the API response it replaced.
        api_serves_hour = False
        base_url = mirror_url
        meta["baseUrl"] = base_url
        path = os.path.join(cache, cache_key(meta))
    else:
        args_dict = {}

    params = rite_params(rite, args, date_iso)
    try:
        document = fetch(
            base_url,
            rite,
            params,
            cache,
            headers=api_headers if api_serves_hour else None,
            delay=not api_serves_hour,
        )
    except Exception as error:  # urllib raises a family of errors here
        payload, _ = read_cache(path, 0)
        if payload is not None:
            payload = dict(payload)
            payload.update(
                {
                    "cached": True,
                    "stale": True,
                    "error": f"{base_url} unreachable: {error}",
                }
            )
            return payload
        return {
            "ok": False,
            "error": f"{base_url} unreachable: {error}",
            "baseUrl": base_url,
            "rite": rite,
            "date": date_iso,
            "hour": meta["hour"],
        }

    payload = parse_payload(document, meta)
    payload["rite"] = rite
    for key, value in args_dict.items():
        payload[key] = value
    if not payload["hourTitle"]:
        payload["hourTitle"] = "Sancta Missa" if rite == "mass" else ""
    payload["cached"] = False
    payload["stale"] = False
    if not payload["sections"]:
        payload["ok"] = False
        payload["error"] = "no text in the response (unexpected page layout)"
    try:
        with open(path, "w") as handle:
            json.dump({"fetchedAt": time.time(), "payload": payload}, handle)
    except OSError:
        pass
    return payload


def add_source_args(parser: argparse.ArgumentParser, default_base: str) -> None:
    """The source options both rites share."""
    parser.add_argument("--base-url", default=default_base)
    parser.add_argument("--version", default="Rubrics 1960 - 1960")
    parser.add_argument("--calendar", default=DEFAULT_CALENDAR, choices=CALENDARS)
    parser.add_argument("--lang1", default="Latin")
    parser.add_argument("--lang2", default="English")
    parser.add_argument("--ttl", type=int, default=DEFAULT_TTL)
    parser.add_argument("--refresh", action="store_true")
    # A private Divinum Officium API of one's own, e.g. from a Cloudflare
    # Container: the reader's JSON paths, Access service-token headers, no crawl delay.
    parser.add_argument("--api-url", default="")
    parser.add_argument("--api-hours", default="", help="comma-separated hours the API serves well; empty means all")
    parser.add_argument("--access-client-id", default="")
    parser.add_argument("--access-client-secret", default="")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Divinum Officium helper")
    parser.add_argument("--version-number", action="version", version=VERSION)
    sub = parser.add_subparsers(dest="command")

    office_parser = sub.add_parser("office", help="fetch one canonical hour")
    office_parser.add_argument("--date", default="today")
    office_parser.add_argument("--hour", default="Prima", choices=HOURS)
    add_source_args(office_parser, DEFAULT_BASE_URL)

    mass_parser = sub.add_parser("mass", help="fetch the Mass of a day")
    mass_parser.add_argument("--date", default="today")
    mass_parser.add_argument(
        "--votive",
        default="Hodie",
        help="Missal votive code (C9 is a Requiem, C11 the B.V.M.); Hodie is the Mass of the day",
    )
    mass_parser.add_argument(
        "--propers",
        action="store_true",
        help="propers only: leaves out the Ordinary",
    )
    add_source_args(mass_parser, DEFAULT_BASE_URL)

    sub.add_parser("clear-cache", help="remove every cached office")
    sub.add_parser("cache-path", help="print the cache directory")

    args = parser.parse_args(argv)
    if args.command in ("office", "mass"):
        result = office(args)
        json.dump(result, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0 if result.get("ok") else 1
    if args.command == "clear-cache":
        removed = 0
        for name in os.listdir(cache_dir()):
            if name.endswith(".json") or name == "last-fetch":
                os.remove(os.path.join(cache_dir(), name))
                removed += 1
        print(json.dumps({"ok": True, "removed": removed}))
        return 0
    if args.command == "cache-path":
        print(cache_dir())
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
