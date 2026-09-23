import { Container } from "@cloudflare/containers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

// The container-backed Durable Object. The image is upstream's own engine
// (Starman serving Pofficium.pl and missa.pl on 8080); this class is only the
// handle the Worker uses to reach one running instance.
export class Engine extends Container {
  defaultPort = 8080;
  // Keep a warm instance for a few minutes after the last request: praying the
  // office comes in bursts, and a cold engine pays Starman's startup again.
  sleepAfter = "10m";
}

// The two CGI entry points the API exposes, and nothing else: the door never
// becomes a general proxy into the container.
const ALLOWED = [/^\/cgi-bin\/horas\/Pofficium\.pl$/, /^\/cgi-bin\/missa\/missa\.pl$/];

// The binding the stack installs under `env.Engine`; typed here rather than
// inferred from the stack so this file stays readable on its own.
interface Env {
  Engine: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Divinum Officium API\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method !== "GET" || !ALLOWED.some((pattern) => pattern.test(url.pathname))) {
      return new Response("not found\n", { status: 404 });
    }

    const engine = env.Engine.getByName("engine");
    const upstream = await engine.fetch(new URL(url.pathname + url.search, "http://engine"));

    // A past day never changes; today's office is stable for hours. Access has
    // already established who is calling, so the cache stays private.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8",
        "cache-control": "private, max-age=300",
      },
    });
  },
};
