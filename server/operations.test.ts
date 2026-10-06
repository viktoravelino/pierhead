import { afterEach, describe, expect, test } from "bun:test";
import multiDomain from "../shared/fixtures/multi-domain.json";
import neverDeployed from "../shared/fixtures/never-deployed.json";
import running from "../shared/fixtures/running.json";
import stopped from "../shared/fixtures/stopped.json";
import type { OperationRequest } from "../shared/operations";
import type { DokkuError, DokkuResult, DokkuRun, DokkuSteps } from "./dokku";
import {
  afterSuccess,
  preflight,
  proxyRestore,
  restoreToSave,
  runSteps,
  streamSteps,
} from "./operations";

type Report = Record<string, string>;
type Reports = Record<
  "ps" | "domains" | "ports" | "network" | "proxy" | "builder" | "git",
  Report
>;

const ok = (stdout: string): DokkuResult => ({ ok: true, stdout, stderr: "" });
const fail = (message: string): DokkuResult => ({
  ok: false,
  error: { kind: "command", message },
});

/** A host with these apps, as Dokku's reports would show them; `locked` apps hold a deploy lock. */
function fakeHost(apps: Record<string, Reports>, locked: string[] = []): DokkuRun {
  const names = Object.keys(apps);
  const reportOf = (plugin: keyof Reports, app: string | undefined) => {
    if (app === undefined) {
      return ok(names.map((n) => JSON.stringify(apps[n]?.[plugin])).join("\n"));
    }
    const reports = apps[app];
    return reports
      ? ok(JSON.stringify(reports[plugin]))
      : fail(`App ${app} does not exist`);
  };
  return async (name, ...args) => {
    const app = args.length > 0 ? String(args[0]) : undefined;
    const known = app !== undefined && app in apps;
    const plugin = name.split(":")[0];
    switch (name) {
      case "apps:list":
        return ok(JSON.stringify(names));
      case "apps:exists":
        return known ? ok("") : fail(`App ${app} does not exist`);
      case "apps:locked":
        if (!known) return fail(`App ${app} does not exist`);
        return locked.includes(app)
          ? ok("Deploy lock exists")
          : fail("Deploy lock does not exist");
      case "ps:report":
      case "domains:report":
      case "ports:report":
      case "network:report":
      case "proxy:report":
      case "builder:report":
      case "git:report":
        return reportOf(plugin as keyof Reports, app);
      default:
        return fail(`unscripted ${name}`);
    }
  };
}

const withProxy = (reports: Reports, enabled: boolean): Reports => ({
  ...reports,
  proxy: { ...reports.proxy, "proxy-enabled": String(enabled) },
});

const host = fakeHost({
  hello: running,
  "hello-multi": multiDomain,
  "hello-stopped": stopped,
  "hello-new": neverDeployed,
  "hello-noproxy": {
    ...withProxy(running, false),
    domains: { ...running.domains, "app-vhosts": "hello-noproxy.dokku.localhost" },
  },
});

const refusal = async (req: OperationRequest, h: DokkuRun = host) => {
  const result = await preflight(h, req);
  return result.ok ? null : result.refusal;
};

describe("preflight: apps:create", () => {
  test("accepts a free name", async () => {
    expect(await preflight(host, { op: "apps:create", app: "fresh" })).toEqual({
      ok: true,
      app: null,
    });
  });

  test("refuses a name that exists, and a name another app already serves as a domain", async () => {
    expect(await refusal({ op: "apps:create", app: "hello" })).toMatchObject({
      status: 409,
      kind: "exists",
    });
    expect(
      await refusal({ op: "apps:create", app: "multi.dokku.localhost" }),
    ).toMatchObject({
      status: 409,
      kind: "domain-in-use",
      message: expect.stringContaining("hello-multi"),
    });
  });

  test("a failed existence check is a 502, not a free name", async () => {
    const broken: DokkuRun = async () => ({
      ok: false,
      error: { kind: "connection", message: "ssh: connection refused" },
    });
    expect(await refusal({ op: "apps:create", app: "fresh" }, broken)).toMatchObject({
      status: 502,
      kind: "connection",
    });
  });
});

describe("preflight: existing apps", () => {
  test("an unknown app is a 404", async () => {
    expect(await refusal({ op: "ps:stop", app: "nope" })).toMatchObject({
      status: 404,
      kind: "not-found",
    });
  });

  test("an app holding Dokku's deploy lock refuses everything with 409, before any other read", async () => {
    const calls: string[] = [];
    const base = fakeHost({ hello: running }, ["hello"]);
    const spy: DokkuRun = async (name, ...args) => {
      calls.push(name);
      return base(name, ...args);
    };
    const requests: OperationRequest[] = [
      { op: "ps:restart", app: "hello" },
      { op: "apps:destroy", app: "hello", confirm: "hello" },
      { op: "domains:add", app: "hello", domains: ["x.example.com"] },
    ];
    for (const req of requests) {
      expect(await refusal(req, spy)).toMatchObject({
        status: 409,
        kind: "deploy-in-progress",
      });
    }
    expect(calls.every((name) => name === "apps:locked")).toBe(true);
  });

  test("a lock check that fails for another reason is a 502", async () => {
    const base = fakeHost({ hello: running });
    const flaky: DokkuRun = async (name, ...args) =>
      name === "apps:locked"
        ? { ok: false, error: { kind: "timeout", message: "timed out" } }
        : base(name, ...args);
    expect(await refusal({ op: "ps:stop", app: "hello" }, flaky)).toMatchObject({
      status: 502,
      kind: "timeout",
    });
  });

  test("refuses an operation the app's live state rules out, with the reason", async () => {
    expect(await refusal({ op: "ps:start", app: "hello" })).toEqual({
      status: 409,
      kind: "unavailable",
      message: "Already running.",
    });
    expect(await refusal({ op: "ps:stop", app: "hello-stopped" })).toMatchObject({
      kind: "unavailable",
      message: "Already stopped.",
    });
    expect(
      await refusal({
        op: "domains:add",
        app: "hello-noproxy",
        domains: ["x.example.com"],
      }),
    ).toMatchObject({ kind: "unavailable", message: "Enable the proxy first." });
    expect(await refusal({ op: "proxy:enable", app: "hello" })).toMatchObject({
      kind: "unavailable",
    });
  });

  test("allows what fits, and returns the live detail", async () => {
    const result = await preflight(host, { op: "ps:restart", app: "hello" });
    expect(result.ok && result.app?.name).toBe("hello");
  });
});

describe("preflight: domains and ports", () => {
  test("a domain another app serves is a 409 for add and set, the app's own is fine", async () => {
    for (const op of ["domains:add", "domains:set"] as const) {
      expect(
        await refusal({ op, app: "hello", domains: ["multi.dokku.localhost"] }),
      ).toMatchObject({
        status: 409,
        kind: "domain-in-use",
      });
      expect(
        await refusal({ op, app: "hello", domains: ["hello.dokku.localhost"] }),
      ).toBeNull();
      expect(
        await refusal({ op, app: "hello", domains: ["free.example.com"] }),
      ).toBeNull();
    }
  });

  test("removing a domain the app lacks is a 409", async () => {
    expect(
      await refusal({
        op: "domains:remove",
        app: "hello",
        domains: ["multi.dokku.localhost"],
      }),
    ).toMatchObject({ status: 409, kind: "conflict" });
    expect(
      await refusal({
        op: "domains:remove",
        app: "hello-multi",
        domains: ["multi.dokku.localhost"],
      }),
    ).toBeNull();
  });

  test("only a set port mapping can be removed, not one Dokku detected", async () => {
    const detectedOnly = fakeHost({
      hello: {
        ...running,
        ports: {
          ...running.ports,
          "ports-map": "",
          "ports-map-detected": "http:80:5000",
        },
      },
    });
    const mapping = { scheme: "http", host: 80, container: 5000 };
    expect(
      await refusal(
        { op: "ports:remove", app: "hello", mappings: [mapping] },
        detectedOnly,
      ),
    ).toMatchObject({ status: 409, kind: "conflict" });
    expect(
      await refusal({
        op: "ports:remove",
        app: "hello-multi",
        mappings: [{ scheme: "http", host: 8081, container: 80 }],
      }),
    ).toBeNull();
    expect(
      await refusal({
        op: "ports:remove",
        app: "hello-multi",
        mappings: [{ scheme: "http", host: 9999, container: 80 }],
      }),
    ).toMatchObject({ kind: "conflict" });
  });
});

describe("what a proxy:disable remembers", () => {
  afterEach(() => proxyRestore.clear());

  const detailOf = async (reports: Reports, app: string) => {
    const result = await preflight(fakeHost({ [app]: reports }), {
      op: "proxy:disable",
      app,
    });
    if (!result.ok || !result.app) throw new Error("preflight refused");
    return result.app;
  };
  const disable = (app: string): OperationRequest => ({ op: "proxy:disable", app });

  test("saves the set ports and the custom domains", async () => {
    const app = await detailOf(multiDomain, "hello-multi");
    expect(restoreToSave(disable("hello-multi"), app)).toEqual({
      ports: [{ scheme: "http", host: 8081, container: 80 }],
      domains: ["hello-multi.dokku.localhost", "multi.dokku.localhost"],
    });
  });

  test("saves nothing when only the default domain and a detected map would be lost", async () => {
    const reports = {
      ...running,
      ports: { ...running.ports, "ports-map": "", "ports-map-detected": "http:80:5000" },
    };
    const app = await detailOf(reports, "hello");
    expect(app.ports.every((p) => p.detected)).toBe(true);
    expect(restoreToSave(disable("hello"), app)).toBeNull();
  });

  test("only a proxy:disable saves anything", async () => {
    const app = await detailOf(multiDomain, "hello-multi");
    expect(restoreToSave({ op: "proxy:enable", app: "hello-multi" }, app)).toBeNull();
    expect(restoreToSave(disable("hello-multi"), null)).toBeNull();
  });

  const saved = { ports: [{ scheme: "http", host: 80, container: 80 }], domains: [] };

  test("a successful disable stores it, and a disable with nothing to save drops a stale entry", () => {
    afterSuccess(disable("hello"), saved);
    expect(proxyRestore.get("hello")).toEqual(saved);
    afterSuccess(disable("hello"), null);
    expect(proxyRestore.has("hello")).toBe(false);
  });

  test("enable, create and destroy clear the entry; other operations leave it", () => {
    const clearing: OperationRequest[] = [
      { op: "proxy:enable", app: "hello" },
      { op: "apps:create", app: "hello" },
      { op: "apps:destroy", app: "hello", confirm: "hello" },
    ];
    for (const req of clearing) {
      proxyRestore.set("hello", saved);
      afterSuccess(req, null);
      expect(proxyRestore.has("hello")).toBe(false);
    }
    proxyRestore.set("hello", saved);
    afterSuccess({ op: "ps:restart", app: "hello" }, null);
    expect(proxyRestore.has("hello")).toBe(true);
  });
});

const boom: DokkuError = { kind: "command", message: "step two failed" };

/** Steps that succeed except `failing`; records which ones ran. */
function fakeSteps(failing: string, ran: string[]): DokkuSteps {
  return {
    step: async (argv) => {
      const name = argv[0] ?? "";
      ran.push(name);
      return name === failing ? { ok: false, error: boom } : ok(`${name} done`);
    },
    streamStep: (argv) => {
      const name = argv[0] ?? "";
      ran.push(name);
      return {
        ok: true,
        lines: (async function* () {
          yield `${name} line`;
        })(),
        exit: Promise.resolve(name === failing ? boom : null),
        kill: () => {},
      };
    },
  };
}

const steps = [
  ["proxy:enable", "hello"],
  ["ports:set", "hello", "http:80:80"],
  ["domains:set", "hello", "a.com"],
];

describe("running steps", () => {
  test("runSteps runs them in order and combines their output", async () => {
    const ran: string[] = [];
    const result = await runSteps(fakeSteps("none", ran), steps);
    expect(ran).toEqual(["proxy:enable", "ports:set", "domains:set"]);
    expect(result).toEqual({
      ok: true,
      output: "proxy:enable done\nports:set done\ndomains:set done",
    });
  });

  test("runSteps stops at the first failed step", async () => {
    const ran: string[] = [];
    const result = await runSteps(fakeSteps("ports:set", ran), steps);
    expect(ran).toEqual(["proxy:enable", "ports:set"]);
    expect(result).toEqual({ ok: false, error: boom });
  });

  test("streamSteps passes lines on and stops at the first failed step", async () => {
    const ran: string[] = [];
    const lines: string[] = [];
    const error = await streamSteps(fakeSteps("ports:set", ran), steps, async (line) => {
      lines.push(line);
    });
    expect(ran).toEqual(["proxy:enable", "ports:set"]);
    expect(lines).toEqual(["proxy:enable line", "ports:set line"]);
    expect(error).toEqual(boom);
  });

  test("streamSteps resolves null when every step ended well", async () => {
    const ran: string[] = [];
    expect(await streamSteps(fakeSteps("none", ran), steps, async () => {})).toBeNull();
    expect(ran).toHaveLength(3);
  });

  test("a step that cannot start is the failure, and nothing after it runs", async () => {
    const ran: string[] = [];
    const base = fakeSteps("none", ran);
    const refusing: DokkuSteps = {
      ...base,
      streamStep: (argv) => {
        ran.push(argv[0] ?? "");
        return { ok: false, error: boom };
      },
    };
    expect(await streamSteps(refusing, steps, async () => {})).toEqual(boom);
    expect(ran).toEqual(["proxy:enable"]);
  });
});
