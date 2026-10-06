import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildStep, createDokku, knownServiceTypes, shellQuote } from "./dokku";

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

describe("buildStep: rename, clone and the global settings", () => {
  test("rename and clone take an optional --skip-deploy, the old app and a new-app name", () => {
    expect(buildStep(["apps:rename", "--skip-deploy", "hello", "hello-2"])).toEqual({
      ok: true,
      argv: ["apps:rename", "--skip-deploy", "hello", "hello-2"],
    });
    expect(buildStep(["apps:clone", "hello", "hello-copy"])).toEqual({
      ok: true,
      argv: ["apps:clone", "hello", "hello-copy"],
    });
    for (const argv of [
      ["apps:rename", "hello"],
      ["apps:rename", "hello", "Bad_Name"],
      ["apps:rename", "hello", "a".repeat(64)],
      ["apps:clone", "hello", "-h"],
      ["apps:clone", "--ignore-existing", "hello", "copy"],
      ["apps:clone", "hello", "copy", "extra"],
      ["apps:clone", "--skip-deploy", "hello"],
      ["apps:rename", "bad app", "x"],
    ]) {
      expect(buildStep(argv).ok).toBe(false);
    }
  });

  test("global domains are checked and quoted like app domains", () => {
    expect(buildStep(["domains:add-global", "lab.local", "*.lab.local"])).toEqual({
      ok: true,
      argv: ["domains:add-global", "'lab.local'", "'*.lab.local'"],
    });
    expect(buildStep(["domains:remove-global", "Old_One.local"]).ok).toBe(true);
    for (const argv of [
      ["domains:add-global"],
      ["domains:set-global", "bad domain"],
      ["domains:remove-global", "-h"],
      ["domains:add-global", "$HOME.local"],
    ]) {
      expect(buildStep(argv).ok).toBe(false);
    }
  });

  test("git:set takes --global in place of the app, and nothing else in that slot", () => {
    expect(buildStep(["git:set", "--global", "deploy-branch", "main"])).toEqual({
      ok: true,
      argv: ["git:set", "--global", "deploy-branch", "main"],
    });
    expect(buildStep(["git:set", "--global", "deploy-branch"]).ok).toBe(true);
    for (const argv of [
      ["git:set", "--global", "keep-git-dir", "true"],
      ["git:set", "--global", "deploy-branch", "a b"],
      ["git:set", "--local", "deploy-branch", "main"],
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

describe("buildStep: deploys", () => {
  const url = "https://github.com/crccheck/docker-hello-world";

  test("git:from-image, git:sync and git:set pass checked arguments through", () => {
    expect(buildStep(["git:from-image", "hello", "nginx:alpine"])).toEqual({
      ok: true,
      argv: ["git:from-image", "hello", "nginx:alpine"],
    });
    expect(buildStep(["git:sync", "--build", "hello", url, "master"])).toEqual({
      ok: true,
      argv: ["git:sync", "--build", "hello", url, "master"],
    });
    expect(buildStep(["git:sync", "hello", "git@github.com:o/r.git"]).ok).toBe(true);
    expect(buildStep(["git:set", "hello", "deploy-branch", "main"]).ok).toBe(true);
    expect(buildStep(["git:set", "hello", "deploy-branch"]).ok).toBe(true);
  });

  test("anything outside the grammar or the fixed flags is refused", () => {
    for (const argv of [
      ["git:from-image", "hello", "-x"],
      ["git:from-image", "hello", "nginx:alpine; rm"],
      ["git:from-image", "hello", "nginx", "me", "me@example.com"],
      ["git:sync", "hello", "file:///tmp"],
      ["git:sync", "hello", "/tmp/x"],
      ["git:sync", "--build-if-changes", "hello", url],
      ["git:sync", "--skip-deploy-branch", "hello", url],
      ["git:sync", "hello", url, "-x"],
      ["git:sync", "hello", url, "main", "extra"],
      ["git:sync", "-h", url],
      ["git:set", "hello", "keep-git-dir", "true"],
      ["git:set", "hello", "deploy-branch", "-x"],
      ["git:set", "hello", "deploy-branch", "a", "b"],
    ]) {
      expect(buildStep(argv).ok).toBe(false);
    }
  });
});

describe("buildStep: services", () => {
  beforeEach(() => knownServiceTypes.replace(["postgres", "redis"]));
  afterEach(() => knownServiceTypes.replace([]));

  test("the same builders serve every installed type, with only the fixed flags", () => {
    for (const type of ["postgres", "redis"]) {
      expect(buildStep([`${type}:create`, "hello-db"])).toEqual({
        ok: true,
        argv: [`${type}:create`, "hello-db"],
      });
      expect(buildStep([`${type}:start`, "hello-db"]).ok).toBe(true);
      expect(buildStep([`${type}:stop`, "hello-db"]).ok).toBe(true);
      expect(buildStep([`${type}:restart`, "hello-db"]).ok).toBe(true);
      expect(buildStep([`${type}:destroy`, "hello-db", "--force"]).ok).toBe(true);
    }
    expect(
      buildStep(["postgres:create", "hello-db", "--image-version", "16-alpine"]),
    ).toEqual({
      ok: true,
      argv: ["postgres:create", "hello-db", "--image-version", "16-alpine"],
    });
    expect(buildStep(["postgres:link", "hello-db", "hello"]).ok).toBe(true);
    expect(buildStep(["postgres:link", "hello-db", "hello", "--no-restart"]).ok).toBe(
      true,
    );
    expect(buildStep(["redis:unlink", "hello-cache", "hello", "--no-restart"]).ok).toBe(
      true,
    );
    // A type that becomes known later is served without a code change.
    knownServiceTypes.replace(["postgres", "mysql"]);
    expect(buildStep(["mysql:start", "db"]).ok).toBe(true);
    expect(buildStep(["redis:start", "db"]).ok).toBe(false);
  });

  test("a type that is not an installed service plugin never becomes a command", () => {
    // Core plugins have the same verbs (`nginx:stop`, `apps:destroy`...); only discovered
    // service plugins may be addressed this way.
    for (const argv of [
      ["nginx:stop", "x"],
      ["nginx:start", "x"],
      ["storage:create", "x", "y"],
      ["traefik:restart", "x"],
      ["Post gres:start", "x"],
      ["postgres;ls:start", "x"],
      ["mysql:start", "x"],
    ]) {
      expect(buildStep(argv).ok).toBe(false);
    }
  });

  test("anything off the grammar, extra or not a service verb is refused", () => {
    for (const argv of [
      ["postgres:create"],
      ["postgres:create", "-h"],
      ["postgres:create", "a b"],
      ["postgres:create", "x", "--image-version"],
      ["postgres:create", "x", "--image-version", "--force"],
      ["postgres:create", "x", "--image-version", "16", "extra"],
      ["postgres:create", "x", "--password", "pw"],
      ["postgres:create", "x", "--image", "evil"],
      ["postgres:destroy", "x"],
      ["postgres:destroy", "x", "--force", "extra"],
      ["postgres:destroy", "x", "-f"],
      ["postgres:link", "x"],
      ["postgres:link", "x", "Bad App"],
      ["postgres:link", "x", "hello", "--alias", "FOO"],
      ["postgres:link", "x", "hello", "--no-restart", "extra"],
      ["postgres:unlink", "x", "hello", "-n"],
      ["postgres:start", "x", "extra"],
      ["postgres:start", "x;ls"],
      ["postgres:export", "x"],
      ["postgres:expose", "x", "5432"],
      ["postgres:backup", "x", "bucket"],
      ["postgres:connect", "x"],
      ["postgres:enter", "x"],
      ["postgres:create:more", "x"],
    ]) {
      expect(buildStep(argv).ok).toBe(false);
    }
  });

  test("reads and the dump refuse an unknown type before anything reaches ssh", async () => {
    knownServiceTypes.replace([]);
    const dokku = createDokku({
      host: "unreachable.invalid",
      port: 22,
      user: "dokku",
      keyPath: "/nonexistent",
      knownHostsPath: "/nonexistent",
      timeoutMs: 1000,
    });
    for (const result of [
      await dokku("service:info", "postgres"),
      await dokku("service:info", "postgres", "hello-db"),
      await dokku("service:dsn", "postgres", "hello-db"),
      await dokku("service:create-help", "postgres"),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "command",
          message: expect.stringContaining("Unknown service type"),
        },
      });
    }
    expect(dokku.stream("service:logs", "postgres", "hello-db", 100).ok).toBe(false);
    expect(dokku.streamBytes(1000, "service:export", "postgres", "hello-db").ok).toBe(
      false,
    );
    knownServiceTypes.replace(["postgres"]);
    expect(await dokku("service:dsn", "postgres", "-x")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Invalid service name") },
    });
    expect(dokku.stream("service:logs", "postgres", "hello-db", 0).ok).toBe(false);
  });
});
