import { describe, expect, test } from "bun:test";
import pluginList from "./fixtures/plugin-list.json";
import { maskDsn, maskSecrets, parseServices, parseServiceTypes } from "./services";

const fixture = (name: string) =>
  Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

const password = "fixturepassword";

describe("parseServiceTypes", () => {
  test("finds the service plugins by their description, so a new one needs no code", async () => {
    const types = parseServiceTypes(await fixture("plugin-list-services.json"));
    expect(types).toEqual([
      { type: "postgres", version: "2.2.0" },
      { type: "redis", version: "2.2.0" },
    ]);
    const mysql = {
      name: "mysql",
      version: "1.0.0",
      enabled: true,
      core: false,
      description: "dokku mysql service plugin",
    };
    expect(parseServiceTypes(JSON.stringify([mysql]))).toEqual([
      { type: "mysql", version: "1.0.0" },
    ]);
  });

  test("leaves out core plugins, disabled ones, other plugins and names off the grammar", () => {
    const entry = {
      version: "1",
      enabled: true,
      core: false,
      description: "a service plugin",
    };
    const plugins = [
      { ...entry, name: "postgres", core: true },
      { ...entry, name: "mongo", enabled: false },
      { ...entry, name: "letsencrypt", description: "dokku letsencrypt plugin" },
      { ...entry, name: "Post gres" },
      { ...entry, name: "a" },
      { ...entry, name: "-x" },
      "not an object",
      null,
    ];
    expect(parseServiceTypes(JSON.stringify(plugins))).toEqual([]);
  });

  test("a host with only core plugins has no service types", () => {
    expect(parseServiceTypes(JSON.stringify(pluginList))).toEqual([]);
  });

  test("refuses output that is not a plugin list", () => {
    expect(() => parseServiceTypes('{"a":1}')).toThrow();
  });
});

describe("parseServices", () => {
  test("reads every service of a type from one info call, with its links and state", async () => {
    const services = parseServices("postgres", await fixture("postgres-info-all.ndjson"));
    expect(services.map((s) => s.name)).toEqual(["pr5-p1", "pr5-p2"]);
    expect(services[0]).toEqual({
      type: "postgres",
      name: "pr5-p1",
      status: "running",
      version: "timescale/timescaledb:2.30.1-pg18",
      image: "timescale/timescaledb",
      imageVersion: "2.30.1-pg18",
      apps: ["hello-new", "hello-stopped"],
      exposedPorts: [],
      dataDir: "/var/lib/dokku/services/postgres/pr5-p1/data",
      configDir: "/var/lib/dokku/services/postgres/pr5-p1/config",
      containerId: expect.stringMatching(/^[0-9a-f]{64}$/),
      internalIp: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/),
      maskedDsn: "postgres://postgres:********@dokku-postgres-pr5-p1:5432/pr5_p1",
      maskedExposedDsn: null,
      backupSchedule: null,
    });
    expect(services[1]).toMatchObject({ apps: ["hello-new"] });
  });

  test("a stopped service is `missing` to Dokku: no container, no address", async () => {
    const [service] = parseServices(
      "postgres",
      await fixture("postgres-info-stopped.ndjson"),
    );
    expect(service).toMatchObject({
      name: "pr5-s",
      status: "stopped",
      containerId: null,
      internalIp: null,
      exposedPorts: [],
    });
  });

  test("an exposed service lists its host ports and a second, masked connection string", async () => {
    const [service] = parseServices(
      "postgres",
      await fixture("postgres-info-exposed.ndjson"),
    );
    expect(service).toMatchObject({
      name: "pr5-p2",
      exposedPorts: ["5432->46761"],
      maskedExposedDsn: "postgres://postgres:********@dokku.localhost:46761/pr5_p2",
    });
  });

  test("redis uses the same shape with a user-less DSN", async () => {
    const [service] = parseServices("redis", await fixture("redis-info-all.ndjson"));
    expect(service).toMatchObject({
      type: "redis",
      version: "redis:8.10.1",
      maskedDsn: "redis://:********@dokku-redis-pr5-rprobe:6379",
    });
  });

  test("no services is Dokku's message, not an entry", async () => {
    expect(parseServices("postgres", await fixture("postgres-info-none.ndjson"))).toEqual(
      [],
    );
    expect(parseServices("postgres", "")).toEqual([]);
  });

  test("a status Dokku does not use is unknown, not running", () => {
    const [service] = parseServices(
      "redis",
      JSON.stringify({ service: "x", status: "restarting" }),
    );
    expect(service?.status).toBe("unknown");
  });

  test("no password survives parsing, in any field of any service", async () => {
    for (const name of [
      "postgres-info-all.ndjson",
      "postgres-info-stopped.ndjson",
      "postgres-info-exposed.ndjson",
      "redis-info-all.ndjson",
    ]) {
      const raw = await fixture(name);
      // The fixture does carry it, so the check below is not vacuous.
      expect(raw).toContain(password);
      const type = name.startsWith("redis") ? "redis" : "postgres";
      expect(JSON.stringify(parseServices(type, raw))).not.toContain(password);
    }
  });

  test("an exposed connection string is masked too", () => {
    const [service] = parseServices(
      "postgres",
      JSON.stringify({
        service: "x",
        dsn: "postgres://postgres:secret1@dokku-postgres-x:5432/x",
        "exposed-dsn": "postgres://postgres:secret2@192.168.2.13:5432/x",
      }),
    );
    expect(JSON.stringify(service)).not.toMatch(/secret/);
    expect(service?.maskedExposedDsn).toBe(
      "postgres://postgres:********@192.168.2.13:5432/x",
    );
  });
});

describe("masking", () => {
  test("maskDsn hides the password and keeps scheme, user, host, port and database", () => {
    expect(maskDsn("postgres://u:pw@db:5432/app")).toBe(
      "postgres://u:********@db:5432/app",
    );
    expect(maskDsn("redis://:pw@cache:6379")).toBe("redis://:********@cache:6379");
    expect(maskDsn("mongodb://u:pw@m:27017/db?x=1")).toBe(
      "mongodb://u:********@m:27017/db?x=1",
    );
  });

  test("a string without a password is not shown as a connection string", () => {
    for (const dsn of ["", "-", "postgres://db:5432/app", "something else"]) {
      expect(maskDsn(dsn)).toBeNull();
    }
  });

  test("a password may hold @, /, : and spaces, and a string may name several hosts", () => {
    for (const [secret, url] of [
      ["p@ss:word", "postgres://user:p@ss:word@h:5432/db"],
      ["pa/ss", "postgres://u:pa/ss@h/db"],
      ["sec ret", "postgres://u:sec ret@h:5432/db"],
      ["x@y", "mongodb://u:x@y@h1:27017,h2:27017/db?replicaSet=r"],
    ] as const) {
      const masked = maskSecrets(`DATABASE_URL:  ${url}`);
      expect(masked).not.toContain(secret);
      expect(masked).toContain(":********@");
      expect(maskDsn(url)).not.toContain(secret);
    }
    expect(maskSecrets("postgres://u:p@ss:word@h:5432/db")).toBe(
      "postgres://u:********@h:5432/db",
    );
    expect(maskSecrets("mongodb://u:pw@h1:27017,h2:27017/db")).toBe(
      "mongodb://u:********@h1:27017,h2:27017/db",
    );
  });

  test("every URL in a line is masked, and text that has no password is left alone", () => {
    const line =
      "a postgres://u:one@h/x then redis://:two@c:6379 and https://example.com/a?b=c";
    expect(maskSecrets(line)).toBe(
      "a postgres://u:********@h/x then redis://:********@c:6379 and https://example.com/a?b=c",
    );
    expect(maskSecrets("l1 postgres://u:one@h\nl2 redis://:two@c")).toBe(
      "l1 postgres://u:********@h\nl2 redis://:********@c",
    );
    expect(maskSecrets("see https://github.com/dokku/dokku-postgres.git")).toBe(
      "see https://github.com/dokku/dokku-postgres.git",
    );
  });

  test("maskSecrets cleans a line of Dokku output wherever the URL sits", () => {
    expect(
      maskSecrets(
        "       DATABASE_URL:  postgres://postgres:abc123@dokku-postgres-x:5432/x",
      ),
    ).toBe("       DATABASE_URL:  postgres://postgres:********@dokku-postgres-x:5432/x");
    expect(maskSecrets("Dsn: redis://:abc@h:6379 and postgres://u:def@h/db")).toBe(
      "Dsn: redis://:********@h:6379 and postgres://u:********@h/db",
    );
    const plain = "-----> Restarting app hello (see https://dokku.com/docs)";
    expect(maskSecrets(plain)).toBe(plain);
  });
});
