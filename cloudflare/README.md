# A private API for the engine

The website and the Omarchy plugin both read the engine over HTTP. This
directory turns the engine into an API of your own: the Perl server runs in a
Cloudflare Container built from this project's own published image, behind a
Worker that Cloudflare Access keeps private. Nothing is pre-generated and
nothing is stored — every request is rendered by the engine from the texts in
this repository.

```
plugin / curl ──▶ Access (service token) ──▶ Worker (two CGI paths) ──▶ Container: starman :8080
```

## What it costs

Containers require the **Workers Paid** plan ($5/month). That plan includes
25 GiB-hours of memory and 375 vCPU-minutes a month; the engine instance is
`basic` (1 GiB), and it sleeps after ten idle minutes, so a handful of offices
a day stays inside the included quota. Raise or lower
`Cloudflare.Container<Engine>(...)` props in `alchemy.run.ts` to change size or
idle time.

## Deploy

```bash
cd cloudflare
bun install
bunx alchemy login              # once per machine
bunx alchemy cloudflare bootstrap   # once per account: Alchemy's state store
bun run deploy                  # dev stage → *.workers.dev URL
```

The first deploy pulls `ghcr.io/divinumofficium/divinum-officium:master` and
pushes it to Cloudflare's registry — no local Docker build. It also creates:

| Resource | What it is |
| --- | --- |
| `Engine` | the container application (the engine image, one basic instance) |
| `Api` | the Worker, with Access attached to its workers.dev hostname |
| `PluginToken` | an Access service token — the credential readers use |
| `ServiceAuth` | the policy: service tokens only, no login page |

`bun run deploy` prints `apiUrl`, `clientId`, and `clientSecret`. The secret is
shown once by Alchemy's output; keep it and put it in the reader's settings.

Check it:

```bash
curl -sS -H "CF-Access-Client-Id: $CLIENT_ID" \
         -H "CF-Access-Client-Secret: $CLIENT_SECRET" \
         "$API_URL/cgi-bin/horas/Pofficium.pl?command=prayPrima&date1=hodie&lang1=Latin&lang2=English&content=1" \
  | head -c 200
```

`/` answers a health line, `/cgi-bin/horas/Pofficium.pl` is the breviary, and
`/cgi-bin/missa/missa.pl` is the missal — the same parameters the website's own
forms use. Everything else 404s; the Worker is a door, not a proxy.

## Wiring the reader

In the Omarchy plugin (`io.github.ofrades.divinum-officium`), set:

| Setting | Value |
| --- | --- |
| `apiUrl` | the `apiUrl` printed above |
| `apiServiceTokenId` | `clientId` |
| `apiServiceTokenSecret` | `clientSecret` |

With those set, the reader talks to your API instead of a public mirror: no
crawl delay, no third-party dependency, and the texts come from this
repository. Clear them to fall back to the mirror.

## Housekeeping

```bash
bun run deploy:prod   # same stack, prod stage (named resources, longer cache)
bun run destroy       # remove Worker, container, token; keep the image
```

Revoking access is deleting `PluginToken` (`alchemy destroy` removes it, or
delete the service token in Zero Trust) — the container itself does not need to
change. To rotate the secret, delete the token and deploy again.
