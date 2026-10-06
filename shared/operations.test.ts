import { describe, expect, test } from "bun:test";
import {
  commandLine,
  commandSteps,
  destructiveConfirm,
  isOperationId,
  type OperationId,
  type OperationRequest,
  operationAvailability,
  operations,
  parseOperation,
  streamsOutput,
} from "./operations";
import type { AppStatus } from "./types";

const app = "hello";
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
      expect(commandLine(req)).toBe(argv.map((a) => `dokku ${a.join(" ")}`).join("\n"));
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

  test("only destroy is destructive, and it must be confirmed with the app's name", () => {
    for (const id of ids) {
      expect(destructiveConfirm(valid[id].req) !== undefined).toBe(id === "apps:destroy");
    }
    expect(destructiveConfirm({ op: "apps:destroy", app, confirm: "oops" })).toEqual({
      typed: "oops",
      expected: app,
    });
    expect(parseOperation("apps:destroy", { app })).toMatch(/confirm/);
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

  test("apps:create enforces the new-app grammar", () => {
    refused("apps:create", { app: "Bad_Name" });
    refused("apps:create", { app: "a".repeat(64) });
    expect(parseOperation("apps:create", { app: "1abc" })).toEqual({
      op: "apps:create",
      app: "1abc",
    });
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
