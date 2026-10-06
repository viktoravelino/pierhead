import { describe, expect, test } from "bun:test";
import { loadWriteGate } from "./writes";

describe("loadWriteGate", () => {
  test("only the literal true enables writes", () => {
    expect(loadWriteGate({ PIERHEAD_ALLOW_WRITES: "true" })).toEqual({ enabled: true });
    for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes", " true"]) {
      expect(loadWriteGate({ PIERHEAD_ALLOW_WRITES: value }).enabled).toBe(false);
    }
  });

  test("a closed gate carries the error the route returns", () => {
    const gate = loadWriteGate({});
    if (gate.enabled) throw new Error("expected a closed gate");
    expect(gate.error.kind).toBe("writes-disabled");
    expect(gate.error.message).toContain("PIERHEAD_ALLOW_WRITES");
  });
});
