import { resolve } from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "hono/bun";

/**
 * Directory of the built UI, or undefined when the server should serve the API only.
 * `PIERHEAD_STATIC_DIR` wins; otherwise production serves `dist/` next to `server/`.
 */
export function loadStaticDir(env: NodeJS.ProcessEnv = process.env) {
  const explicit = env.PIERHEAD_STATIC_DIR?.trim();
  if (explicit) return resolve(explicit);
  if (env.NODE_ENV === "production") return resolve(import.meta.dir, "../dist");
  return undefined;
}

/**
 * Serves the built UI from `dir` on every route the API did not answer: files as they
 * are, any other GET falls back to `index.html` (client-side routes such as `/apps/hello`).
 * Unknown `/api/*` paths stay JSON 404s instead of falling into the UI. Vite hashes
 * everything under `/assets/`, so those are immutable; the rest must be revalidated.
 */
export function serveUi(app: Hono, dir: string) {
  const onFound = (path: string, c: { header: (name: string, value: string) => void }) =>
    c.header(
      "Cache-Control",
      path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    );

  app
    .all("/api/*", (c) =>
      c.json(
        { ok: false, error: { kind: "not-found", message: "No such route" } } as const,
        404,
      ),
    )
    .use("*", serveStatic({ root: dir, onFound }))
    .get("*", serveStatic({ root: dir, path: "index.html", onFound }));
}
