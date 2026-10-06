import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationRecord } from "../shared/types";
import { createStateStore, loadStateDir } from "./state";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pierhead-state-"));
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

const entry = (n: number, patch: Partial<OperationRecord> = {}): OperationRecord => ({
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  op: "ps:rebuild",
  app: "hello",
  target: "hello",
  actor: null,
  outcome: "ok",
  durationMs: 1000,
  message: "",
  ...patch,
});

describe("the activity log", () => {
  test("is read back newest first, in memory and after a restart", () => {
    const store = createStateStore(dir);
    store.record(entry(1));
    store.record(entry(2, { actor: "viktor", outcome: "failed", message: "boom" }));
    expect(store.recent().map((e) => e.at)).toEqual([entry(2).at, entry(1).at]);

    const reopened = createStateStore(dir);
    expect(reopened.recent()).toEqual(store.recent());
    expect(reopened.recent()[0]).toMatchObject({ actor: "viktor", message: "boom" });
  });

  test("filters by app and limits the count", () => {
    const store = createStateStore(dir);
    store.record(entry(1, { app: "a", target: "a" }));
    store.record(entry(2, { app: null, target: "net", op: "network:create" }));
    store.record(entry(3, { app: "a", target: "a" }));
    expect(store.recent({ app: "a" })).toHaveLength(2);
    expect(store.recent({ limit: 1 })[0]?.at).toBe(entry(3).at);
    expect(store.recent({ app: "net" })).toEqual([]);
  });

  test("keeps at most maxEntries, in memory and on disk, rewriting the file once it is a tenth over", () => {
    const store = createStateStore(dir, { maxEntries: 10 });
    for (let i = 0; i < 11; i++) store.record(entry(i));
    // 11 lines: under the rewrite threshold (11), but memory is already capped.
    expect(store.recent()).toHaveLength(10);
    const lines = () =>
      readFileSync(join(dir, "activity.jsonl"), "utf8").trim().split("\n");
    expect(lines()).toHaveLength(11);
    store.record(entry(11));
    expect(lines()).toHaveLength(10);
    expect(createStateStore(dir, { maxEntries: 10 }).recent()[9]?.at).toBe(entry(2).at);
  });

  test("a reopened store trims an oversized file and skips lines it cannot read", () => {
    const store = createStateStore(dir);
    for (let i = 0; i < 5; i++) store.record(entry(i));
    appendFileSync(join(dir, "activity.jsonl"), 'not json\n{"at":1}\n');
    const reopened = createStateStore(dir, { maxEntries: 3 });
    expect(reopened.recent().map((e) => e.at)).toEqual([
      entry(4).at,
      entry(3).at,
      entry(2).at,
    ]);
  });

  test("compaction replaces the file whole, leaving no temp file behind", () => {
    const store = createStateStore(dir, { maxEntries: 10 });
    for (let i = 0; i < 12; i++) store.record(entry(i));
    expect(readdirSync(dir).sort()).toEqual(["activity.jsonl"]);
  });

  test("keeps a config change's restart flag through a restart", () => {
    const store = createStateStore(dir);
    store.record(entry(1, { op: "config:set", message: "KEY", restart: true }));
    store.record(entry(2));
    const [plain, config] = createStateStore(dir).recent();
    expect(config?.restart).toBe(true);
    expect(plain && "restart" in plain).toBe(false);
  });

  test("records exactly the fields it is given", () => {
    const store = createStateStore(dir);
    store.record(entry(1, { op: "config:set", message: "DATABASE_URL" }));
    const [line] = readFileSync(join(dir, "activity.jsonl"), "utf8").trim().split("\n");
    expect(Object.keys(JSON.parse(line ?? "")).sort()).toEqual(
      ["actor", "app", "at", "durationMs", "message", "op", "outcome", "target"].sort(),
    );
  });
});

describe("the proxy restore state", () => {
  const saved = {
    ports: [{ scheme: "http", host: 80, container: 80 }],
    domains: ["a.example.com"],
  };

  test("survives a restart until it is cleared", () => {
    const store = createStateStore(dir);
    store.saveRestore("hello", saved);
    expect(createStateStore(dir).restoreOf("hello")).toEqual(saved);
    store.clearRestore("hello");
    expect(createStateStore(dir).restoreOf("hello")).toBeUndefined();
  });

  test("a damaged file is ignored with a warning and costs neither the log nor later saves", () => {
    appendFileSync(join(dir, "proxy-restore.json"), "{not json");
    const warnings: string[] = [];
    const store = createStateStore(dir, { warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(store.persistent).toBe(true);
    store.record(entry(1));
    store.saveRestore("hello", saved);
    const reopened = createStateStore(dir);
    expect(reopened.recent()).toHaveLength(1);
    expect(reopened.restoreOf("hello")).toEqual(saved);
  });

  test("ignores a malformed file", () => {
    appendFileSync(
      join(dir, "proxy-restore.json"),
      '{"hello":{"ports":1},"ok":{"ports":[],"domains":[]}}',
    );
    const store = createStateStore(dir);
    expect(store.restoreOf("hello")).toBeUndefined();
    expect(store.restoreOf("ok")).toEqual({ ports: [], domains: [] });
  });
});

describe("without a usable directory", () => {
  test("no directory keeps everything in memory", () => {
    const store = createStateStore(null);
    store.record(entry(1));
    store.saveRestore("hello", { ports: [], domains: [] });
    expect(store.persistent).toBe(false);
    expect(store.recent()).toHaveLength(1);
    expect(store.restoreOf("hello")).toBeDefined();
  });

  test("a directory that cannot be created warns once and falls back to memory", () => {
    const warnings: string[] = [];
    // A file where the directory should be.
    appendFileSync(join(dir, "blocked"), "x");
    const store = createStateStore(join(dir, "blocked", "state"), {
      warn: (m) => warnings.push(m),
    });
    store.record(entry(1));
    expect(store.persistent).toBe(false);
    expect(store.recent()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });
});

describe("loadStateDir", () => {
  test("reads PIERHEAD_STATE_DIR and defaults to .dev/state", () => {
    expect(loadStateDir({ PIERHEAD_STATE_DIR: " /var/lib/pierhead " })).toBe(
      "/var/lib/pierhead",
    );
    expect(loadStateDir({})).toBe(".dev/state");
    expect(loadStateDir({ PIERHEAD_STATE_DIR: "  " })).toBe(".dev/state");
  });
});
