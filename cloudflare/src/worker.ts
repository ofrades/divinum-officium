import { type CalendarArtifact, type CalendarIndex, normalizeVersion, slug } from "./artifact";

// The API surface. Two ends:
//
//   /v1/day/<date>                    what the day is, from the calendar artifact
//   /v1/office|mass/<date>[/<hour>]   the texts, assembled from the repository
//
// The texts are assembled from the repository's own files, served here as
// static assets; nothing is pre-rendered. The calendar artifact says which of
// those files wins a date — it is built at deploy time by asking the engine
// itself (cloudflare/tools/build_calendar.py), so the day's identity matches
// the website's exactly.
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function readJson<T>(env: Env, request: Request, path: string): Promise<T | null> {
  // The asset layer answers anything that matches a file; the Worker reads its
  // own data the same way a browser would.
  const assetRequest = new Request(new URL(path, request.url).toString(), { method: "GET" });
  const response = await env.ASSETS.fetch(assetRequest);
  if (!response.ok) return null;
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function isoDate(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, "");

    if (route === "" || route === "/health") {
      return json({ ok: true, api: "divinum-officium", endpoints: ["/v1/day/<date>", "/v1/office/<date>/<hour>", "/v1/mass/<date>"] });
    }

    if (route === "/v1/index.json") {
      const index = await readJson<CalendarIndex>(env, request, "/calendar/index.json");
      return json({
        ok: true,
        generatedBy: index?.generatedBy ?? null,
        versions: index?.versions ?? {},
      });
    }

    const dayMatch = route.match(/^\/v1\/day\/([^/]+)$/);
    if (dayMatch) {
      const date = isoDate(dayMatch[1]);
      if (!date) return json({ ok: false, error: "expected /v1/day/YYYY-MM-DD" }, 400);

      const version = normalizeVersion(url.searchParams.get("version"));
      const year = date.slice(0, 4);
      const artifact = await readJson<CalendarArtifact>(
        env,
        request,
        `/calendar/${slug(version)}/${year}.json`,
      );
      if (!artifact) {
        return json({ ok: false, error: `no calendar artifact for ${version} ${year}` }, 501);
      }
      const day = artifact.days[date];
      if (!day) return json({ ok: false, error: `no office for ${date} in ${version}` }, 404);

      return json({
        ok: true,
        date,
        version,
        headline: day.headline,
        colourKey: day.colourKey,
        rank: day.rank,
        rule: day.rule,
        winner: day.winner,
        commemorations: day.commemoratio ? [day.commemoratio] : [],
        scriptura: day.scriptura,
        commune: day.commune,
        titles: day.titles,
      });
    }

    const textMatch = route.match(/^\/v1\/(office|mass)\/([^/]+)(?:\/([^/]+))?$/);
    if (textMatch) {
      const date = isoDate(textMatch[2]);
      if (!date) return json({ ok: false, error: "expected a YYYY-MM-DD date" }, 400);
      return json(
        {
          ok: false,
          error: "the text assembler is not implemented yet",
          rite: textMatch[1],
          date,
          hour: textMatch[3] ?? null,
          planned: "assembled per request from the repository's own files, checked against the 2026 golden corpus",
        },
        501,
      );
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
