import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type { Engine } from "./src/worker";

// Open while the API is only yours; one variable closes it again.
//
//   API_REQUIRE_AUTH=1 bun run deploy     → service tokens only (Cloudflare Access)
//   bun run deploy                        → open to anyone with the URL
//
// The Access resources (service token, policy, application) are declared either
// way, so closing the door later costs nothing but the variable — the token the
// readers use already exists.
//
// A private API for the Divinum Officium texts.
//
// The engine answers: the Divinum Officium Perl CGI, in a container built from
// the repository's own image plus the JSON service in front of it (see
// Dockerfile and service.py). The Worker is the door — it normalises the
// version, keeps the workers.dev hostname, and applies Access when asked.
//
// Nothing is ported, pre-rendered or stored: every request runs the engine
// against the repository's files and returns what the website itself would.
export default Alchemy.Stack(
  "DivinumOfficiumApi",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;

    const token = yield* Cloudflare.Access.ServiceToken("PluginToken", {
      name: "omarchy divinum officium",
    });

    // Service Auth: service tokens only, no identity provider, no login page.
    const policy = yield* Cloudflare.Access.Policy("ServiceAuth", {
      name: "service token only",
      decision: "non_identity",
      include: [{ serviceToken: { tokenId: token.serviceTokenId } }],
    });

    const requireAuth = process.env.API_REQUIRE_AUTH === "1";

    // The engine's container. `context` is the repository root, so the image
    // carries this fork's own engine and texts; `instances: 1` keeps one
    // container warm so a request never waits for a cold start. Set it to 0 to
    // scale to zero and trade the first request's seconds for the bill.
    const engine = Cloudflare.Container<Engine>("Engine", {
      dockerfile: "cloudflare/Dockerfile",
      context: "..",
      instanceType: "basic",
      instances: 1,
    });

    const api = yield* Cloudflare.Worker("Api", {
      main: "./src/worker.ts",
      workersDev: true,
      env: { Engine: engine },
      ...(requireAuth
        ? {
            access: {
              name: stage === "prod" ? "Divinum Officium API" : "Divinum Officium API (dev)",
              policies: [policy],
            },
          }
        : {}),
    });

    return {
      apiUrl: api.url,
      open: !requireAuth,
      // The reader's credentials for when the door is closed again.
      clientId: token.clientId,
      clientSecret: token.clientSecret,
    };
  }),
);
