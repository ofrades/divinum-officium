import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type { Engine } from "./worker.ts";

// A private API for the Divinum Officium engine.
//
// The engine is Perl — Starman serving the same CGI the website uses — so it
// runs in a Cloudflare Container built from the project's own published image.
// The Worker in front of it is only a door: it forwards /cgi-bin/... to the
// container and lets Cloudflare Access decide who may knock. Nothing is
// pre-generated and nothing is stored: the texts are the repository's own,
// rendered per request.
//
// Deploy with `bun run deploy` (dev stage, workers.dev URL) or
// `bun run deploy:prod`. Nothing is built locally: the engine image is pulled
// from ghcr.io and pushed to Cloudflare's registry on first deploy.
export default Alchemy.Stack(
  "DivinumOfficiumApi",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;

    // The service token the Omarchy plugin authenticates with. Revoking the
    // token closes the API to that machine without touching the container.
    const token = yield* Cloudflare.Access.ServiceToken("PluginToken", {
      name: "omarchy divinum officium",
    });

    // Service Auth: service tokens only. No identity provider, no browser
    // login — this is what keeps the workers.dev hostname private.
    const policy = yield* Cloudflare.Access.Policy("ServiceAuth", {
      name: "service token only",
      decision: "non_identity",
      include: [{ serviceToken: { tokenId: token.serviceTokenId } }],
    });

    // `access` gives this Worker its own Access application, covering
    // workers.dev, previews, and any custom domain it is later given.
    const api = yield* Cloudflare.Worker("Api", {
      main: "./worker.ts",
      workersDev: true,
      env: {
        Engine: Cloudflare.Container<Engine>("Engine", {
          image: "ghcr.io/divinumofficium/divinum-officium:master",
          instanceType: "basic",
          ports: [{ name: "http", port: 8080 }],
        }),
      },
      access: {
        name: stage === "prod" ? "Divinum Officium API" : "Divinum Officium API (dev)",
        policies: [policy],
      },
    });

    return {
      apiUrl: api.url,
      clientId: token.clientId,
      clientSecret: token.clientSecret,
    };
  }),
);
