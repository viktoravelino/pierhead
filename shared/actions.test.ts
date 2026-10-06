import { describe, expect, test } from "bun:test";
import {
  actionAvailability,
  appActionIds,
  appActions,
  commandLine,
  isAppActionId,
} from "./actions";
import type { AppStatus } from "./types";

describe("action table", () => {
  test("every listed action has a dokku command and the list covers the table", () => {
    expect(Object.keys(appActions).sort()).toEqual([...appActionIds].sort());
    for (const id of appActionIds) expect(appActions[id].command).toMatch(/^ps:\w+$/);
  });

  test("commandLine is what the dialog shows", () => {
    expect(commandLine("restart", "hello")).toBe("dokku ps:restart hello");
  });

  test("isAppActionId rejects names inherited from Object", () => {
    expect(isAppActionId("rebuild")).toBe(true);
    for (const value of ["", "destroy", "toString", "__proto__"]) {
      expect(isAppActionId(value)).toBe(false);
    }
  });
});

describe("actionAvailability", () => {
  const revision = { sha: "abc", updatedAt: null };

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
    test(kind, () => {
      const got = appActionIds.map(
        (id) => actionAvailability(id, { status, revision: null }).ok,
      );
      expect(got).toEqual([...expected]);
    });
  }

  test("an unavailable action explains itself", () => {
    const result = actionAvailability("start", {
      status: table.running.status,
      revision,
    });
    expect(result).toEqual({ ok: false, reason: "Already running." });
  });

  test("rebuild of a never-deployed app needs a pushed revision", () => {
    const { status } = table["not-deployed"];
    expect(actionAvailability("rebuild", { status, revision: null }).ok).toBe(false);
    expect(actionAvailability("rebuild", { status, revision }).ok).toBe(true);
  });
});
