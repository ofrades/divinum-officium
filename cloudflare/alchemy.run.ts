import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// Open while the API is only yours; one variable closes it again.
//
//   API_REQUIRE_AUTH=1 bun run deploy     → service tokens only (Cloudflare Access)
//   bun run deploy                        → open to anyone with the URL
//
// The Access resources (service token, policy, application) are declared either
// way, so closing the door later costs nothing but the variable — the token the
// readers use already exists.

// A private API for the Divinum Officium texts.
//
// No container: the repository's own files are served to the Worker as static
// assets, and the Worker assembles an office or a Mass from them per request.
// The calendar artifact (built at deploy time from the engine's own
// precedence — see tools/build_calendar.py) says which file wins a date.
//
// Cloudflare Access keeps the workers.dev hostname private: readers present a
// service token, which this stack creates and prints.
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

    const api = yield* Cloudflare.Worker("Api", {
      main: "./src/worker.ts",
      workersDev: true,
      // The texts and the calendar artifact, straight out of the repository.
      // Built by tools/sync_assets.py and tools/build_calendar.py.
      assets: { directory: "./.assets" },
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
