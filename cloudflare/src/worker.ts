import { Container, getContainer } from "@cloudflare/containers";
import { SITE_HTML } from "./site";
import { VERSIONS, normalizeVersion, slug } from "./versions";

// The API surface, and the reader that uses it.
//
//   /                                 the reader (one page, no build step)
//   /health                           the engine, as the container sees itself
//   /v1/index.json                    the versions the website offers
//   /v1/day/<date>                    the day: headline, colour, commemorations
//   /v1/office/<date>/<hour>          the hour, from the engine
//   /v1/mass/<date>                   the Mass, from the engine
//
// The engine is the implementation: the Perl CGI the Divinum Officium website
// runs, with the repository's own files in front of it. It lives in the
// container; this Worker is only the door — it normalises the version and hands
// the request over, so nothing is assembled, ported or stored here.
interface Env {
  Engine: DurableObjectNamespace<Engine>;
}

/** The engine, in its container: one process, the repository behind it. */
export class Engine extends Container<Env> {
  defaultPort = 8080;
  // Requests come in bursts (an hour change, a page open) and then stop for a
  // while; twenty minutes of warmth covers the reading of an office.
  sleepAfter = "20m";
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, "");

    if (route === "" || route === "/") return new Response(SITE_HTML, { headers: HTML_HEADERS });

    if (route === "/v1/index.json") {
      return json({
        ok: true,
        generatedBy: "the engine, per request",
        versions: Object.fromEntries(
          VERSIONS.map((version) => [slug(version), { version, years: [] as number[] }]),
        ),
      });
    }

    if (route === "/health" || route.startsWith("/v1/")) {
      // The engine hears one of its own version names, never a near miss.
      const target = new URL(request.url);
      target.searchParams.set("version", normalizeVersion(target.searchParams.get("version")));
      return getContainer(env.Engine, "engine").fetch(
        new Request(target.toString(), { method: request.method, headers: request.headers }),
      );
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
