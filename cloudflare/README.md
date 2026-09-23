# A private API for the Divinum Officium texts

No container, no Docker, no pre-rendered texts. The repository's own files are
uploaded as **Worker static assets** and the Worker assembles an office or a
Mass from them per request. What the API does not re-derive is which office
*win* a date: that comes from a **calendar artifact** built at deploy time by
asking the engine itself.

```
reader / website ──▶ Access (service token) ──▶ Worker ──▶ assets: the repo's own texts
                                                    └────▶ calendar/<version>/<year>.json
```

Live at `https://divinumofficiumapi-api-live-ofrades-yj7tjxuyatwtb5ip.ofrades.workers.dev`,
open for now: `curl` it, or open it in a browser, and the day's identity comes back.

## Open, or closed

```bash
bun run deploy                       # open — anyone with the URL
API_REQUIRE_AUTH=1 bun run deploy    # closed — Cloudflare Access, service tokens only
```

The door is a stack variable, not a rewrite: the Access application is attached
only when `API_REQUIRE_AUTH=1`, and the service token (`PluginToken`) exists
either way, so closing it later needs no new credential — the token printed
above is already the one the readers will use. Close it before the API is
announced; while it is open, the only thing between the texts and the world is
not writing the URL down.

## Endpoints

| Route | What it returns |
| --- | --- |
| `/v1/index.json` | which versions and years the artifact covers |
| `/v1/day/<YYYY-MM-DD>?version=` | the day: headline, colour, rank, winner file, commemorations |
| `/v1/office/<date>/<hour>` | the hour's texts — *assembler pending, answers 501* |
| `/v1/mass/<date>?votive=&propers=` | the Mass — *assembler pending, answers 501* |

```bash
curl -sS -H "CF-Access-Client-Id: $CLIENT_ID" -H "CF-Access-Client-Secret: $CLIENT_SECRET" \
  "$API/v1/day/2026-09-23"
# {"headline":"Feria Quarta Quattuor Temporum Septembris ~ II. classis",
#  "colourKey":"purple","winner":"Tempora/Pent17-3.txt", ...}
```

## Build and deploy

```bash
cd cloudflare
bun install

# The texts: office + Mass for the languages the API serves (~22 MB, 11k files).
bun run assets

# The calendar: asks the engine which office wins each date. Needs perl and the
# engine's modules — either installed system-wide (Arch: perl-cgi perl-date-calc
# perl-algorithm-uri perl-cgi-session perl-cpanel-json-xs perl-timedate) or
# pointed at with PERL5LIB.
PERL5LIB=/path/to/perl5/lib/perl5 bun run calendar

bun run check     # typecheck
bun run dev       # local run at http://localhost:1337
bun run deploy    # dev stage → *.workers.dev   (needs bunx alchemy login)
```

`bun run deploy` prints `apiUrl`, `clientId`, and `clientSecret`; Alchemy
redacts the secret in its log output but keeps it in the state store:

```bash
bunx alchemy state read DivinumOfficiumApi/live_ofrades/PluginToken
```

To run it by hand instead: `alchemy provider cloudflare` for account-level
prerequisites, `bunx alchemy cloudflare bootstrap` once per account.

## The two artifacts, and why they are not "stored data"

- **Texts** (`tools/sync_assets.py`) — the repository's own files, copied
  verbatim into the Worker's assets. A text fix reaches the API on the next
  deploy. Nothing is parsed, rendered or cached ahead of time.
- **Calendar** (`tools/build_calendar.py`) — for each date, the engine's own
  `precedence()` says which file wins, how the day is ranked, what is
  commemorated, and what headline and colour the page would print. It patches a
  **copy** of the engine (the checkout is never touched), dumps only the
  selection (365 days ≈ 167 KB), and is regenerated on every deploy. The texts
  are assembled per request *from* those files — the artifact is the map, not
  the territory.

Day metadata is parity-exact by construction: `headline` and `colourKey` were
**365/365 identical** to the golden corpus (the reader's own view of the
rendered pages) for all of 2026.

## Tests

- `tools/generate_slice.py` + `tools/divinum_officium.py` (vendored from the
  Omarchy reader) walk the engine and write the golden corpus the TypeScript
  assembler will be measured against. Full year 2026, Rubrics 1960, Latin +
  Português, office + Mass: 3,285 payloads, zero errors, 67 seconds.
- `tests/golden/` is build output and stays out of git; a small pinned sample
  lands when the assembler does.

## Housekeeping

```bash
bun run destroy       # Worker, assets, and the Access resources for the stage
```

Revoking a reader is deleting its service token in Zero Trust — the Worker and
the container-less stack do not change.
