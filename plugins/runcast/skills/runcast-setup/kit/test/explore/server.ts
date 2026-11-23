// The made-up customers app explore's tests run against: a tiny server with
// a sign-in, a customer list, a form, a frame, a polling page and a
// redirect to another origin (an identity provider).
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const SITE = path.join(import.meta.dirname, "site");
const read = (file: string) => readFileSync(path.join(SITE, file), "utf-8");

function page(title: string, body: string): string {
  return read("layout.html").replace("{{TITLE}}", title).replace("{{BODY}}", body);
}

function form(values: { name?: string; email?: string; note?: string } = {}): string {
  return read("form.html")
    .replace("{{NAME_VALUE}}", values.name ? `value="${values.name}"` : "")
    .replace("{{EMAIL_VALUE}}", values.email ? `value="${values.email}"` : "")
    .replace("{{NOTE_VALUE}}", values.note ?? "");
}

export interface Site {
  url: string;
  /** The identity provider's origin (/sso redirects there). */
  idpUrl: string;
  /** Every request the app server saw. */
  requests: Array<{ method: string; path: string }>;
  /** Serves this HTML (inside the layout) at a path from now on. */
  set(pathname: string, title: string, body: string): void;
  /** Answers 404 at a path from now on. */
  gone(pathname: string): void;
  close(): Promise<void>;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

/** open: serve /app/* without the session cookie. */
export async function startSite(opts: { open?: boolean } = {}): Promise<Site> {
  const overrides = new Map<string, string>();
  const goneSet = new Set<string>();
  const requests: Site["requests"] = [];

  const idp = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(read("login.html"));
  });
  const idpUrl = await listen(idp);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const p = url.pathname.replace(/\/$/, "") || "/";
    requests.push({ method: request.method ?? "GET", path: `${p}${url.search}` });
    const html = (body: string, status = 200) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    };
    const signedIn = opts.open || /(^|;\s*)session=ok/.test(request.headers.cookie ?? "");

    if (request.method === "POST" && p === "/login") {
      response.writeHead(302, { location: "/app/customers", "set-cookie": "session=ok; Path=/" });
      return response.end();
    }
    if (goneSet.has(p)) return html(page("Not found", "<h1>Not found</h1>"), 404);
    if (p === "/hang") return; // never answers (a stuck tracker or image)
    if (overrides.has(p)) return html(overrides.get(p)!);
    if (p === "/login") return html(read("login.html"));
    if (p === "/logo.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      return response.end(read("logo.svg"));
    }
    if (p === "/ping") return html("ok");
    if (p === "/sso") {
      response.writeHead(302, { location: `${idpUrl}/signin` });
      return response.end();
    }
    if (p === "/") return html(page("Dashboard", read("home.html")));
    if (p === "/poll") return html(page("Live", read("poll.html")));
    if (p === "/help") return html(page("Help", "<h1>Help</h1>"));
    if (p.startsWith("/app")) {
      if (!signedIn) {
        response.writeHead(302, { location: "/login" });
        return response.end();
      }
      if (p === "/app/customers") return html(page("Customers", read("customers.html")));
      if (p === "/app/customers/new") return html(page("New customer", form()));
      if (/^\/app\/customers\/\d+\/edit$/.test(p))
        return html(
          page("Edit customer", form({ name: "Ada Lovelace", email: "ada@example.com", note: "Prefers email" })),
        );
      if (/^\/app\/customers\/\d+$/.test(p)) return html(page("Ada Lovelace", read("customer.html")));
      if (p === "/app/frame") return html(page("Embedded", read("frame.html")));
      if (p === "/app/frame-inner") return html(read("frame-inner.html"));
    }
    html(page("Not found", "<h1>Not found</h1>"), 404);
  });
  const url = await listen(server);

  return {
    url,
    idpUrl,
    requests,
    set: (pathname, title, body) => overrides.set(pathname, page(title, body)),
    gone: (pathname) => goneSet.add(pathname),
    close: async () => {
      server.closeAllConnections();
      idp.closeAllConnections();
      await Promise.all([
        new Promise((r) => server.close(r)),
        new Promise((r) => idp.close(r)),
      ]);
    },
  };
}
