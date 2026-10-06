import { describe, expect, test } from "bun:test";
import type { BuildRecord, OperationRecord } from "../shared/types";
import { mergeActivity } from "./activity";

const t = (seconds: number) =>
  new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();

const op = (at: number, patch: Partial<OperationRecord> = {}): OperationRecord => ({
  at: t(at),
  op: "ps:rebuild",
  app: "hello",
  target: "hello",
  actor: null,
  outcome: "ok",
  durationMs: 25_000,
  message: "",
  ...patch,
});

const build = (
  id: string,
  at: number,
  patch: Partial<BuildRecord> = {},
): BuildRecord => ({
  id,
  kind: "build",
  source: "ps:rebuild",
  status: "succeeded",
  startedAt: t(at),
  finishedAt: t(at + 25),
  exitCode: 0,
  ...patch,
});

const merge = (
  operations: OperationRecord[],
  records: BuildRecord[],
  app = "hello",
  limit = 50,
) => mergeActivity(operations, [{ app, records }], limit);

describe("mergeActivity", () => {
  test("a build a pierhead rebuild caused is folded into the operation, not listed twice", () => {
    const rows = merge([op(0)], [build("b1", 1)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "operation",
      op: "ps:rebuild",
      builds: ["b1"],
    });
  });

  test("a restart's build and deploy records both go to it", () => {
    const rows = merge(
      [op(0, { op: "ps:restart" })],
      [build("deploy1", 2, { kind: "deploy", source: "ps:restart" }), build("b1", 1)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ builds: ["deploy1", "b1"] });
  });

  test("a record outside the operation's window, or on another app, stays its own row", () => {
    const rows = merge([op(0)], [build("late", 120), build("early", -60)]);
    expect(rows.map((r) => r.kind)).toEqual(["build", "operation", "build"]);
    const other = mergeActivity(
      [op(0)],
      [{ app: "other", records: [build("x", 1)] }],
      50,
    );
    expect(other.map((r) => r.kind)).toEqual(["build", "operation"]);
    expect(other.find((r) => r.kind === "operation")).toMatchObject({ builds: [] });
  });

  test("operations that never deploy do not claim a record, nor does a refused one", () => {
    const rows = merge(
      [op(0, { op: "domains:add" }), op(0, { outcome: "refused", message: "conflict" })],
      [build("b1", 1)],
    );
    expect(rows.filter((r) => r.kind === "build")).toHaveLength(1);
  });

  test("with overlapping operations the record goes to the one that started last before it", () => {
    const rows = merge([op(0), op(5)], [build("b1", 6)]);
    const claimed = rows.filter((r) => r.kind === "operation" && r.builds.length > 0);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.at).toBe(t(5));
  });

  test("a failed operation keeps its outcome and still claims the record", () => {
    const rows = merge(
      [op(0, { outcome: "failed", message: "boom" })],
      [build("b1", 1, { status: "failed", exitCode: 1 })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failed", message: "boom", builds: ["b1"] });
  });

  test("rows are newest first and trimmed to the limit", () => {
    const rows = merge(
      [op(0, { op: "domains:add" }), op(100, { op: "domains:remove" })],
      [build("push", 50, { source: "git push" })],
      "hello",
      2,
    );
    expect(rows.map((r) => r.at)).toEqual([t(100), t(50)]);
  });

  test("network operations have no app and appear as they are", () => {
    const rows = merge([op(0, { op: "network:create", app: null, target: "net" })], []);
    expect(rows[0]).toMatchObject({ kind: "operation", app: null, target: "net" });
  });

  test("three git:sync within seconds each keep their own record", () => {
    const sync = (at: number) => op(at, { op: "git:sync", durationMs: 28_000 });
    const rows = merge(
      [sync(0), sync(3), sync(6)],
      [build("r0", 0.5), build("r3", 3.5), build("r6", 6.5)],
    );
    const owned = rows.flatMap((r) => (r.kind === "operation" ? [[r.at, r.builds]] : []));
    expect(owned).toEqual([
      [t(6), ["r6"]],
      [t(3), ["r3"]],
      [t(0), ["r0"]],
    ]);
  });

  test("a record is never given to an operation that started after it, unless none had", () => {
    // The op at 5 s started after the record at 3 s; the one at 0 s had started and is still running.
    const rows = merge([op(0), op(5)], [build("b1", 3)]);
    const owner = rows.find((r) => r.kind === "operation" && r.builds.length > 0);
    expect(owner?.at).toBe(t(0));
    // With only a later operation inside the slack, it still goes there rather than standing alone.
    const late = merge([op(5)], [build("b2", 1)]);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ kind: "operation", builds: ["b2"] });
  });

  test("a config change claims a record only when it restarted the app", () => {
    for (const name of ["config:set", "config:unset"]) {
      const restarted = merge([op(0, { op: name, restart: true })], [build("c1", 1)]);
      expect(restarted).toHaveLength(1);
      expect(restarted[0]).toMatchObject({ kind: "operation", builds: ["c1"] });
      for (const restart of [false, undefined]) {
        const quiet = merge([op(0, { op: name, restart })], [build("c1", 1)]);
        expect(quiet.map((r) => r.kind).sort()).toEqual(["build", "operation"]);
      }
    }
  });
});
