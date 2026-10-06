import { describe, expect, test } from "bun:test";
import type { AppDetail } from "../shared/types";
import type { DokkuResult, DokkuRun } from "./dokku";
import { buildStep, knownServiceTypes } from "./dokku";
import { getService, listServices, withServices } from "./services";

const fixture = (name: string) =>
  Bun.file(new URL(`../shared/fixtures/${name}`, import.meta.url)).text();

const ok = (stdout: string): DokkuResult => ({ ok: true, stdout, stderr: "" });

/** A host with the postgres and redis plugins, answering from captured output. */
async function host(
  patch: Partial<Record<"postgres" | "redis", DokkuResult>> = {},
): Promise<DokkuRun> {
  const postgres = ok((await fixture("postgres-info-all.ndjson")).trim());
  const redis = ok((await fixture("redis-info-all.ndjson")).trim());
  const plugins = ok(await fixture("plugin-list-services.json"));
  return async (name, ...args) => {
    if (name === "plugin:list") return plugins;
    if (name !== "service:info") throw new Error(`unscripted ${name}`);
    const [type, service] = args;
    const all =
      type === "postgres" ? (patch.postgres ?? postgres) : (patch.redis ?? redis);
    if (!all.ok || service === undefined) return all;
    const line = all.stdout.split("\n").find((l) => l.includes(`"service":"${service}"`));
    return line
      ? ok(line)
      : {
          ok: false,
          error: { kind: "command", message: `service ${service} does not exist` },
        };
  };
}

describe("listServices", () => {
  test("groups the services by installed plugin, one info call each", async () => {
    const result = await listServices(await host());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.map((g) => [g.type, g.pluginVersion, g.services.map((s) => s.name)]),
    ).toEqual([
      ["postgres", "2.2.0", ["pr5-p1", "pr5-p2"]],
      ["redis", "2.2.0", ["pr5-rprobe"]],
    ]);
  });

  test("teaches the runner which types are installed", async () => {
    knownServiceTypes.replace([]);
    await listServices(await host());
    // `buildStep` would refuse these before the read above.
    expect(buildStep(["redis:start", "x"]).ok).toBe(true);
    expect(buildStep(["nginx:start", "x"]).ok).toBe(false);
    knownServiceTypes.replace([]);
  });

  test("a plugin that fails keeps its group with the reason and does not fail the others", async () => {
    const broken = await host({
      redis: { ok: false, error: { kind: "command", message: "redis is broken" } },
    });
    const result = await listServices(broken);
    if (!result.ok) throw new Error("expected a result");
    const redis = result.value.find((g) => g.type === "redis");
    expect(redis).toEqual({
      type: "redis",
      pluginVersion: "2.2.0",
      services: [],
      error: "redis is broken",
    });
    expect(result.value.find((g) => g.type === "postgres")?.services).toHaveLength(2);
  });

  test("no service plugin installed is an empty list, not an error", async () => {
    const bare: DokkuRun = async () => ok("[]");
    expect(await listServices(bare)).toEqual({ ok: true, value: [] });
  });

  test("a failed plugin list fails the read", async () => {
    const down: DokkuRun = async () => ({
      ok: false,
      error: { kind: "connection", message: "refused" },
    });
    expect(await listServices(down)).toMatchObject({ ok: false });
  });

  test("no connection string with a password is in the list or in a detail", async () => {
    const h = await host();
    const list = await listServices(h);
    const one = await getService(h, "postgres", "pr5-p1");
    const none = await getService(h, "postgres", "nope");
    expect(none).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("does not exist") },
    });
    for (const body of [list, one]) {
      const json = JSON.stringify(body);
      expect(json).not.toContain("fixturepassword");
      expect(json).toContain("********");
    }
  });
});

describe("withServices", () => {
  const detail = (name: string, partial?: string[]): AppDetail =>
    ({ name, services: [], ...(partial ? { partial } : {}) }) as unknown as AppDetail;

  test("lists the services linked to the app, from the batched read", async () => {
    const groups = await listServices(await host());
    expect(withServices(detail("hello-new"), groups).services).toEqual([
      { type: "postgres", name: "pr5-p1" },
      { type: "postgres", name: "pr5-p2" },
      { type: "redis", name: "pr5-rprobe" },
    ]);
    expect(withServices(detail("hello-stopped"), groups).services).toEqual([
      { type: "postgres", name: "pr5-p1" },
    ]);
    expect(withServices(detail("hello"), groups)).toEqual(detail("hello"));
  });

  test("a read that failed, wholly or for one plugin, is noted as partial", async () => {
    const failed = { ok: false, error: { kind: "command", message: "x" } } as const;
    expect(withServices(detail("hello"), failed)).toMatchObject({
      services: [],
      partial: ["services"],
    });
    const one = await listServices(
      await host({ redis: { ok: false, error: { kind: "command", message: "x" } } }),
    );
    expect(withServices(detail("hello-stopped", ["formation"]), one)).toMatchObject({
      services: [{ type: "postgres", name: "pr5-p1" }],
      partial: ["formation", "services"],
    });
  });
});
