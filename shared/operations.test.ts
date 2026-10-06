import { describe, expect, test } from "bun:test";
import {
  appOf,
  commandLine,
  commandSteps,
  destructiveConfirm,
  invalidationOf,
  isOperationId,
  isServiceRequest,
  type OperationId,
  type OperationRequest,
  operationAvailability,
  operations,
  parseOperation,
  type ServiceState,
  serviceAvailability,
  streamsOutput,
  targetOf,
} from "./operations";
import type { AppStatus } from "./types";

const app = "hello";
const digestImage = `ghcr.io/dokku/smoke:1.2@sha256:${"a".repeat(64)}`;
const http80 = { scheme: "http", host: 80, container: 5000 };
const http8081 = { scheme: "http", host: 8081, container: 5000 };

// One valid request per operation and the argv it must build. Keyed by id, so a new
// operation is a type error here until it has a row.
const valid = {
  "ps:start": { req: { op: "ps:start", app }, argv: [["ps:start", app]] },
  "ps:stop": { req: { op: "ps:stop", app }, argv: [["ps:stop", app]] },
  "ps:restart": { req: { op: "ps:restart", app }, argv: [["ps:restart", app]] },
  "ps:rebuild": { req: { op: "ps:rebuild", app }, argv: [["ps:rebuild", app]] },
  "apps:create": { req: { op: "apps:create", app }, argv: [["apps:create", app]] },
  "apps:destroy": {
    req: { op: "apps:destroy", app, confirm: app },
    argv: [["apps:destroy", "--force", app]],
  },
  "apps:rename": {
    req: { op: "apps:rename", app, newName: "hello-2", skipDeploy: true, confirm: app },
    argv: [["apps:rename", "--skip-deploy", app, "hello-2"]],
  },
  "apps:clone": {
    req: { op: "apps:clone", app, newName: "hello-copy", skipDeploy: false },
    argv: [["apps:clone", app, "hello-copy"]],
  },
  "domains:add-global": {
    req: { op: "domains:add-global", domains: ["lab.local", "*.b.example.com"] },
    argv: [["domains:add-global", "lab.local", "*.b.example.com"]],
  },
  "domains:remove-global": {
    req: { op: "domains:remove-global", domains: ["lab.local"] },
    argv: [["domains:remove-global", "lab.local"]],
  },
  "domains:set-global": {
    req: { op: "domains:set-global", domains: ["lab.local"] },
    argv: [["domains:set-global", "lab.local"]],
  },
  "git:set-global": {
    req: { op: "git:set-global", branch: "main" },
    argv: [["git:set", "--global", "deploy-branch", "main"]],
  },
  "domains:add": {
    req: { op: "domains:add", app, domains: ["a.example.com", "*.b.example.com"] },
    argv: [["domains:add", app, "a.example.com", "*.b.example.com"]],
  },
  "domains:remove": {
    req: { op: "domains:remove", app, domains: ["a.example.com"] },
    argv: [["domains:remove", app, "a.example.com"]],
  },
  "domains:set": {
    req: { op: "domains:set", app, domains: ["a.example.com"] },
    argv: [["domains:set", app, "a.example.com"]],
  },
  "ports:add": {
    req: { op: "ports:add", app, mappings: [http8081] },
    argv: [["ports:add", app, "http:8081:5000"]],
  },
  "ports:remove": {
    req: { op: "ports:remove", app, mappings: [http8081] },
    argv: [["ports:remove", app, "http:8081:5000"]],
  },
  "ports:set": {
    req: { op: "ports:set", app, mappings: [http80, http8081] },
    argv: [["ports:set", app, "http:80:5000", "http:8081:5000"]],
  },
  "proxy:enable": {
    req: { op: "proxy:enable", app },
    argv: [["proxy:enable", app]],
  },
  "proxy:disable": { req: { op: "proxy:disable", app }, argv: [["proxy:disable", app]] },
  "ps:scale": {
    req: {
      op: "ps:scale",
      app,
      formation: [
        { type: "web", count: 2 },
        { type: "worker", count: 0 },
      ],
      skipDeploy: true,
    },
    argv: [["ps:scale", "--skip-deploy", app, "web=2", "worker=0"]],
  },
  "network:create": {
    req: { op: "network:create", network: "my-net" },
    argv: [["network:create", "my-net"]],
  },
  "network:destroy": {
    req: { op: "network:destroy", network: "my-net", confirm: "my-net" },
    argv: [["network:destroy", "--force", "my-net"]],
  },
  "network:set": {
    req: {
      op: "network:set",
      app,
      property: "attach-post-deploy",
      networks: ["a-net", "b-net"],
      rebuild: true,
    },
    argv: [
      ["network:set", app, "attach-post-deploy", "a-net", "b-net"],
      ["ps:rebuild", app],
    ],
  },
  "network:alias-add": {
    req: { op: "network:alias-add", app, alias: "api", rebuild: false },
    argv: [["docker-options:add", app, "deploy", "--network-alias api"]],
  },
  "network:alias-remove": {
    req: { op: "network:alias-remove", app, alias: "api", rebuild: false },
    argv: [["docker-options:remove", app, "deploy", "--network-alias api"]],
  },
  "apps:unlock": { req: { op: "apps:unlock", app }, argv: [["apps:unlock", app]] },
  "git:from-image": {
    req: {
      op: "git:from-image",
      app,
      image: digestImage,
    },
    argv: [["git:from-image", app, digestImage]],
  },
  "git:sync": {
    req: {
      op: "git:sync",
      app,
      url: "https://github.com/crccheck/docker-hello-world",
      ref: "master",
      build: true,
    },
    argv: [
      [
        "git:sync",
        "--build",
        app,
        "https://github.com/crccheck/docker-hello-world",
        "master",
      ],
    ],
  },
  "git:set": {
    req: { op: "git:set", app, branch: "main" },
    argv: [["git:set", app, "deploy-branch", "main"]],
  },
  "builder:set": {
    req: { op: "builder:set", app, property: "build-dir", value: "backend" },
    argv: [["builder:set", app, "build-dir", "backend"]],
  },
  "resource:set": {
    req: {
      op: "resource:set",
      app,
      kind: "limit",
      processType: "web",
      memory: "256m",
      cpu: "0.5",
    },
    argv: [
      [
        "resource:limit",
        "--process-type",
        "web",
        "--memory",
        "256m",
        "--cpu",
        "0.5",
        app,
      ],
    ],
  },
  "resource:clear": {
    req: { op: "resource:clear", app, kind: "reserve", processType: null },
    argv: [["resource:reserve-clear", "--process-type", "_default_", app]],
  },
  "storage:mount": {
    req: { op: "storage:mount", app, name: "my-data", containerPath: "/data" },
    argv: [
      ["storage:create", "my-data"],
      ["storage:mount", app, "/var/lib/dokku/data/storage/my-data:/data"],
    ],
  },
  "storage:unmount": {
    req: {
      op: "storage:unmount",
      app,
      name: "my-data",
      containerPath: "/data",
      confirm: "/data",
    },
    argv: [["storage:unmount", app, "/var/lib/dokku/data/storage/my-data:/data"]],
  },
  "service:create": {
    req: {
      op: "service:create",
      type: "postgres",
      name: "hello-db",
      version: "16-alpine",
    },
    argv: [["postgres:create", "hello-db", "--image-version", "16-alpine"]],
  },
  "service:destroy": {
    req: {
      op: "service:destroy",
      type: "redis",
      name: "hello-cache",
      confirm: "hello-cache",
    },
    argv: [["redis:destroy", "hello-cache", "--force"]],
  },
  "service:link": {
    req: { op: "service:link", type: "postgres", name: "hello-db", app, restart: false },
    argv: [["postgres:link", "hello-db", app, "--no-restart"]],
  },
  "service:unlink": {
    req: { op: "service:unlink", type: "postgres", name: "hello-db", app, restart: true },
    argv: [["postgres:unlink", "hello-db", app]],
  },
  "service:start": {
    req: { op: "service:start", type: "redis", name: "hello-cache" },
    argv: [["redis:start", "hello-cache"]],
  },
  "service:stop": {
    req: { op: "service:stop", type: "redis", name: "hello-cache" },
    argv: [["redis:stop", "hello-cache"]],
  },
  "service:restart": {
    req: { op: "service:restart", type: "redis", name: "hello-cache" },
    argv: [["redis:restart", "hello-cache"]],
  },
} as const satisfies {
  [K in OperationId]: {
    req: Extract<OperationRequest, { op: K }>;
    argv: string[][];
  };
};

const ids = Object.keys(operations).filter(isOperationId);

describe("operations table", () => {
  test("every operation builds its argv, and the dialog prints exactly that", () => {
    expect(Object.keys(valid).sort()).toEqual(Object.keys(operations).sort());
    for (const id of ids) {
      const { req, argv } = valid[id];
      expect(commandSteps(req)).toEqual(argv);
      // Only an argument with a space (an alias option) is printed in quotes.
      const printed = argv.map((a) =>
        ["dokku", ...a.map((x) => (x.includes(" ") ? `"${x}"` : x))].join(" "),
      );
      expect(commandLine(req)).toBe(printed.join("\n"));
    }
  });

  test("proxy:enable with ports restores them in a second step", () => {
    const req: OperationRequest = { op: "proxy:enable", app, ports: [http80] };
    expect(commandSteps(req)).toEqual([
      ["proxy:enable", app],
      ["ports:set", app, "http:80:5000"],
    ]);
    expect(commandLine(req)).toBe(
      `dokku proxy:enable ${app}\ndokku ports:set ${app} http:80:5000`,
    );
  });

  test("proxy:enable can restore the domains Dokku cleared too", () => {
    const req: OperationRequest = {
      op: "proxy:enable",
      app,
      ports: [http80],
      domains: ["a.example.com", "b.example.com"],
    };
    expect(commandSteps(req)).toEqual([
      ["proxy:enable", app],
      ["ports:set", app, "http:80:5000"],
      ["domains:set", app, "a.example.com", "b.example.com"],
    ]);
  });

  test("a valid request parses back to itself", () => {
    for (const id of ids)
      expect(parseOperation(id, valid[id].req)).toEqual(valid[id].req);
  });

  test("isOperationId rejects names inherited from Object", () => {
    expect(isOperationId("ps:rebuild")).toBe(true);
    for (const value of ["", "destroy", "toString", "__proto__", "apps:list"]) {
      expect(isOperationId(value)).toBe(false);
    }
  });

  test("destroying an app or a network and unmounting storage are confirmed by typing the name", () => {
    const destructive = new Set<OperationId>([
      "apps:destroy",
      "apps:rename",
      "network:destroy",
      "storage:unmount",
      "service:destroy",
    ]);
    for (const id of ids) {
      expect(destructiveConfirm(valid[id].req) !== undefined).toBe(destructive.has(id));
    }
    expect(destructiveConfirm({ op: "apps:destroy", app, confirm: "oops" })).toEqual({
      typed: "oops",
      expected: app,
    });
    expect(
      destructiveConfirm({ op: "network:destroy", network: "my-net", confirm: "x" }),
    ).toEqual({ typed: "x", expected: "my-net" });
    expect(destructiveConfirm(valid["storage:unmount"].req)).toEqual({
      typed: "/data",
      expected: "/data",
    });
    expect(parseOperation("apps:destroy", { app })).toMatch(/confirm/);
    expect(parseOperation("network:destroy", { network: "my-net" })).toMatch(/confirm/);
  });

  test("a step whose argument has a space is printed in quotes", () => {
    expect(commandLine(valid["network:alias-add"].req)).toBe(
      `dokku docker-options:add ${app} deploy "--network-alias api"`,
    );
  });

  test("scale streams unless only the formation is saved; settings stream when they rebuild", () => {
    const running = { status: { kind: "running" } } as const;
    const scale = valid["ps:scale"].req;
    expect(streamsOutput(scale, running)).toBe(false);
    expect(streamsOutput({ ...scale, skipDeploy: false }, running)).toBe(true);
    expect(streamsOutput(valid["network:set"].req, running)).toBe(true);
    expect(streamsOutput(valid["network:alias-add"].req, running)).toBe(false);
    expect(streamsOutput(valid["storage:mount"].req, running)).toBe(false);
  });

  test("rename and clone stream when they redeploy a deployed app, and only then", () => {
    const running = { status: { kind: "running" } } as const;
    const never = { status: { kind: "not-deployed" } } as const;
    const rename = valid["apps:rename"].req;
    const clone = valid["apps:clone"].req;
    expect(streamsOutput({ ...rename, skipDeploy: false }, running)).toBe(true);
    expect(streamsOutput(rename, running)).toBe(false);
    expect(streamsOutput(clone, running)).toBe(true);
    expect(streamsOutput(clone, never)).toBe(false);
    expect(streamsOutput({ ...clone, skipDeploy: true }, null)).toBe(false);
  });

  test("rename and clone name both apps, for the toast and the log; the global settings name what they set", () => {
    expect(targetOf(valid["apps:rename"].req)).toBe("hello -> hello-2");
    expect(targetOf(valid["apps:clone"].req)).toBe("hello -> hello-copy");
    expect(appOf(valid["apps:rename"].req)).toBeNull();
    expect(appOf(valid["apps:clone"].req)).toBeNull();
    expect(appOf(valid["ps:start"].req)).toBe(app);
    expect(targetOf(valid["domains:add-global"].req)).toBe("lab.local *.b.example.com");
    expect(targetOf(valid["git:set-global"].req)).toBe("main");
    expect(targetOf({ op: "git:set-global", branch: "" })).toBe("default");
  });

  test("a rename drops both apps from the cache; the global settings drop the host and every app", () => {
    expect(invalidationOf(valid["apps:rename"].req)).toEqual({
      kind: "apps",
      apps: [app, "hello-2"],
    });
    expect(invalidationOf(valid["apps:clone"].req)).toEqual({
      kind: "apps",
      apps: [app, "hello-copy"],
    });
    expect(invalidationOf(valid["ps:start"].req)).toEqual({ kind: "apps", apps: [app] });
    expect(invalidationOf(valid["network:create"].req)).toEqual({ kind: "networks" });
    for (const op of [
      "domains:add-global",
      "domains:remove-global",
      "domains:set-global",
      "git:set-global",
    ] as const) {
      expect(invalidationOf(valid[op].req)).toEqual({ kind: "host" });
    }
  });

  test("clearing the global deploy branch passes no value", () => {
    expect(commandSteps({ op: "git:set-global", branch: "" })).toEqual([
      ["git:set", "--global", "deploy-branch"],
    ]);
  });

  test("builder:set picks the plugin by property and clears with no value", () => {
    const set = (property: "selected" | "dockerfile-path", value: string) =>
      commandSteps({ op: "builder:set", app, property, value });
    expect(set("dockerfile-path", "docker/Dockerfile.prod")).toEqual([
      ["builder-dockerfile:set", app, "dockerfile-path", "docker/Dockerfile.prod"],
    ]);
    expect(set("selected", "")).toEqual([["builder:set", app, "selected"]]);
  });

  test("resources: one flag per value set, the process type first, and limit or reserve by kind", () => {
    const set = (memory: string, cpu: string, processType: string | null) =>
      commandSteps({
        op: "resource:set",
        app,
        kind: "reserve",
        processType,
        memory,
        cpu,
      });
    expect(set("64m", "", null)).toEqual([["resource:reserve", "--memory", "64m", app]]);
    expect(set("", "1", "worker")).toEqual([
      ["resource:reserve", "--process-type", "worker", "--cpu", "1", app],
    ]);
    expect(
      commandSteps({ op: "resource:clear", app, kind: "limit", processType: "web" }),
    ).toEqual([["resource:limit-clear", "--process-type", "web", app]]);
    // Without a process type Dokku clears every type's setting, so the default is named.
    expect(
      commandSteps({ op: "resource:clear", app, kind: "limit", processType: null }),
    ).toEqual([["resource:limit-clear", "--process-type", "_default_", app]]);
    expect(
      parseOperation("resource:clear", { app, kind: "limit", processType: "_default_" }),
    ).toEqual({ op: "resource:clear", app, kind: "limit", processType: null });
  });

  test("git:sync without a build or a ref is just the URL; an empty branch clears", () => {
    const url = "git@github.com:owner/repo.git";
    expect(commandSteps({ op: "git:sync", app, url, ref: "", build: false })).toEqual([
      ["git:sync", app, url],
    ]);
    expect(commandSteps({ op: "git:set", app, branch: "" })).toEqual([
      ["git:set", app, "deploy-branch"],
    ]);
  });

  test("both deploys stream whatever the app is doing; setting the branch does not", () => {
    for (const status of [{ kind: "running" }, { kind: "not-deployed" }] as const) {
      expect(streamsOutput(valid["git:from-image"].req, { status })).toBe(true);
      expect(streamsOutput(valid["git:sync"].req, { status })).toBe(true);
    }
    expect(streamsOutput(valid["git:set"].req, null)).toBe(false);
  });

  test("apps:unlock is available only while the lock is held, even mid-deploy", () => {
    const state = {
      status: { kind: "running" },
      revision: null,
      proxyEnabled: true,
    } as const;
    expect(operationAvailability("apps:unlock", { ...state, locked: true })).toEqual({
      ok: true,
    });
    expect(operationAvailability("apps:unlock", state)).toMatchObject({ ok: false });
    expect(
      operationAvailability("apps:unlock", { ...state, locked: false }),
    ).toMatchObject({
      ok: false,
    });
    // Everything else is refused while a deploy runs; unlocking is what remains.
    expect(
      operationAvailability("apps:unlock", {
        ...state,
        status: { kind: "deploying", step: "build" },
        locked: true,
      }),
    ).toEqual({ ok: true });
  });

  test("rebuild streams; proxy toggles stream once deployed", () => {
    const running = { status: { kind: "running" } } as const;
    const fresh = { status: { kind: "not-deployed" } } as const;
    expect(streamsOutput(valid["ps:rebuild"].req, running)).toBe(true);
    expect(streamsOutput(valid["ps:restart"].req, running)).toBe(false);
    expect(streamsOutput(valid["proxy:disable"].req, running)).toBe(true);
    expect(streamsOutput(valid["proxy:disable"].req, fresh)).toBe(false);
    expect(streamsOutput(valid["proxy:enable"].req, null)).toBe(true);
  });
});

describe("request validation", () => {
  const refused = (op: OperationId, body: unknown) =>
    expect(typeof parseOperation(op, body)).toBe("string");

  test("refuses bodies that are not objects or miss the app", () => {
    for (const body of [null, "hello", 7, [], {}, { app: 1 }]) refused("ps:start", body);
  });

  test("refuses app names that could reach a shell or a flag", () => {
    for (const bad of ["-h", "Bad_Name", "a b", "a;b", "../etc", ""]) {
      refused("ps:stop", { app: bad });
    }
  });

  test("git:from-image refuses anything but an image reference", () => {
    for (const image of [
      "-x",
      "nginx:alpine; rm",
      "nginx alpine",
      "NGINX",
      "",
      "nginx:",
    ]) {
      refused("git:from-image", { app, image });
    }
    refused("git:from-image", { app, image: 7 });
    refused("git:from-image", { app: "-h", image: "nginx" });
  });

  test("git:sync refuses local paths, credentials, flags and odd refs", () => {
    const url = "https://github.com/owner/repo";
    for (const bad of [
      "file:///tmp",
      "/tmp/x",
      "-x",
      "https://user:token@github.com/owner/repo",
      "https://github.com/owner/repo extra",
      "ssh://git@host/owner/repo",
      "",
    ]) {
      refused("git:sync", { app, url: bad, ref: "", build: true });
    }
    for (const ref of ["-x", "a b", "a;b", "../x", "a..b"]) {
      refused("git:sync", { app, url, ref, build: true });
    }
    refused("git:sync", { app, url, ref: "", build: "yes" });
  });

  test("git:set refuses a branch that could be a flag", () => {
    for (const branch of ["-x", "a b", "../x"]) refused("git:set", { app, branch });
  });

  test("apps:create enforces the new-app grammar", () => {
    refused("apps:create", { app: "Bad_Name" });
    refused("apps:create", { app: "a".repeat(64) });
    expect(parseOperation("apps:create", { app: "1abc" })).toEqual({
      op: "apps:create",
      app: "1abc",
    });
  });

  test("rename and clone enforce the new-app grammar on the new name and refuse the same name", () => {
    for (const op of ["apps:rename", "apps:clone"] as const) {
      const body = { app, skipDeploy: false, confirm: app };
      for (const newName of ["Bad_Name", "a".repeat(64), "-x", "", "a b", "../x"]) {
        refused(op, { ...body, newName });
      }
      refused(op, { ...body, newName: app });
      refused(op, { ...body, newName: 7 });
      refused(op, { ...body, app: "Bad_App", newName: "ok" });
      expect(typeof parseOperation(op, { ...body, newName: "1.ok-name" })).toBe("object");
    }
    refused("apps:rename", { app, newName: "x", skipDeploy: false });
  });

  test("global domains use the app-domain grammar: hostnames to add, safe strings to remove", () => {
    for (const domain of ["-h", "bad domain", "http://x.com", "x.com:80"]) {
      refused("domains:add-global", { domains: [domain] });
      refused("domains:set-global", { domains: ["ok.com", domain] });
    }
    refused("domains:add-global", { domains: [] });
    refused("domains:set-global", { domains: ["a.com", "a.com"] });
    refused("domains:add-global", { app, domains: "a.com" });
    // A domain Dokku already holds may be odd; only shell safety applies to removing it.
    expect(
      typeof parseOperation("domains:remove-global", { domains: ["Odd_One.com"] }),
    ).toBe("object");
    refused("domains:remove-global", { domains: ["a b"] });
  });

  test("git:set-global refuses a branch that could be a flag", () => {
    refused("git:set-global", { branch: "--help" });
    refused("git:set-global", { branch: "a b" });
    refused("git:set-global", {});
    expect(typeof parseOperation("git:set-global", { branch: "release/1.0" })).toBe(
      "object",
    );
  });

  test("domains: bad hostnames, empty and oversized lists, duplicates", () => {
    for (const domain of ["-h", "bad domain", "http://x.com", "x.com:80"]) {
      refused("domains:add", { app, domains: [domain] });
      refused("domains:set", { app, domains: ["ok.com", domain] });
    }
    refused("domains:add", { app, domains: [] });
    refused("domains:add", { app, domains: "a.com" });
    refused("domains:add", { app, domains: [7] });
    refused("domains:add", { app, domains: ["a.com", "a.com"] });
    refused("domains:add", {
      app,
      domains: Array.from({ length: 21 }, (_, i) => `d${i}.com`),
    });
  });

  // Removals and restores take what Dokku holds; only the shell-safety rules apply.
  test("removals accept any stored domain or scheme that is safe to pass on", () => {
    const stored = { scheme: "tcp", host: 80, container: 80 };
    expect(
      parseOperation("domains:remove", { app, domains: ["Old_Host.Example.com"] }),
    ).toEqual({
      op: "domains:remove",
      app,
      domains: ["Old_Host.Example.com"],
    });
    expect(typeof parseOperation("ports:remove", { app, mappings: [stored] })).toBe(
      "object",
    );
    expect(
      typeof parseOperation("domains:add", { app, domains: ["Old_Host.Example.com"] }),
    ).toBe("string");
    expect(typeof parseOperation("ports:add", { app, mappings: [stored] })).toBe(
      "string",
    );
    for (const bad of ["-h", "a b", "a'b", "$HOME", "a;b", ""]) {
      refused("domains:remove", { app, domains: [bad] });
      refused("ports:remove", { app, mappings: [{ ...stored, scheme: bad }] });
      refused("proxy:enable", { app, domains: [bad] });
    }
  });

  test("ports: malformed mappings, bad ranges, reused scheme:host", () => {
    const body = (mappings: unknown) => ({ app, mappings });
    refused("ports:add", body([]));
    refused("ports:add", body(["http:80:5000"]));
    refused("ports:add", body([{ scheme: "http", host: "80", container: 5000 }]));
    refused("ports:add", body([{ scheme: "ftp", host: 80, container: 5000 }]));
    refused("ports:add", body([{ scheme: "http", host: 0, container: 5000 }]));
    refused("ports:set", body([{ scheme: "http", host: 80, container: 70000 }]));
    refused("ports:set", body([http80, { ...http80, container: 6000 }]));
    refused("proxy:enable", { app, ports: [{ scheme: "http", host: 80 }] });
  });
});

describe("request validation: settings", () => {
  const refused = (op: OperationId, body: unknown) =>
    expect(typeof parseOperation(op, body)).toBe("string");
  const accepted = (op: OperationId, body: unknown) =>
    expect(typeof parseOperation(op, body)).toBe("object");

  test("scale: process types, counts, duplicates and empty formations", () => {
    const body = (formation: unknown) => ({ app, formation });
    for (const type of ["We-b", "-w", "w b", "web;ls", "", "a".repeat(64)]) {
      refused("ps:scale", body([{ type, count: 1 }]));
    }
    for (const count of [-1, 21, 99, 1.5, "2", Number.NaN]) {
      refused("ps:scale", body([{ type: "web", count }]));
    }
    refused("ps:scale", body([]));
    refused(
      "ps:scale",
      body([
        { type: "web", count: 1 },
        { type: "web", count: 2 },
      ]),
    );
    refused("ps:scale", { ...body([{ type: "web", count: 1 }]), skipDeploy: "yes" });
    accepted(
      "ps:scale",
      body([
        { type: "web", count: 0 },
        { type: "worker_2", count: 20 },
      ]),
    );
  });

  test("networks: names, aliases and the attach properties", () => {
    for (const network of ["Bad", "a b", "-h", "a;b", "../x", "", "n".repeat(64)]) {
      refused("network:create", { network });
    }
    accepted("network:create", { network: "my_net.v2" });
    for (const alias of ["Api", "a.b", "-x", "a b", "a_b", "", "x".repeat(64)]) {
      refused("network:alias-add", { app, alias });
    }
    accepted("network:alias-add", { app, alias: "api-2" });
    // Removing takes what Dokku holds, as long as it is safe to pass on.
    accepted("network:alias-remove", { app, alias: "Old.Alias" });
    for (const alias of ["-x", "a b", "a;b", "$HOME"]) {
      refused("network:alias-remove", { app, alias });
    }
    const set = (property: unknown, networks: unknown) => ({ app, property, networks });
    refused("network:set", set("tld", ["a-net"]));
    refused("network:set", set("initial-network", ["a-net", "b-net"]));
    refused("network:set", set("attach-post-create", ["a-net", "a-net"]));
    refused("network:set", set("attach-post-create", ["-h"]));
    refused("network:set", set("attach-post-create", ["a b"]));
    accepted("network:set", set("attach-post-create", []));
    accepted("network:set", set("initial-network", ["a-net"]));
  });

  test("builder: paths stay inside the repository and builders come from the list", () => {
    const set = (property: string, value: unknown) =>
      parseOperation("builder:set", { app, property, value });
    for (const value of [
      "../x",
      "a/../b",
      "/etc",
      "-h",
      "a b",
      "a//b",
      "a/",
      "./a",
      "a;b",
      "a/.",
    ]) {
      expect(typeof set("build-dir", value)).toBe("string");
      expect(typeof set("dockerfile-path", value)).toBe("string");
    }
    for (const value of ["nope", "Dockerfile", "NixPacks"]) {
      expect(typeof set("selected", value)).toBe("string");
    }
    expect(typeof set("skip-cleanup", "true")).toBe("string");
    for (const value of ["backend", "apps/web.v2", "docker/Dockerfile.prod", ""]) {
      expect(typeof set("build-dir", value)).toBe("object");
    }
    for (const value of [
      "dockerfile",
      "herokuish",
      "pack",
      "nixpacks",
      "railpack",
      "lambda",
      "null",
      "",
    ]) {
      expect(typeof set("selected", value)).toBe("object");
    }
  });

  test("resources: Dokku's memory units, plain cpu numbers, at least one value", () => {
    const set = (memory: string, cpu: string, extra: object = {}) =>
      parseOperation("resource:set", { app, kind: "limit", memory, cpu, ...extra });
    for (const memory of [
      "lots",
      "-1",
      "256 m",
      "256mb",
      "1.5g",
      "m",
      "256M",
      "1e3",
      "5m",
      "64k",
      "0",
    ]) {
      expect(typeof set(memory, "")).toBe("string");
    }
    for (const cpu of ["-1", "abc", "1.234", ".5", "1,5", "0x1"]) {
      expect(typeof set("", cpu)).toBe("string");
    }
    expect(set("", "")).toMatch(/memory or a cpu/);
    expect(typeof set("256m", "0.5", { processType: "-x" })).toBe("string");
    expect(typeof set("256m", "0.5", { processType: "we b" })).toBe("string");
    expect(typeof set("256m", "0.5", { kind: "other" })).toBe("string");
    for (const [memory, cpu] of [
      ["256m", "0.5"],
      ["512", ""],
      ["", "2"],
      ["1g", "1.25"],
    ] as const) {
      expect(typeof set(memory, cpu)).toBe("object");
    }
    expect(
      typeof parseOperation("resource:clear", { app, kind: "limit", processType: "w w" }),
    ).toBe("string");
  });

  test("storage: names stay under the root, container paths stay absolute and clean", () => {
    const mount = (name: string, containerPath: string) =>
      parseOperation("storage:mount", { app, name, containerPath });
    for (const name of ["../etc", "/etc", "a/b", "UPPER", "a b", "-x", "a.b", ""]) {
      expect(typeof mount(name, "/data")).toBe("string");
    }
    for (const path of [
      "data",
      "/etc/../x",
      "/a b",
      "/a//b",
      "/a/",
      "/",
      "/a:ro",
      "/a;b",
    ]) {
      expect(typeof mount("my-data", path)).toBe("string");
    }
    expect(typeof mount("my_data-2", "/var/lib/app.d/data")).toBe("object");
    const unmount = (name: string, containerPath: string) =>
      parseOperation("storage:unmount", { app, name, containerPath, confirm: "" });
    expect(typeof unmount("../etc", "/data")).toBe("string");
    expect(typeof unmount("/opt/x", "/data")).toBe("string");
    expect(typeof unmount("old.dir", "/a/../b")).toBe("string");
    expect(typeof unmount("old.dir", "/a:ro")).toBe("string");
    expect(typeof unmount("old.dir", "/data")).toBe("object");
  });
});

describe("availability", () => {
  const revision = { sha: "abc", updatedAt: null };
  const ps = ["ps:start", "ps:restart", "ps:rebuild", "ps:stop"] as const;

  // Expected [start, restart, rebuild, stop] per status. Keyed by status kind, so a new
  // kind is a type error here until it gets a row.
  const table = {
    running: { status: { kind: "running" }, expected: [false, true, true, true] },
    crashed: {
      status: { kind: "crashed", failing: ["web.1"] },
      expected: [false, true, true, true],
    },
    stopped: { status: { kind: "stopped" }, expected: [true, false, true, false] },
    deploying: {
      status: { kind: "deploying", step: "build" },
      expected: [false, false, false, false],
    },
    "not-deployed": {
      status: { kind: "not-deployed" },
      expected: [false, false, false, false],
    },
  } as const satisfies {
    [K in AppStatus["kind"]]: {
      status: Extract<AppStatus, { kind: K }>;
      expected: readonly boolean[];
    };
  };

  for (const [kind, { status, expected }] of Object.entries(table)) {
    test(`start/restart/rebuild/stop while ${kind}`, () => {
      const state = { status, revision: null, proxyEnabled: true };
      expect(ps.map((op) => operationAvailability(op, state).ok)).toEqual([...expected]);
    });
  }

  test("every refusal says why", () => {
    for (const { status } of Object.values(table)) {
      for (const op of ids) {
        const result = operationAvailability(op, {
          status,
          revision,
          proxyEnabled: true,
        });
        if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });

  test("a never-deployed app can be rebuilt once code was pushed", () => {
    const status = { kind: "not-deployed" } as const;
    expect(
      operationAvailability("ps:rebuild", { status, revision: null, proxyEnabled: true }),
    ).toEqual({
      ok: false,
      reason: "No code has been pushed yet.",
    });
    expect(
      operationAvailability("ps:rebuild", { status, revision, proxyEnabled: true }).ok,
    ).toBe(true);
  });

  test("domain edits need the proxy; the reason says to enable it", () => {
    const status = { kind: "running" } as const;
    for (const op of ["domains:add", "domains:remove", "domains:set"] as const) {
      expect(
        operationAvailability(op, { status, revision, proxyEnabled: false }),
      ).toEqual({
        ok: false,
        reason: "Enable the proxy first.",
      });
      expect(operationAvailability(op, { status, revision, proxyEnabled: true }).ok).toBe(
        true,
      );
    }
    expect(
      operationAvailability("ports:set", { status, revision, proxyEnabled: false }).ok,
    ).toBe(true);
  });

  test("edits and destroy work on a stopped or never-deployed app, but not mid-deploy", () => {
    const edits = [
      "apps:destroy",
      "domains:add",
      "domains:remove",
      "domains:set",
      "ports:add",
      "ports:remove",
      "ports:set",
    ] as const;
    for (const op of edits) {
      for (const status of [{ kind: "stopped" }, { kind: "not-deployed" }] as const) {
        expect(
          operationAvailability(op, { status, revision: null, proxyEnabled: true }).ok,
        ).toBe(true);
      }
      const deploying = { kind: "deploying", step: "build" } as const;
      expect(
        operationAvailability(op, { status: deploying, revision, proxyEnabled: true }).ok,
      ).toBe(false);
    }
  });

  test("rename and clone work on a stopped or never-deployed app, but not mid-deploy", () => {
    for (const op of ["apps:rename", "apps:clone"] as const) {
      for (const status of [{ kind: "stopped" }, { kind: "not-deployed" }] as const) {
        expect(
          operationAvailability(op, { status, revision: null, proxyEnabled: true }).ok,
        ).toBe(true);
      }
      const deploying = { kind: "deploying", step: "build" } as const;
      expect(
        operationAvailability(op, { status: deploying, revision, proxyEnabled: true }).ok,
      ).toBe(false);
    }
  });

  test("the global settings need no app state", () => {
    const state = {
      status: { kind: "stopped" },
      revision: null,
      proxyEnabled: false,
    } as const;
    for (const op of [
      "domains:add-global",
      "domains:set-global",
      "git:set-global",
    ] as const) {
      expect(operationAvailability(op, state).ok).toBe(true);
    }
  });

  test("the proxy can only be switched to the state it is not in", () => {
    const status = { kind: "running" } as const;
    const on = { status, revision, proxyEnabled: true };
    const off = { status, revision, proxyEnabled: false };
    expect(operationAvailability("proxy:disable", on).ok).toBe(true);
    expect(operationAvailability("proxy:enable", on).ok).toBe(false);
    expect(operationAvailability("proxy:enable", off).ok).toBe(true);
    expect(operationAvailability("proxy:disable", off).ok).toBe(false);
  });
});

describe("availability: settings", () => {
  const revision = { sha: "abc", updatedAt: null };
  const state = (status: AppStatus, canScale?: boolean) => ({
    status,
    revision,
    proxyEnabled: true,
    canScale,
  });

  test("scale needs a deployed app Dokku will scale, and not a deploy under way", () => {
    expect(operationAvailability("ps:scale", state({ kind: "running" })).ok).toBe(true);
    expect(operationAvailability("ps:scale", state({ kind: "stopped" })).ok).toBe(true);
    expect(operationAvailability("ps:scale", state({ kind: "running" }, false))).toEqual({
      ok: false,
      reason: "Dokku does not scale this app.",
    });
    expect(operationAvailability("ps:scale", state({ kind: "not-deployed" }))).toEqual({
      ok: false,
      reason: "Never deployed, so there is nothing to scale yet.",
    });
    expect(
      operationAvailability("ps:scale", state({ kind: "deploying", step: "build" })).ok,
    ).toBe(false);
  });

  test("settings apply to a never-deployed app, but not mid-deploy", () => {
    const settings = [
      "network:set",
      "network:alias-add",
      "network:alias-remove",
      "builder:set",
      "resource:set",
      "resource:clear",
      "storage:mount",
      "storage:unmount",
    ] as const;
    for (const op of settings) {
      expect(operationAvailability(op, state({ kind: "not-deployed" })).ok).toBe(true);
      expect(
        operationAvailability(op, state({ kind: "deploying", step: "build" })).ok,
      ).toBe(false);
    }
  });
});

describe("service operations", () => {
  const base = { type: "postgres", name: "hello-db" };

  test("a blank version builds no flag, and create always streams", () => {
    const req = parseOperation("service:create", { ...base, version: "" });
    expect(req).toEqual({ op: "service:create", ...base, version: "" });
    if (typeof req === "string") throw new Error(req);
    expect(commandSteps(req)).toEqual([["postgres:create", "hello-db"]]);
    expect(streamsOutput(req, null)).toBe(true);
    // The version may be left out of the body altogether.
    expect(parseOperation("service:create", base)).toEqual(req);
  });

  test("the type, name and version are held to their grammars", () => {
    const refused: [OperationId, Record<string, unknown>][] = [
      ["service:create", { ...base, type: "Post gres" }],
      ["service:create", { ...base, type: "p" }],
      ["service:create", { ...base, type: "postgres:create" }],
      ["service:create", { ...base, type: "-postgres" }],
      ["service:create", { ...base, type: "a".repeat(22) }],
      ["service:create", { ...base, name: "Hello_DB" }],
      ["service:create", { ...base, name: "a" }],
      ["service:create", { ...base, name: "-db" }],
      ["service:create", { ...base, name: "db-" }],
      ["service:create", { ...base, name: "x".repeat(41) }],
      ["service:create", { ...base, version: "--force" }],
      ["service:create", { ...base, version: "16 alpine" }],
      ["service:create", { ...base, version: "16;ls" }],
      ["service:destroy", { ...base, name: "-f", confirm: "-f" }],
      ["service:destroy", { ...base, name: "a b", confirm: "a b" }],
      ["service:destroy", { ...base }],
      ["service:start", { ...base, name: "$(id)" }],
      ["service:link", { ...base, app: "Bad App" }],
      ["service:link", { ...base, app: "--force" }],
      ["service:link", { ...base, restart: "yes", app }],
    ];
    for (const [op, body] of refused) {
      expect(typeof parseOperation(op, body)).toBe("string");
    }
  });

  test("a service that exists keeps whatever name Dokku allowed", () => {
    for (const name of ["Bad_Name", "a", "db_1"]) {
      expect(parseOperation("service:start", { ...base, name })).toMatchObject({ name });
    }
  });

  test("destroy asks for the service's name", () => {
    const req = valid["service:destroy"].req;
    expect(destructiveConfirm(req)).toEqual({
      typed: "hello-cache",
      expected: "hello-cache",
    });
    expect(destructiveConfirm({ ...req, confirm: "oops" })).toEqual({
      typed: "oops",
      expected: "hello-cache",
    });
  });

  test("link and unlink stream only when a running app is restarted", () => {
    const link = valid["service:link"].req;
    const running = { status: { kind: "running" } } as const;
    const stopped = { status: { kind: "stopped" } } as const;
    expect(streamsOutput({ ...link, restart: true }, running)).toBe(true);
    expect(
      streamsOutput(
        { ...link, restart: true },
        { status: { kind: "crashed", failing: [] } },
      ),
    ).toBe(true);
    expect(streamsOutput({ ...link, restart: true }, stopped)).toBe(false);
    expect(streamsOutput({ ...link, restart: true }, null)).toBe(false);
    expect(streamsOutput({ ...link, restart: false }, running)).toBe(false);
    expect(streamsOutput(valid["service:start"].req, running)).toBe(false);
  });

  test("a service is the target, a link names its app, and every one drops the services read", () => {
    const link = valid["service:link"].req;
    expect(targetOf(link)).toBe("hello-db");
    expect(appOf(link)).toBe(app);
    expect(invalidationOf(link)).toEqual({ kind: "services", apps: [app] });
    const stop = valid["service:stop"].req;
    expect(targetOf(stop)).toBe("hello-cache");
    expect(appOf(stop)).toBeNull();
    expect(invalidationOf(stop)).toEqual({ kind: "services", apps: [] });
  });

  test("isServiceRequest tells service requests from the rest", () => {
    expect(isServiceRequest(valid["service:stop"].req)).toBe(true);
    expect(isServiceRequest(valid["ps:stop"].req)).toBe(false);
  });

  test("the state of the service decides what can be done", () => {
    const running: ServiceState = { status: "running", apps: [] };
    const stopped: ServiceState = { status: "stopped", apps: [] };
    const linked: ServiceState = { status: "running", apps: [app] };
    const reason = (req: OperationRequest, service: ServiceState) =>
      isServiceRequest(req) ? serviceAvailability(req, service) : null;
    expect(reason(valid["service:start"].req, running)).toEqual({
      ok: false,
      reason: "Already running.",
    });
    expect(reason(valid["service:start"].req, stopped)).toEqual({ ok: true });
    expect(reason(valid["service:stop"].req, stopped)).toEqual({
      ok: false,
      reason: "Already stopped.",
    });
    expect(reason(valid["service:restart"].req, stopped)).toMatchObject({ ok: false });
    expect(reason(valid["service:restart"].req, running)).toEqual({ ok: true });
    expect(reason(valid["service:destroy"].req, linked)).toEqual({
      ok: false,
      reason: `Still linked to ${app}. Unlink it there first.`,
    });
    expect(reason(valid["service:destroy"].req, running)).toEqual({ ok: true });
    expect(reason(valid["service:link"].req, linked)).toMatchObject({ ok: false });
    expect(reason(valid["service:link"].req, running)).toEqual({ ok: true });
    expect(reason(valid["service:unlink"].req, running)).toMatchObject({ ok: false });
    expect(reason(valid["service:unlink"].req, linked)).toEqual({ ok: true });
  });
});
