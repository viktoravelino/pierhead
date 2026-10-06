import { describe, expect, test } from "bun:test";
import logs from "./fixtures/logs.json";
import multiDomain from "./fixtures/multi-domain.json";
import neverDeployed from "./fixtures/never-deployed.json";
import running from "./fixtures/running.json";
import stopped from "./fixtures/stopped.json";
import {
  needsGitRev,
  parseAppDetail,
  parseAppSummary,
  parseLogEvent,
  parseReport,
} from "./parse";

// Fixtures are `dokku <plugin>:report <app> --format json` captured from Dokku 0.38.31.

describe("parseAppDetail", () => {
  test("running app", () => {
    const app = parseAppDetail("hello", running);
    expect(app.status).toEqual({ kind: "running" });
    expect(app.processes).toEqual([
      { name: "web.1", type: "web", state: "running", cid: "eb74d208655" },
    ]);
    expect(app.restartPolicy).toBe("on-failure:10");
    expect(app.ports).toEqual([{ scheme: "http", host: 80, container: 80 }]);
    expect(app.domains).toEqual(["hello.dokku.localhost"]);
    expect(app.globalDomain).toBe("dokku.localhost");
    expect(app.proxyEnabled).toBe(true);
    expect(app.proxyType).toBe("nginx");
    expect(app.build).toEqual({ type: "dockerfile", dir: null });
    expect(app.revision).toEqual({
      sha: "5be5944010d0587190fca8e17dac30a49dbd8745",
      updatedAt: "2026-10-05T22:04:58.000Z",
    });
  });

  test("stopped app keeps its exited process and container id", () => {
    const app = parseAppDetail("hello-stopped", stopped);
    expect(app.status).toEqual({ kind: "stopped" });
    expect(app.processes).toEqual([
      { name: "web.1", type: "web", state: "exited", cid: "c85d2cfbd51" },
    ]);
  });

  test("never-deployed app has no processes, ports, build or revision", () => {
    const app = parseAppDetail("hello-new", neverDeployed);
    expect(app.status).toEqual({ kind: "not-deployed" });
    expect(app.processes).toEqual([]);
    expect(app.ports).toEqual([]);
    expect(app.build).toEqual({ type: "other", name: null });
    expect(app.revision).toBeNull();
  });

  test("multi-domain app with a custom port mapping", () => {
    const app = parseAppDetail("hello-multi", multiDomain);
    expect(app.domains).toEqual(["hello-multi.dokku.localhost", "multi.dokku.localhost"]);
    expect(app.ports).toEqual([{ scheme: "http", host: 8081, container: 80 }]);
  });
});

// A real host's apps use the detected port map and keep no git dir, so sha stays "HEAD".
describe("parseAppDetail on a host that sets no explicit ports or git dir", () => {
  const bare = {
    ...running,
    ports: { ...running.ports, "ports-map": "", "ports-map-detected": "http:8000:8000" },
    git: { ...running.git, sha: "HEAD" },
  };

  test("uses the detected port map and has no revision", () => {
    const app = parseAppDetail("insta-down", bare);
    expect(app.ports).toEqual([{ scheme: "http", host: 8000, container: 8000 }]);
    expect(app.revision).toBeNull();
  });

  test("shows no ports without a proxy", () => {
    const app = parseAppDetail("insta-down-api", {
      ...bare,
      proxy: { ...running.proxy, "proxy-enabled": "false" },
    });
    expect(app.ports).toEqual([]);
  });

  test("ignores the detected map of a never-deployed app", () => {
    expect(parseAppDetail("hello-new", neverDeployed).ports).toEqual([]);
  });
});

// Apps deployed by `git push` report sha "HEAD" with a timestamp; the commit is `GIT_REV`.
describe("revision from GIT_REV", () => {
  const pushed = { ...running.git, sha: "HEAD" };
  const gitRev = "0123456789abcdef0123456789abcdef01234567";
  const reports = { ...running, git: pushed };

  test("fills in the sha and keeps the report's timestamp", () => {
    expect(needsGitRev(pushed)).toBe(true);
    expect(parseAppSummary("pushed", { ...reports, gitRev }).revision).toEqual({
      sha: gitRev,
      updatedAt: "2026-10-05T22:04:58.000Z",
    });
    expect(parseAppDetail("pushed", { ...reports, gitRev }).revision?.sha).toBe(gitRev);
  });

  test("a trailing newline is ignored, anything but a sha is not a revision", () => {
    expect(
      parseAppSummary("pushed", { ...reports, gitRev: `${gitRev}\n` }).revision?.sha,
    ).toBe(gitRev);
    expect(parseAppSummary("pushed", { ...reports, gitRev: "HEAD" }).revision).toBeNull();
    expect(parseAppSummary("pushed", reports).revision).toBeNull();
  });

  test("the report's own sha wins, and never-deployed apps need no lookup", () => {
    expect(needsGitRev(running.git)).toBe(false);
    expect(parseAppSummary("hello", { ...running, gitRev }).revision?.sha).toBe(
      running.git.sha,
    );
    expect(needsGitRev({ ...pushed, "last-updated-at": "" })).toBe(false);
  });
});

describe("parseAppSummary", () => {
  test("counts processes and drops detail-only fields", () => {
    expect(parseAppSummary("hello-new", neverDeployed).processCount).toBe(0);
    const summary = parseAppSummary("hello", running);
    expect(summary.processCount).toBe(1);
    expect("ports" in summary).toBe(false);
  });
});

test("parseReport rejects non-object JSON", () => {
  expect(() => parseReport('["hello"]')).toThrow();
});

describe("parseLogEvent", () => {
  // Fixtures are raw lines from `dokku logs` on Dokku 0.38.31, colour codes included.
  const now = new Date("2026-10-05T23:00:00.000Z");

  test("timestamped line has its colour codes stripped", () => {
    expect(parseLogEvent(logs.prefixed, now)).toEqual({
      ts: "2026-10-05T22:34:43.955486210Z",
      process: "web.1",
      line: '192.168.215.1 - - [05/Oct/2026:22:34:43 +0000] "GET / HTTP/1.1" 200 896 "-" "curl/8.7.1" "192.168.97.1"',
    });
  });

  test("line without a prefix (`-q`) keeps its text and gets the receive time", () => {
    expect(parseLogEvent(logs.unprefixed, now)).toEqual({
      ts: now.toISOString(),
      process: "",
      line: logs.unprefixed,
    });
  });

  test("a failure message is kept as a plain line", () => {
    expect(parseLogEvent(logs.notDeployed, now).line).toBe(logs.notDeployed);
  });

  test("malformed prefixes fall back instead of throwing", () => {
    for (const raw of [
      "",
      "\r",
      "not-a-time app[web.1]: hi",
      "2026-10-05T22:34:43Z app[web.1] hi",
    ]) {
      const event = parseLogEvent(raw, now);
      expect(event.process).toBe("");
      expect(event.ts).toBe(now.toISOString());
    }
  });

  test("an empty message after the prefix is still a prefixed line", () => {
    const event = parseLogEvent("2026-10-05T22:34:43.1Z app[worker.2]:", now);
    expect(event).toEqual({
      ts: "2026-10-05T22:34:43.1Z",
      process: "worker.2",
      line: "",
    });
  });
});
