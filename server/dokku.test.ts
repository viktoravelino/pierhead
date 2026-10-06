import { describe, expect, test } from "bun:test";
import { buildStep, shellQuote } from "./dokku";

// sshd hands the command to a shell, so this quoting is what keeps a value one argument.
describe("shellQuote", () => {
  test("wraps in single quotes and escapes embedded ones", () => {
    expect(shellQuote("a b=c")).toBe("'a b=c'");
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  test("a shell reads the result back as the original string", () => {
    for (const value of [`K=a b=c "q" x`, "K=it's $HOME `x` ; ok", "K=\\ y", "K="]) {
      const out = Bun.spawnSync(["sh", "-c", `printf %s ${shellQuote(value)}`]);
      expect(out.stdout.toString()).toBe(value);
    }
  });
});

// The server re-checks every step the shared table built before it reaches ssh.
describe("buildStep", () => {
  test("passes known steps through, quoting what a shell would expand", () => {
    expect(buildStep(["apps:destroy", "--force", "hello"])).toEqual({
      ok: true,
      argv: ["apps:destroy", "--force", "hello"],
    });
    expect(buildStep(["domains:add", "hello", "*.example.com", "a.example.com"])).toEqual(
      {
        ok: true,
        argv: ["domains:add", "hello", "'*.example.com'", "'a.example.com'"],
      },
    );
    expect(buildStep(["ports:set", "hello", "http:80:5000"]).ok).toBe(true);
    // Removals pass what Dokku holds; the table's parse decides what may be added.
    expect(buildStep(["ports:remove", "hello", "tcp:80:80"]).ok).toBe(true);
    expect(buildStep(["domains:remove", "hello", "Old_Host.example.com"]).ok).toBe(true);
    expect(buildStep(["apps:locked", "hello"]).ok).toBe(false);
  });

  test("refuses commands that are not operations and arguments off the grammar", () => {
    for (const argv of [
      ["apps:list"],
      ["config:set", "hello", "A=b"],
      ["apps:destroy", "hello"],
      ["apps:create", "-h"],
      ["apps:create", "hello", "extra"],
      ["domains:add", "hello", "bad domain"],
      ["domains:add", "hello", "-h"],
      ["domains:remove", "hello", "$HOME.example.com"],
      ["ports:remove", "hello", "a;b:80:80"],
      ["domains:add", "hello"],
      ["ports:add", "hello", "http:80"],
      ["ports:add", "hello", "http:80:5000;ls"],
      [],
    ]) {
      expect(buildStep(argv).ok).toBe(false);
    }
  });
});

describe("buildStep: settings steps", () => {
  const root = "/var/lib/dokku/data/storage";

  test("passes the steps the table builds, quoting the alias option for the SSH hop", () => {
    const argvs = [
      ["ps:scale", "--skip-deploy", "hello", "web=1", "worker=0"],
      ["network:create", "my-net"],
      ["network:destroy", "--force", "my-net"],
      ["network:set", "hello", "attach-post-create", "a-net", "b-net"],
      ["network:set", "hello", "initial-network"],
      ["builder:set", "hello", "build-dir", "apps/web"],
      ["builder:set", "hello", "selected"],
      ["builder-dockerfile:set", "hello", "dockerfile-path", "docker/Dockerfile.prod"],
      [
        "resource:limit",
        "--process-type",
        "web",
        "--memory",
        "256m",
        "--cpu",
        "0.5",
        "hello",
      ],
      ["resource:reserve-clear", "hello"],
      ["resource:limit-clear", "--process-type", "_default_", "hello"],
      ["storage:create", "my-data"],
      ["storage:mount", "hello", `${root}/my-data:/data`],
      ["storage:unmount", "hello", `${root}/old.dir:/data`],
    ];
    for (const argv of argvs) expect(buildStep(argv)).toEqual({ ok: true, argv });
    expect(
      buildStep(["docker-options:add", "hello", "deploy", "--network-alias api"]),
    ).toEqual({
      ok: true,
      argv: ["docker-options:add", "hello", "deploy", "'--network-alias api'"],
    });
  });

  test("refuses what the grammars refuse and options that are not aliases", () => {
    for (const argv of [
      ["ps:scale", "hello", "We-b=1"],
      ["ps:scale", "hello", "web=99"],
      ["ps:scale", "hello", "web=-1"],
      ["ps:scale", "hello"],
      ["ps:scale", "--skip-deploy", "web=1"],
      ["network:create", "Bad Net"],
      ["network:create", "-h"],
      ["network:destroy", "my-net"],
      ["network:set", "hello", "tld", "a-net"],
      ["network:set", "hello", "initial-network", "a;b"],
      ["docker-options:add", "hello", "build", "--network-alias api"],
      ["docker-options:add", "hello", "deploy", "--privileged"],
      ["docker-options:add", "hello", "deploy", "--network-alias a;b"],
      ["docker-options:add", "hello", "deploy", "--network-alias Upper"],
      ["builder:set", "hello", "build-dir", "../x"],
      ["builder:set", "hello", "build-dir", "/etc"],
      ["builder:set", "hello", "selected", "nope"],
      ["builder:set", "hello", "skip-cleanup", "true"],
      ["builder-dockerfile:set", "hello", "build-dir", "x"],
      ["resource:limit", "--memory", "lots", "hello"],
      ["resource:limit", "--cpu", "-1", "hello"],
      ["resource:limit", "--memory", "5m", "hello"],
      ["resource:limit", "--unknown", "1", "hello"],
      ["resource:limit", "hello", "--memory", "1g"],
      ["resource:limit-clear", "--memory", "1g", "hello"],
      ["storage:create", "../x"],
      ["storage:create", "UPPER"],
      ["storage:mount", "hello", "/etc:/data"],
      ["storage:mount", "hello", `${root}/../etc:/data`],
      ["storage:mount", "hello", `${root}/x/y:/data`],
      ["storage:mount", "hello", `${root}/x:data`],
      ["storage:mount", "hello", `${root}/x:/a/../b`],
      ["storage:mount", "hello", `${root}/x:/a b`],
      ["storage:unmount", "hello", `/opt/host:/data`],
      ["storage:unmount", "hello", `${root}/x:/data:ro`],
    ]) {
      expect(buildStep(argv).ok).toBe(false);
    }
  });
});
