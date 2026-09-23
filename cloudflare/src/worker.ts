import { Container, getContainer } from "@cloudflare/containers";
import { SITE_HTML } from "./site";
import {
  CALENDARS,
  HOURS,
  LANGUAGES,
  MASS_FORMS,
  VERSIONS,
  VOTIVES,
  normalizeCalendar,
  normalizeLanguage,
  normalizeVersion,
  normalizeVotive,
  slug,
} from "./versions";

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
  API_RATE_LIMIT: RateLimit;
}

/** The engine, in its container: one process, the repository behind it. */
export class Engine extends Container<Env> {
  defaultPort = 8080;
  // Requests come in bursts (an hour change, a page open) and then stop for a
  // while; twenty minutes of warmth covers the reading of an office.
  sleepAfter = "20m";
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=60",
  "x-content-type-options": "nosniff",
};
const INDEX_CACHE = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=300";

function json(body: unknown, status = 200, cacheControl = "no-store"): Response {
  const headers = new Headers(JSON_HEADERS);
  headers.set("cache-control", cacheControl);
  return new Response(JSON.stringify(body), { status, headers });
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
        calendars: CALENDARS,
        languages: LANGUAGES,
        votives: VOTIVES,
        massForms: MASS_FORMS,
        hours: HOURS,
      }, 200, INDEX_CACHE);
    }

    if (route.startsWith("/v1/")) {
      const clientKey = request.headers.get("CF-Connecting-IP") || "anonymous";
      const rate = await env.API_RATE_LIMIT.limit({ key: clientKey });
      if (!rate.success) {
        const response = json({ ok: false, error: "rate limit exceeded" }, 429);
        response.headers.set("retry-after", "60");
        return response;
      }
    }

    if (route === "/health" || route.startsWith("/v1/")) {
      // The engine hears one of its own version names, never a near miss.
      const target = new URL(request.url);
      target.searchParams.set("version", normalizeVersion(target.searchParams.get("version")));
      const calendar = target.searchParams.get("calendar") || target.searchParams.get("dioecesis");
      target.searchParams.set("dioecesis", normalizeCalendar(calendar));
      target.searchParams.delete("calendar");
      target.searchParams.set("lang1", normalizeLanguage(target.searchParams.get("lang1"), "Latin"));
      target.searchParams.set("lang2", normalizeLanguage(target.searchParams.get("lang2"), "English"));
      if (route.startsWith("/v1/mass/")) {
        target.searchParams.set("votive", normalizeVotive(target.searchParams.get("votive")));
        const propers = ["1", "true", "yes"].includes(
          (target.searchParams.get("propers") || "").toLowerCase(),
        );
        target.searchParams.set("propers", propers ? "1" : "0");
      }
      return getContainer(env.Engine, "engine").fetch(
        new Request(target.toString(), { method: request.method, headers: request.headers }),
      );
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
