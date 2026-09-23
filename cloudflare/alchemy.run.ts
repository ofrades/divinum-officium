import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

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

    const api = yield* Cloudflare.Worker("Api", {
      main: "./src/worker.ts",
      workersDev: true,
      // The texts and the calendar artifact, straight out of the repository.
      // Built by tools/sync_assets.py and tools/build_calendar.py.
      assets: { directory: "./.assets" },
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
