import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { OperationRecord, ProxyRestore } from "../shared/types";

// Everything pierhead remembers itself, in one directory (`PIERHEAD_STATE_DIR`): the
// activity log, a JSON line per operation attempt, and what a proxy-disabled app had
// before (Dokku clears it). Reads come from memory, loaded once at startup; writes go
// to disk as well. A directory that cannot be used leaves the same store in memory.

/** Entries the activity log keeps; the oldest go first. */
export const defaultMaxEntries = 2000;

const activityFile = "activity.jsonl";
const restoreFile = "proxy-restore.json";

/** The directory from `PIERHEAD_STATE_DIR`; relative to the working directory, `.dev/state` when unset. */
export const loadStateDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.PIERHEAD_STATE_DIR?.trim() || ".dev/state";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const outcomes = ["ok", "refused", "failed"] as const;

/** Narrows one parsed line; a line that does not fit (a hand edit, a torn write) is skipped. */
function toOperationRecord(value: unknown): OperationRecord | null {
  if (!isRecord(value)) return null;
  const { at, op, app, target, actor, outcome, durationMs, message, restart } = value;
  const known = outcomes.find((o) => o === outcome);
  if (
    typeof at !== "string" ||
    Number.isNaN(Date.parse(at)) ||
    typeof op !== "string" ||
    (typeof app !== "string" && app !== null) ||
    typeof target !== "string" ||
    (typeof actor !== "string" && actor !== null) ||
    known === undefined ||
    typeof durationMs !== "number" ||
    typeof message !== "string" ||
    (restart !== undefined && typeof restart !== "boolean")
  ) {
    return null;
  }
  return {
    at,
    op,
    app,
    target,
    actor,
    outcome: known,
    durationMs,
    message,
    ...(restart === undefined ? {} : { restart }),
  };
}

const isRestore = (value: unknown): value is ProxyRestore =>
  isRecord(value) && Array.isArray(value.ports) && Array.isArray(value.domains);

/**
 * Opens the store in `dir` (created when missing; null for memory only). `warn` hears
 * why a directory could not be used, once, and about any later failed write.
 */
export function createStateStore(
  dir: string | null,
  {
    maxEntries = defaultMaxEntries,
    warn = console.warn,
  }: { maxEntries?: number; warn?: (message: string) => void } = {},
) {
  let entries: OperationRecord[] = [];
  const restores = new Map<string, ProxyRestore>();
  let persistent = dir !== null;
  // Lines in the file, which exceed `entries` between compactions.
  let fileLines = 0;

  const fail = (what: string, e: unknown) => {
    if (persistent) {
      persistent = false;
      warn(
        `state: ${what} failed (${e instanceof Error ? e.message : String(e)}); keeping state in memory`,
      );
    }
  };

  if (dir !== null) {
    try {
      mkdirSync(dir, { recursive: true });
      const log = join(dir, activityFile);
      if (existsSync(log)) {
        const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
        fileLines = lines.length;
        entries = lines.flatMap((line) => {
          try {
            const record = toOperationRecord(JSON.parse(line));
            return record ? [record] : [];
          } catch {
            return [];
          }
        });
      }
      // Probe for write access now, not at the first operation.
      appendFileSync(log, "");
    } catch (e) {
      fail("opening the state directory", e);
    }
  }
  // Read on its own: a damaged file must cost the saved restores, not the log or later writes.
  if (dir !== null) {
    const saved = join(dir, restoreFile);
    try {
      if (existsSync(saved)) {
        const parsed: unknown = JSON.parse(readFileSync(saved, "utf8"));
        if (!isRecord(parsed)) throw new Error("not an object");
        for (const [app, value] of Object.entries(parsed)) {
          if (isRestore(value)) restores.set(app, value);
        }
      }
    } catch (e) {
      warn(
        `state: ignoring ${restoreFile} (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
  if (persistent) entries = entries.slice(-maxEntries);

  /** Replaces `file` whole: a crash leaves the old content or the new, never half. */
  const replaceFile = (file: string, content: string) => {
    const target = join(dir ?? "", file);
    writeFileSync(`${target}.tmp`, content);
    renameSync(`${target}.tmp`, target);
  };

  const saveRestores = () => {
    if (!persistent || dir === null) return;
    try {
      replaceFile(restoreFile, JSON.stringify(Object.fromEntries(restores)));
    } catch (e) {
      fail("saving the proxy restore state", e);
    }
  };

  return {
    /** Whether state survives a restart. */
    get persistent() {
      return persistent;
    },

    /** Appends one attempt. Past `maxEntries` the oldest are dropped; the file is rewritten once it is a tenth over. */
    record(entry: OperationRecord) {
      entries.push(entry);
      if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
      if (!persistent || dir === null) return;
      try {
        const log = join(dir, activityFile);
        if (fileLines >= maxEntries + Math.ceil(maxEntries / 10)) {
          replaceFile(
            activityFile,
            `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
          );
          fileLines = entries.length;
        } else {
          appendFileSync(log, `${JSON.stringify(entry)}\n`);
          fileLines += 1;
        }
      } catch (e) {
        fail("appending to the activity log", e);
      }
    },

    /** Attempts newest first, for one app when `app` is given, at most `limit` when it is. */
    recent({ limit, app }: { limit?: number; app?: string } = {}) {
      const matching = app === undefined ? entries : entries.filter((e) => e.app === app);
      const newest = matching.toReversed();
      return limit === undefined ? newest : newest.slice(0, limit);
    },

    /** What the app had before its proxy was disabled through pierhead, if it was. */
    restoreOf: (app: string) => restores.get(app),
    saveRestore(app: string, restore: ProxyRestore) {
      restores.set(app, restore);
      saveRestores();
    },
    clearRestore(app: string) {
      if (restores.delete(app)) saveRestores();
    },
  };
}

export type StateStore = ReturnType<typeof createStateStore>;
