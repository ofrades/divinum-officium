import { assembleOffice, type OfficePayload } from "./office";
import { type CalendarArtifact, type CalendarIndex, normalizeVersion, slug } from "./artifact";
import { SITE_HTML } from "./site";
import type { TextSource } from "./script";

// The API surface, and the reader that uses it.
//
//   /                                 the reader (one page, no build step)
//   /v1/index.json                    versions and years the artifacts cover
//   /v1/day/<date>                    the day: headline, colour, rank, winner
//   /v1/office/<date>/<hour>          the hour, assembled from the repository
//   /v1/mass/<date>                   the Mass's selection (assembly to come)
//
// The texts are assembled per request from the repository's own files, served
// here as static assets; nothing is pre-rendered.
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

/** The repository's files, read through the asset layer. */
function assetSource(env: Env, request: Request): TextSource {
  return {
    async read(path: string) {
      const asset = new Request(new URL("/" + path, request.url).toString(), { method: "GET" });
      const response = await env.ASSETS.fetch(asset);
      if (!response.ok) return null;
      return response.text();
    },
  };
}

async function readJson<T>(env: Env, request: Request, path: string): Promise<T | null> {
  const asset = new Request(new URL(path, request.url).toString(), { method: "GET" });
  const response = await env.ASSETS.fetch(asset);
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

const HOURS = ["Matutinum", "Laudes", "Prima", "Tertia", "Sexta", "Nona", "Vesperae", "Completorium"];

function canonicalHour(value: string | undefined): string | null {
  if (!value) return null;
  const wanted = value.toLowerCase();
  return HOURS.find((hour) => hour.toLowerCase() === wanted) ?? null;
}

async function selectionFor(
  env: Env,
  request: Request,
  version: string,
  date: string,
  rite: "office" | "mass",
): Promise<CalendarArtifact["days"][string] | null> {
  const root = rite === "mass" ? "/calendar-mass" : "/calendar";
  const artifact = await readJson<CalendarArtifact>(
    env,
    request,
    `${root}/${slug(version)}/${date.slice(0, 4)}.json`,
  );
  return artifact?.days[date] ?? null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, "");

    if (route === "" || route === "/") return html(SITE_HTML);
    if (route === "/health") return json({ ok: true, api: "divinum-officium" });

    if (route === "/v1/index.json") {
      const index = await readJson<CalendarIndex>(env, request, "/calendar/index.json");
      return json({ ok: true, generatedBy: index?.generatedBy ?? null, versions: index?.versions ?? {} });
    }

    const dayMatch = route.match(/^\/v1\/day\/([^/]+)$/);
    if (dayMatch) {
      const date = isoDate(dayMatch[1]);
      if (!date) return json({ ok: false, error: "expected /v1/day/YYYY-MM-DD" }, 400);
      const version = normalizeVersion(url.searchParams.get("version"));
      const day = await selectionFor(env, request, version, date, "office");
      if (!day) return json({ ok: false, error: `no calendar for ${version} ${date}` }, 501);
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

    const officeMatch = route.match(/^\/v1\/office\/([^/]+)\/([^/]+)$/);
    if (officeMatch) {
      const date = isoDate(officeMatch[1]);
      const hour = canonicalHour(officeMatch[2]);
      if (!date || !hour) return json({ ok: false, error: "expected /v1/office/YYYY-MM-DD/<hour>" }, 400);

      const version = normalizeVersion(url.searchParams.get("version"));
      const selection = await selectionFor(env, request, version, date, "office");
      if (!selection) return json({ ok: false, error: `no calendar for ${version} ${date}` }, 501);

      const lang1 = url.searchParams.get("lang1") ?? "Latin";
      const lang2 = url.searchParams.get("lang2") ?? lang1;
      const payload: OfficePayload = await assembleOffice({
        source: assetSource(env, request),
        date,
        hour,
        version,
        lang1,
        lang2,
        selection,
      });
      return json(payload);
    }

    const massMatch = route.match(/^\/v1\/mass\/([^/]+)$/);
    if (massMatch) {
      const date = isoDate(massMatch[1]);
      if (!date) return json({ ok: false, error: "expected /v1/mass/YYYY-MM-DD" }, 400);
      const version = normalizeVersion(url.searchParams.get("version"));
      const selection = await selectionFor(env, request, version, date, "mass");
      return json(
        {
          ok: false,
          error: "the Mass assembler is not implemented yet",
          planned: "the missal's propers and Ordinary, assembled from the same repository files",
          selection,
        },
        501,
      );
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
