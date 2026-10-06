import { beforeEach, describe, expect, test } from "bun:test";
import dockerOptions from "../shared/fixtures/docker-options-report.json";
import multiDomain from "../shared/fixtures/multi-domain.json";
import networkAttached from "../shared/fixtures/network-report-attached.json";
import networkMulti from "../shared/fixtures/network-report-multi.json";
import neverDeployed from "../shared/fixtures/never-deployed.json";
import running from "../shared/fixtures/running.json";
import stopped from "../shared/fixtures/stopped.json";
import storageList from "../shared/fixtures/storage-list.json";
import type { OperationRequest } from "../shared/operations";
import type { DokkuError, DokkuResult, DokkuRun, DokkuSteps } from "./dokku";
import {
  afterSuccess,
  failureRefusal,
  failureText,
  preflight,
  restoreToSave,
  runSteps,
  settleRename,
  streamSteps,
} from "./operations";
import { createStateStore } from "./state";

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

/** What the detail reads besides the reports above, as the commands print it. */
type Extras = { scale: string; storage: string; resource: Report; dockerOptions: string };

const noExtras: Extras = {
  scale: '[{"process_type":"web","quantity":1}]',
  storage: "[]",
  resource: {},
  dockerOptions: '{"deploy-list":[]}',
};

type HostOptions = {
  /** Apps holding a deploy lock. */
  locked?: string[];
  extras?: Record<string, Partial<Extras>>;
  /** What `builds:list <app> --format json` prints, per app; `[]` otherwise. */
  builds?: Record<string, unknown[]>;
  /** The global deploy branch; unset (empty) otherwise. */
  globalBranch?: string;
};

/** `network:list` entries: a Dokku-managed network or one Docker keeps for itself. */
const dockerNetworks = [
  { Name: "bridge", DokkuManaged: false },
  { Name: "hello-net", DokkuManaged: true },
  { Name: "pr2-probe-net", DokkuManaged: true },
  { Name: "spare-net", DokkuManaged: true },
].map((n) => ({ ...n, Driver: "bridge", Scope: "local", Internal: false }));

/** A host with these apps, as Dokku's reports would show them. */
function fakeHost(
  apps: Record<string, Reports>,
  { locked = [], extras = {}, builds = {}, globalBranch = "" }: HostOptions = {},
): DokkuRun {
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
  const extra = (app: string): Extras => ({ ...noExtras, ...extras[app] });
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
      case "builds:list":
        return known
          ? ok(JSON.stringify(builds[app] ?? []))
          : fail(`App ${app} does not exist`);
      case "network:list":
        return ok(JSON.stringify(dockerNetworks));
      case "git:report:global":
        return ok(JSON.stringify({ "global-deploy-branch": globalBranch }));
      case "domains:report:global":
        return ok(
          JSON.stringify({
            "global-enabled": "true",
            "global-vhosts": "dokku.localhost lab.local",
          }),
        );
      case "ps:scale":
      case "storage:list":
      case "docker-options:report":
        if (!known) return fail(`App ${app} does not exist`);
        return ok(
          name === "ps:scale"
            ? extra(app).scale
            : name === "storage:list"
              ? extra(app).storage
              : extra(app).dockerOptions,
        );
      case "resource:report":
        return known
          ? ok(JSON.stringify(extra(app).resource))
          : fail(`App ${app} does not exist`);
      case "builder-dockerfile:report":
        return known ? ok("{}") : fail(`App ${app} does not exist`);
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

const host = fakeHost(
  {
    hello: running,
    "hello-multi": multiDomain,
    "hello-stopped": stopped,
    "hello-new": neverDeployed,
    "hello-noproxy": {
      ...withProxy(running, false),
      domains: { ...running.domains, "app-vhosts": "hello-noproxy.dokku.localhost" },
    },
    // Two networks in one setting (comma-joined by Dokku): pr2-probe-net and hello-net.
    "hello-two-nets": {
      ...running,
      network: networkMulti,
      domains: { ...running.domains, "app-vhosts": "hello-two-nets.dokku.localhost" },
    },
    // Attached to pr2-probe-net (initial, post-create) and hello-net (post-deploy).
    "hello-attached": {
      ...running,
      network: networkAttached,
      domains: { ...running.domains, "app-vhosts": "hello-attached.dokku.localhost" },
    },
  },
  {
    extras: {
      hello: {
        storage: JSON.stringify(storageList),
        dockerOptions: JSON.stringify(dockerOptions),
      },
    },
  },
);

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
    const base = fakeHost({ hello: running }, { locked: ["hello"] });
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

  test("the refusal points at the Settings tab's way out", async () => {
    const held = fakeHost({ hello: running }, { locked: ["hello"] });
    expect(await refusal({ op: "ps:restart", app: "hello" }, held)).toMatchObject({
      message: expect.stringContaining("Release lock"),
    });
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
  let store = createStateStore(null);
  beforeEach(() => {
    store = createStateStore(null);
  });

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
    afterSuccess(store, disable("hello"), saved);
    expect(store.restoreOf("hello")).toEqual(saved);
    afterSuccess(store, disable("hello"), null);
    expect(store.restoreOf("hello")).toBeUndefined();
  });

  // The host as it is once Dokku has destroyed the old app: only `survivors` exist.
  const hostWith =
    (survivors: string[]): DokkuRun =>
    async (name, ...args) =>
      name === "apps:exists"
        ? survivors.includes(String(args[0]))
          ? ok("")
          : fail(`App ${String(args[0])} does not exist`)
        : host(name, ...args);
  const renameReq = {
    op: "apps:rename",
    app: "hello",
    newName: "hello-2",
    skipDeploy: false,
    confirm: "hello",
  } as const;

  test("a rename hands the entry to the new name, replacing a stale one there, with the old default vhost swapped for every global domain", async () => {
    store.saveRestore("hello", {
      ports: saved.ports,
      domains: [
        "hello.dokku.localhost",
        "hello.lab.local",
        "a.example.com",
        "hello.example.com",
      ],
    });
    store.saveRestore("hello-2", { ports: [], domains: ["stale.example.com"] });
    await settleRename(hostWith(["hello-2"]), store, renameReq);
    expect(store.restoreOf("hello")).toBeUndefined();
    expect(store.restoreOf("hello-2")).toEqual({
      ports: saved.ports,
      domains: [
        "hello-2.dokku.localhost",
        "hello-2.lab.local",
        "a.example.com",
        "hello.example.com",
      ],
    });
  });

  test("it moves whatever the rename's outcome, since the old app is gone even when its redeploy failed", async () => {
    // The caller runs it after success and failure alike; all it looks at is the old app.
    store.saveRestore("hello", saved);
    await settleRename(hostWith([]), store, renameReq);
    expect(store.restoreOf("hello-2")).toEqual(saved);
  });

  test("while the old app still exists nothing moves, and neither does anything when the check fails", async () => {
    store.saveRestore("hello", saved);
    await settleRename(hostWith(["hello"]), store, renameReq);
    expect(store.restoreOf("hello")).toEqual(saved);
    expect(store.restoreOf("hello-2")).toBeUndefined();
    const broken: DokkuRun = async () => fail("ssh: connection refused");
    await settleRename(broken, store, renameReq);
    expect(store.restoreOf("hello")).toEqual(saved);
  });

  test("a rename of an app with no entry still drops a stale one under the new name", async () => {
    store.saveRestore("hello-2", saved);
    await settleRename(hostWith(["hello-2"]), store, renameReq);
    expect(store.restoreOf("hello-2")).toBeUndefined();
  });

  test("other operations are left alone by settleRename", async () => {
    store.saveRestore("hello", saved);
    await settleRename(hostWith([]), store, { op: "ps:restart", app: "hello" });
    expect(store.restoreOf("hello")).toEqual(saved);
  });

  test("a clone keeps the source's entry and gives the copy none", () => {
    store.saveRestore("hello", saved);
    store.saveRestore("hello-copy", saved);
    afterSuccess(
      store,
      { op: "apps:clone", app: "hello", newName: "hello-copy", skipDeploy: true },
      null,
    );
    expect(store.restoreOf("hello")).toEqual(saved);
    expect(store.restoreOf("hello-copy")).toBeUndefined();
  });

  test("enable, create and destroy clear the entry; other operations leave it", () => {
    const clearing: OperationRequest[] = [
      { op: "proxy:enable", app: "hello" },
      { op: "apps:create", app: "hello" },
      { op: "apps:destroy", app: "hello", confirm: "hello" },
    ];
    for (const req of clearing) {
      store.saveRestore("hello", saved);
      afterSuccess(store, req, null);
      expect(store.restoreOf("hello")).toBeUndefined();
    }
    store.saveRestore("hello", saved);
    afterSuccess(store, { op: "ps:restart", app: "hello" }, null);
    expect(store.restoreOf("hello")).toEqual(saved);
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

describe("preflight: networks", () => {
  test("create refuses a name that exists", async () => {
    expect(await refusal({ op: "network:create", network: "hello-net" })).toMatchObject({
      status: 409,
      kind: "exists",
    });
    expect(await preflight(host, { op: "network:create", network: "fresh-net" })).toEqual(
      { ok: true, app: null },
    );
  });

  test("destroy refuses a network any app's initial, post-create or post-deploy setting names", async () => {
    // hello-attached: initial and post-create pr2-probe-net, post-deploy hello-net.
    for (const network of ["pr2-probe-net", "hello-net"]) {
      expect(
        await refusal({ op: "network:destroy", network, confirm: network }),
      ).toMatchObject({
        status: 409,
        kind: "in-use",
        message: expect.stringContaining("hello-attached"),
      });
    }
  });

  test("destroy refuses a network that is one of several in an app's setting", async () => {
    // hello-two-nets lists "pr2-probe-net,hello-net" for attach-post-create; both are in use.
    const result = await refusal({
      op: "network:destroy",
      network: "hello-net",
      confirm: "hello-net",
    });
    expect(result).toMatchObject({ status: 409, kind: "in-use" });
    expect(result?.message).toContain("hello-two-nets");
  });

  test("set sees a network that shares a comma-joined setting", async () => {
    expect(
      await refusal({
        op: "network:set",
        app: "hello-two-nets",
        property: "attach-post-deploy",
        networks: ["hello-net"],
        rebuild: false,
      }),
    ).toMatchObject({ kind: "conflict" });
  });

  test("destroy allows an unused Dokku network, and refuses a missing or foreign one", async () => {
    const destroy = (network: string): OperationRequest => ({
      op: "network:destroy",
      network,
      confirm: network,
    });
    expect(await refusal(destroy("spare-net"))).toBeNull();
    expect(await refusal(destroy("nope"))).toMatchObject({
      status: 404,
      kind: "not-found",
    });
    expect(await refusal(destroy("bridge"))).toMatchObject({
      status: 409,
      kind: "unmanaged",
    });
  });

  test("set refuses a network that does not exist, clearing needs none", async () => {
    const set = (networks: string[]): OperationRequest => ({
      op: "network:set",
      app: "hello",
      property: "initial-network",
      networks,
      rebuild: false,
    });
    expect(await refusal(set(["ghost-net"]))).toMatchObject({
      status: 409,
      kind: "unknown-network",
    });
    expect(await refusal(set(["spare-net"]))).toBeNull();
    expect(await refusal(set([]))).toBeNull();
  });

  test("set refuses a network already attached through the other attach setting", async () => {
    const set = (property: "attach-post-create" | "attach-post-deploy", net: string) =>
      refusal({
        op: "network:set",
        app: "hello-attached",
        property,
        networks: [net],
        rebuild: false,
      });
    // post-create holds pr2-probe-net and post-deploy holds hello-net.
    expect(await set("attach-post-deploy", "pr2-probe-net")).toMatchObject({
      kind: "conflict",
    });
    expect(await set("attach-post-create", "hello-net")).toMatchObject({
      kind: "conflict",
    });
    expect(await set("attach-post-create", "spare-net")).toBeNull();
  });

  test("a rebuild is refused for an app that has no code to rebuild", async () => {
    const req: OperationRequest = {
      op: "network:set",
      app: "hello-new",
      property: "initial-network",
      networks: ["spare-net"],
      rebuild: true,
    };
    expect(await refusal(req)).toMatchObject({
      status: 409,
      kind: "unavailable",
      message: expect.stringContaining("No code has been pushed"),
    });
    expect(await refusal({ ...req, rebuild: false })).toBeNull();
  });

  test("aliases: adding one the app has and removing one it lacks are 409s", async () => {
    const alias = (op: "network:alias-add" | "network:alias-remove", name: string) =>
      refusal({ op, app: "hello", alias: name, rebuild: false });
    expect(await alias("network:alias-add", "pr2alias")).toMatchObject({
      kind: "conflict",
    });
    expect(await alias("network:alias-add", "fresh")).toBeNull();
    expect(await alias("network:alias-remove", "pr2alias")).toBeNull();
    expect(await alias("network:alias-remove", "ghost")).toMatchObject({
      kind: "conflict",
    });
  });
});

describe("preflight: scale and storage", () => {
  test("scale needs a deployed app", async () => {
    const scale = (app: string) =>
      refusal({
        op: "ps:scale",
        app,
        formation: [{ type: "web", count: 2 }],
        skipDeploy: false,
      });
    expect(await scale("hello-new")).toMatchObject({ status: 409, kind: "unavailable" });
    expect(await scale("hello")).toBeNull();
  });

  test("scale respects a ps report that says the app cannot be scaled", async () => {
    const locked = fakeHost({
      hello: { ...running, ps: { ...running.ps, "can-scale": "false" } },
    });
    expect(
      await refusal(
        {
          op: "ps:scale",
          app: "hello",
          formation: [{ type: "web", count: 2 }],
          skipDeploy: true,
        },
        locked,
      ),
    ).toMatchObject({ kind: "unavailable" });
  });

  test("a mount at a container path the app already uses is a 409", async () => {
    const mount = (containerPath: string) =>
      refusal({ op: "storage:mount", app: "hello", name: "pr2-data", containerPath });
    expect(await mount("/data")).toMatchObject({ status: 409, kind: "conflict" });
    expect(await mount("/fresh")).toBeNull();
  });

  test("unmount only touches a mount under the storage root, at the exact path", async () => {
    const unmount = (name: string, containerPath: string) =>
      refusal({
        op: "storage:unmount",
        app: "hello",
        name,
        containerPath,
        confirm: containerPath,
      });
    expect(await unmount("pr2-probe-data", "/data")).toBeNull();
    // Wrong path, wrong directory, and the mount outside the root (/opt/host-elsewhere:/other).
    expect(await unmount("pr2-probe-data", "/nowhere")).toMatchObject({
      kind: "conflict",
    });
    expect(await unmount("other-dir", "/data")).toMatchObject({ kind: "conflict" });
    expect(await unmount("host-elsewhere", "/other")).toMatchObject({
      kind: "conflict",
    });
  });
});

describe("when settings reads fail", () => {
  const flaky = (failing: string): DokkuRun => {
    const base = fakeHost({ hello: running });
    return async (name, ...args) =>
      name === failing
        ? { ok: false, error: { kind: "command", message: "boom" } }
        : base(name, ...args);
  };

  test("the detail still loads and names what is missing", async () => {
    const result = await preflight(flaky("storage:list"), {
      op: "ps:restart",
      app: "hello",
    });
    expect(result.ok && result.app?.partial).toEqual(["storage"]);
  });

  test("a malformed settings answer is partial too, not a failed detail", async () => {
    const base = fakeHost({ hello: running });
    const garbled: DokkuRun = async (name, ...args) =>
      name === "ps:scale"
        ? { ok: true, stdout: "not json", stderr: "" }
        : base(name, ...args);
    const result = await preflight(garbled, { op: "ps:stop", app: "hello" });
    expect(result.ok && result.app?.partial).toEqual(["formation"]);
  });

  test("start, stop and the like go ahead; operations that compare with the lost data do not", async () => {
    const broken = flaky("storage:list");
    expect(await refusal({ op: "ps:restart", app: "hello" }, broken)).toBeNull();
    expect(
      await refusal(
        { op: "storage:mount", app: "hello", name: "data", containerPath: "/data" },
        broken,
      ),
    ).toMatchObject({ status: 502, kind: "partial-read" });
    expect(
      await refusal(
        { op: "network:alias-add", app: "hello", alias: "x", rebuild: false },
        flaky("docker-options:report"),
      ),
    ).toMatchObject({ status: 502, kind: "partial-read" });
  });

  test("a required report failing still fails the read", async () => {
    expect(
      await refusal({ op: "ps:restart", app: "hello" }, flaky("ps:report")),
    ).toMatchObject({ status: 502 });
  });
});

describe("failureRefusal", () => {
  const active: DokkuError = {
    kind: "command",
    message: "Unable to destroy network: network x has active endpoints (name:...)",
  };

  test("Docker's active-endpoints failure on a network destroy is a 409 in-use", () => {
    const req: OperationRequest = { op: "network:destroy", network: "x", confirm: "x" };
    expect(failureRefusal(req, active)).toMatchObject({ status: 409, kind: "in-use" });
    expect(failureRefusal(req, active)?.message).toContain("rebuilt");
  });

  test("other failures, and other operations, are left alone", () => {
    expect(
      failureRefusal({ op: "network:destroy", network: "x", confirm: "x" }, boom),
    ).toBeNull();
    expect(failureRefusal({ op: "ps:stop", app: "hello" }, active)).toBeNull();
  });
});

describe("preflight: apps:unlock", () => {
  const unlock: OperationRequest = { op: "apps:unlock", app: "hello" };
  const record = (status: string, display: string) => ({
    id: "muwb3gxtjejsh3",
    app: "hello",
    kind: "build",
    started_at: "2026-10-06T06:37:15.543610715Z",
    status,
    source: "git:sync",
    display_status: display,
  });

  test("goes ahead when the lock is held and nothing is running", async () => {
    const h = fakeHost({ hello: running }, { locked: ["hello"], builds: { hello: [] } });
    expect(await preflight(h, unlock)).toEqual({ ok: true, app: null });
  });

  test("a build that died (status running, display abandoned) does not block it", async () => {
    const h = fakeHost(
      { hello: running },
      { locked: ["hello"], builds: { hello: [record("running", "abandoned")] } },
    );
    expect((await preflight(h, unlock)).ok).toBe(true);
  });

  test("a build record that is really running refuses with 409 build-running", async () => {
    const h = fakeHost(
      { hello: running },
      { locked: ["hello"], builds: { hello: [record("running", "running")] } },
    );
    expect(await refusal(unlock, h)).toMatchObject({
      status: 409,
      kind: "build-running",
    });
  });

  test("no lock held is a 409, an unknown app a 404", async () => {
    const free = fakeHost({ hello: running });
    expect(await refusal(unlock, free)).toMatchObject({
      status: 409,
      kind: "unavailable",
    });
    expect(await refusal({ op: "apps:unlock", app: "nosuch" }, free)).toMatchObject({
      status: 404,
    });
  });
});

describe("preflight: rename and clone", () => {
  const rename = (newName: string, app = "hello"): OperationRequest => ({
    op: "apps:rename",
    app,
    newName,
    skipDeploy: false,
    confirm: app,
  });
  const clone = (newName: string, app = "hello"): OperationRequest => ({
    op: "apps:clone",
    app,
    newName,
    skipDeploy: true,
  });

  test("a free name goes ahead and returns the source's live detail", async () => {
    for (const req of [rename("fresh"), clone("fresh")]) {
      const result = await preflight(host, req);
      expect(result.ok && result.app?.name).toBe("hello");
    }
  });

  test("a name that exists is a 409 for both", async () => {
    for (const req of [rename("hello-multi"), clone("hello-multi")]) {
      expect(await refusal(req)).toMatchObject({ status: 409, kind: "exists" });
    }
  });

  test("a name another app serves as a domain is a 409 for both", async () => {
    for (const req of [rename("multi.dokku.localhost"), clone("multi.dokku.localhost")]) {
      expect(await refusal(req)).toMatchObject({
        status: 409,
        kind: "domain-in-use",
        message: expect.stringContaining("hello-multi"),
      });
    }
  });

  test("a rename may take one of the app's own custom domains as its name; a clone may not", async () => {
    expect(await refusal(rename("multi.dokku.localhost", "hello-multi"))).toBeNull();
    expect(await refusal(clone("multi.dokku.localhost", "hello-multi"))).toMatchObject({
      status: 409,
      kind: "domain-in-use",
    });
  });

  test("an unknown source is a 404, before the target is looked at", async () => {
    expect(await refusal(rename("fresh", "nope"))).toMatchObject({
      status: 404,
      kind: "not-found",
    });
    expect(await refusal(clone("hello-multi", "nope"))).toMatchObject({ status: 404 });
  });

  test("a source holding the deploy lock is refused", async () => {
    const locked = fakeHost({ hello: running }, { locked: ["hello"] });
    expect(await refusal(rename("fresh"), locked)).toMatchObject({
      status: 409,
      kind: "deploy-in-progress",
    });
    expect(await refusal(clone("fresh"), locked)).toMatchObject({ status: 409 });
  });

  test("a never-deployed or stopped source is fine", async () => {
    for (const app of ["hello-new", "hello-stopped"]) {
      expect(await refusal(rename("fresh", app))).toBeNull();
      expect(await refusal(clone("fresh", app))).toBeNull();
    }
  });

  test("a failed existence check is a 502, not a free name", async () => {
    const broken: DokkuRun = async (name, ...args) =>
      name === "apps:exists" && args[0] === "fresh"
        ? { ok: false, error: { kind: "connection", message: "ssh: connection refused" } }
        : host(name, ...args);
    expect(await refusal(clone("fresh"), broken)).toMatchObject({
      status: 502,
      kind: "connection",
    });
  });
});

describe("preflight: global settings", () => {
  const globalOp = (
    op: "domains:add-global" | "domains:remove-global" | "domains:set-global",
    domains: string[],
  ): OperationRequest => ({ op, domains });

  test("they read no app, so a held deploy lock does not matter", async () => {
    const locked = fakeHost({ hello: running }, { locked: ["hello"] });
    for (const req of [
      globalOp("domains:add-global", ["new.local"]),
      globalOp("domains:remove-global", ["lab.local"]),
      globalOp("domains:set-global", ["only.local"]),
      { op: "git:set-global", branch: "main" } satisfies OperationRequest,
    ]) {
      expect(await preflight(locked, req)).toEqual({ ok: true, app: null });
    }
  });

  test("setting the global deploy branch to what it is, or clearing an unset one, is a 409", async () => {
    const set = fakeHost({ hello: running }, { globalBranch: "main" });
    const branch = (b: string): OperationRequest => ({ op: "git:set-global", branch: b });
    expect(await refusal(branch("main"), set)).toMatchObject({
      status: 409,
      kind: "conflict",
    });
    expect(await refusal(branch("release"), set)).toBeNull();
    expect(await refusal(branch(""), set)).toBeNull();
    expect(await refusal(branch(""))).toMatchObject({ status: 409, kind: "conflict" });
    expect(await refusal(branch("main"))).toBeNull();
  });

  test("adding only domains that are there is a 409; one new among them is fine", async () => {
    expect(
      await refusal(globalOp("domains:add-global", ["lab.local", "dokku.localhost"])),
    ).toMatchObject({ status: 409, kind: "conflict" });
    expect(
      await refusal(globalOp("domains:add-global", ["lab.local", "new.local"])),
    ).toBeNull();
  });

  test("removing a domain that is not global is a 409", async () => {
    expect(
      await refusal(globalOp("domains:remove-global", ["nope.local"])),
    ).toMatchObject({
      status: 409,
      kind: "conflict",
      message: expect.stringContaining("nope.local"),
    });
  });

  test("setting the list it already is, in any order, is a 409", async () => {
    expect(
      await refusal(globalOp("domains:set-global", ["lab.local", "dokku.localhost"])),
    ).toMatchObject({ status: 409 });
    expect(await refusal(globalOp("domains:set-global", ["lab.local"]))).toBeNull();
  });

  test("a failed read of the global domains is a 502", async () => {
    const broken: DokkuRun = async () => ({
      ok: false,
      error: { kind: "timeout", message: "timed out" },
    });
    expect(
      await refusal(globalOp("domains:add-global", ["new.local"]), broken),
    ).toMatchObject({ status: 502, kind: "timeout" });
  });
});

/** A host that also runs service plugins: what `plugin:list` and `<type>:info` would print. */
type ServiceFixture = { status?: string; links?: string[] };

function serviceHost(
  base: DokkuRun,
  services: Record<string, Record<string, ServiceFixture>>,
  // Plugins that take `--image-version` on create.
  { versioned = ["postgres", "redis"] }: { versioned?: string[] } = {},
): DokkuRun {
  const plugin = (name: string, description: string, core = false) => ({
    name,
    version: "2.2.0",
    enabled: true,
    core,
    description,
  });
  return async (name, ...args) => {
    const [type = "", service] = args.map(String);
    switch (name) {
      case "plugin:list":
        return ok(
          JSON.stringify([
            plugin("apps", "dokku core apps plugin", true),
            ...Object.keys(services).map((t) => plugin(t, `dokku ${t} service plugin`)),
          ]),
        );
      case "service:info": {
        const fixtures = services[type] ?? {};
        if (service === undefined) return ok(JSON.stringify({ message: "none" }));
        const found = fixtures[service];
        if (!found) return fail(`service ${service} does not exist`);
        return ok(
          JSON.stringify({
            service,
            status: found.status ?? "running",
            links: (found.links ?? []).join(","),
            dsn: "postgres://postgres:secretpw@dokku-postgres-x:5432/x",
          }),
        );
      }
      case "service:create-help":
        return ok(
          versioned.includes(type) ? "-I|--image-version <string>" : "-i|--image",
        );
      default:
        return base(name, ...args);
    }
  };
}

const withServices = serviceHost(host, {
  postgres: {
    "hello-db": { links: ["hello-multi"] },
    "spare-db": {},
    "off-db": { status: "missing" },
  },
  redis: { "hello-cache": {} },
});

describe("preflight: services", () => {
  const pg = { type: "postgres", name: "hello-db" };

  test("a type that is not an installed service plugin is a 400, for every operation", async () => {
    const requests: OperationRequest[] = [
      { op: "service:create", type: "mysql", name: "x-db", version: "" },
      { op: "service:start", type: "mysql", name: "x-db" },
      { op: "service:destroy", type: "mysql", name: "x-db", confirm: "x-db" },
      { op: "service:link", type: "mysql", name: "x-db", app: "hello", restart: false },
      // Core plugins are not service plugins either.
      { op: "service:stop", type: "apps", name: "hello" },
    ];
    for (const req of requests) {
      expect(await refusal(req, withServices)).toMatchObject({
        status: 400,
        kind: "unknown-type",
      });
    }
  });

  test("a service that does not exist is a 404", async () => {
    const requests: OperationRequest[] = [
      { op: "service:start", type: "postgres", name: "nope" },
      { op: "service:stop", type: "postgres", name: "nope" },
      { op: "service:restart", type: "postgres", name: "nope" },
      { op: "service:destroy", type: "postgres", name: "nope", confirm: "nope" },
      { op: "service:link", type: "postgres", name: "nope", app: "hello", restart: true },
      {
        op: "service:unlink",
        type: "postgres",
        name: "nope",
        app: "hello",
        restart: true,
      },
    ];
    for (const req of requests) {
      expect(await refusal(req, withServices)).toEqual({
        status: 404,
        kind: "not-found",
        message: "No such service",
      });
    }
  });

  test("create wants a free name, and a version only where the plugin takes one", async () => {
    expect(
      await preflight(withServices, {
        op: "service:create",
        type: "postgres",
        name: "fresh-db",
        version: "16",
      }),
    ).toEqual({ ok: true, app: null });
    expect(
      await refusal(
        { op: "service:create", type: "postgres", name: "hello-db", version: "" },
        withServices,
      ),
    ).toMatchObject({ status: 409, kind: "exists" });
    // The same name under another plugin is a different service.
    expect(
      (
        await preflight(withServices, {
          op: "service:create",
          type: "redis",
          name: "hello-db",
          version: "",
        })
      ).ok,
    ).toBe(true);
    const bare = serviceHost(host, { postgres: {} }, { versioned: [] });
    expect(
      await refusal(
        { op: "service:create", type: "postgres", name: "fresh-db", version: "16" },
        bare,
      ),
    ).toMatchObject({ status: 400, kind: "unsupported" });
    expect(
      (
        await preflight(bare, {
          op: "service:create",
          type: "postgres",
          name: "fresh-db",
          version: "",
        })
      ).ok,
    ).toBe(true);
  });

  test("destroy is refused while an app is linked, naming it", async () => {
    expect(
      await refusal({ ...pg, op: "service:destroy", confirm: "hello-db" }, withServices),
    ).toMatchObject({
      status: 409,
      kind: "in-use",
      message: expect.stringContaining("hello-multi"),
    });
    expect(
      (
        await preflight(withServices, {
          op: "service:destroy",
          type: "postgres",
          name: "spare-db",
          confirm: "spare-db",
        })
      ).ok,
    ).toBe(true);
  });

  test("linking what is already linked, or unlinking what is not, is a 409", async () => {
    expect(
      await refusal(
        { ...pg, op: "service:link", app: "hello-multi", restart: true },
        withServices,
      ),
    ).toMatchObject({ status: 409, kind: "conflict" });
    expect(
      await refusal(
        { ...pg, op: "service:unlink", app: "hello", restart: true },
        withServices,
      ),
    ).toMatchObject({ status: 409, kind: "conflict" });
  });

  test("link and unlink read the app: it must exist, hold no deploy lock, and not be deploying", async () => {
    const link: OperationRequest = {
      ...pg,
      op: "service:link",
      app: "nope",
      restart: true,
    };
    expect(await refusal(link, withServices)).toMatchObject({
      status: 404,
      kind: "not-found",
      message: "No such app",
    });
    const locked = serviceHost(fakeHost({ hello: running }, { locked: ["hello"] }), {
      postgres: { "hello-db": {} },
    });
    expect(await refusal({ ...link, app: "hello" }, locked)).toMatchObject({
      status: 409,
      kind: "deploy-in-progress",
    });
    const result = await preflight(withServices, { ...link, app: "hello" });
    expect(result.ok && result.app?.name).toBe("hello");
    const unlink = await preflight(withServices, {
      ...pg,
      op: "service:unlink",
      app: "hello-multi",
      restart: false,
    });
    expect(unlink.ok && unlink.app?.name).toBe("hello-multi");
  });

  test("start, stop and restart must fit the state the service is in", async () => {
    const off = { type: "postgres", name: "off-db" };
    expect(await refusal({ ...pg, op: "service:start" }, withServices)).toEqual({
      status: 409,
      kind: "unavailable",
      message: "Already running.",
    });
    expect(await refusal({ ...off, op: "service:stop" }, withServices)).toMatchObject({
      status: 409,
      message: "Already stopped.",
    });
    expect(await refusal({ ...off, op: "service:restart" }, withServices)).toMatchObject({
      status: 409,
      kind: "unavailable",
    });
    for (const req of [
      { ...off, op: "service:start" },
      { ...pg, op: "service:stop" },
      { ...pg, op: "service:restart" },
    ] as const) {
      expect((await preflight(withServices, req)).ok).toBe(true);
    }
  });

  test("a failed plugin read is a 502, not an unknown type", async () => {
    const broken: DokkuRun = async () => ({
      ok: false,
      error: { kind: "connection", message: "ssh: connection refused" },
    });
    expect(await refusal({ ...pg, op: "service:start" }, broken)).toMatchObject({
      status: 502,
      kind: "connection",
    });
  });
});

describe("service output never carries a password", () => {
  const secret = "postgres://postgres:s3cr3tpw@dokku-postgres-x:5432/x";
  const leaky: DokkuSteps = {
    step: async () =>
      ok(
        `=====> x postgres information\n       Dsn:    ${secret}\n       Status: running`,
      ),
    streamStep: () => ({
      ok: true,
      lines: (async function* () {
        yield `       DATABASE_URL:  ${secret}`;
        yield "-----> Restarting app hello";
      })(),
      exit: Promise.resolve({ kind: "command", message: `failed near ${secret}` }),
      kill: () => {},
    }),
  };

  test("a quick step's output is masked", async () => {
    const result = await runSteps(leaky, [["postgres:create", "x"]]);
    expect(result.ok && result.output).toContain(
      "postgres://postgres:********@dokku-postgres-x",
    );
    expect(JSON.stringify(result)).not.toContain("s3cr3tpw");
  });

  test("a streamed step's lines and failure are masked", async () => {
    const lines: string[] = [];
    const error = await streamSteps(
      leaky,
      [["postgres:link", "x", "hello"]],
      async (line) => {
        lines.push(line);
      },
    );
    expect(lines).toHaveLength(2);
    expect(JSON.stringify({ lines, error })).not.toContain("s3cr3tpw");
    expect(lines[0]).toContain("DATABASE_URL:  postgres://postgres:********@");
  });

  test("a failed quick step's message is masked", async () => {
    const failing: DokkuSteps = {
      ...leaky,
      step: async () => ({
        ok: false,
        error: { kind: "command", message: `bad ${secret}` },
      }),
    };
    const result = await runSteps(failing, [["postgres:link", "x", "hello"]]);
    expect(JSON.stringify(result)).not.toContain("s3cr3tpw");
  });
});

describe("failureText", () => {
  const marker = "\u001b[1m\u001b[31m !     \u001b[0m\u001b[0m";

  test("keeps the last lines that say something, plain and without a password", () => {
    const message = [
      "pg_dump: warning: lots of progress",
      "pg_dump: more progress",
      `${marker}connection to postgres://postgres:p@ss/word@dokku-postgres-x:5432/x failed`,
      `${marker}`,
      "pg_dump: error: query failed",
      `${marker}Export aborted`,
    ].join("\n");
    expect(failureText(message)).toBe(
      "connection to postgres://postgres:********@dokku-postgres-x:5432/x failed pg_dump: error: query failed Export aborted",
    );
    expect(failureText(message)).not.toContain("word");
  });

  test("a message with nothing in it is empty", () => {
    expect(failureText(`${marker}\n\n`)).toBe("");
  });
});
