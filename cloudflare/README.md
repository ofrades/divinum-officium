# A private API for the Divinum Officium texts

The engine answers. `service.py` runs the repository's own CGI — the same
`Pofficium.pl` and `missa.pl` the website runs — and hands the resulting page to
the reader's parser, so what comes back is exactly what the website would show,
for any hour, the Mass, every version and every language.

Nothing is ported, pre-rendered or stored: every request runs the engine against
the repository's files. The engine lives in a container built from this fork's
own `web/` laid over the upstream image, and the Worker is the door in front of
it — version in, JSON out.

```
reader / website ──▶ Access (service token) ──▶ Worker ──▶ container: Perl CGI + this repo's files
```

Live at `https://divinumofficiumapi-api-live-ofrades-yj7tjxuyatwtb5ip.ofrades.workers.dev`,
open for now: `curl` it, or open it in a browser, and the day comes back.

## Open, or closed

```bash
bun run deploy                       # open — anyone with the URL
API_REQUIRE_AUTH=1 bun run deploy    # closed — Cloudflare Access, service tokens only
```

The door is a stack variable, not a rewrite: the Access application is attached
only when `API_REQUIRE_AUTH=1`, and the service token (`PluginToken`) exists
either way, so closing it later needs no new credential — the token the deploy
prints is already the one the readers will use. Close it before the API is
announced; while it is open, the only thing between the texts and the world is
not writing the URL down.

## Endpoints

| Route | What it returns |
| --- | --- |
| `/health` | the engine, as the container sees itself |
| `/v1/index.json` | the versions the website offers |
| `/v1/day/<YYYY-MM-DD>?version=&lang1=&lang2=` | the day: headline, colour, commemorations |
| `/v1/office/<YYYY-MM-DD>/<hour>?version=&lang1=&lang2=` | the hour's texts |
| `/v1/mass/<YYYY-MM-DD>?version=&lang1=&lang2=&votive=&propers=1` | the Mass's texts |

```bash
curl -sS -H "CF-Access-Client-Id: $CLIENT_ID" -H "CF-Access-Client-Secret: $CLIENT_SECRET" \
  "$API/v1/day/2026-09-23"
# {"headline":"Feria Quarta Quattuor Temporum Septembris ~ II. classis",
#  "colourKey":"purple","commemorations":["Commemoratio ad Laudes tantum: ..."], ...}
```

The JSON is the same shape the Omarchy plugin and the reader page already
consume, because it comes from the plugin's own parser (`tools/divinum_officium.py`,
vendored); no reader needs to know an engine exists.

## Build and deploy

```bash
cd cloudflare
bun install
bun run check     # typecheck
bun run image     # build the container locally (needs Docker)
bun run deploy    # container application + Worker + Access resources
bun run dev       # alchemy dev
```

Deploying builds the image and pushes it to Cloudflare's registry. Docker must be
reachable by the user running the deploy — on a machine where the user was added
to the `docker` group after logging in, `newgrp docker` in front of the command
is enough.

- `Dockerfile` pins the engine image **by digest** and lays this branch's `web/`
  over it, so the container carries the fork's own engine and texts.
- `instances: 1` in `alchemy.run.ts` keeps one container warm — a cold container
  takes seconds to answer — and `sleepAfter` on the Worker's `Engine` class says
  how long an idle instance stays up. Set `instances: 0` to scale to zero and
  accept the first request's wait.
- `bun run deploy` prints `apiUrl`, `clientId` and `clientSecret`; Alchemy
  redacts the secret in its log but keeps it in the state store:
  `bunx alchemy state read DivinumOfficiumApi/live_ofrades/PluginToken`.

## Tests

The engine's output *is* the API's contract, so the tests pin it. They run the
same `Engine.office` / `Engine.mass` calls the routes use — no parallel path into
the engine — and they run inside the same pinned image the API answers with.

```bash
python3 tests/snapshot.py                  # 33 fixtures, ~4 seconds
python3 tests/snapshot.py --update         # re-record, on purpose
python3 tests/snapshot.py --sweep 2026 Laudes        # a year, one digest per day
python3 tests/snapshot.py --sweep 2026 Laudes --update
```

- `tests/snapshots/` — small digest files per request: title, colour, and one
  hash per section column. A failing run names the section that moved and how
  many lines it went from and to, without carrying the texts around.
- `tests/baselines/` — a whole year at one digest per day: the alarm for a text
  or engine change arriving from upstream.
- `.github/workflows/divinum-api.yml` runs both on pushes to this branch, and a
  second job asks **upstream's** checkout the same questions, so drift is visible
  here before a reader sees it.

The fixtures cover the year's sharp edges (the Christmas octave, Ash Wednesday,
Easter, the Ember days, All Souls, Christmas), every kind of hour (Matins to
Compline), the Mass, a second language, and an older version — the places where
the engine's fallbacks and version guards do their work.

## Updating the engine or the texts

- Texts and engine code live in `web/`, so syncing this branch is enough: the
  image is rebuilt on deploy, and the snapshot suite tells you what moved.
  Re-record deliberately (`--update`) when the change is wanted.
- The base image digest appears in `Dockerfile` and in the workflow; bump both
  together.

## Housekeeping

```bash
bun run destroy       # Worker, container application, and the Access resources
```

Revoking a reader is deleting its service token in Zero Trust — neither the
Worker nor the container changes.
