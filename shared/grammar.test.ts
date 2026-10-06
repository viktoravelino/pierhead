import { describe, expect, test } from "bun:test";
import {
  formatPortMapping,
  isAppName,
  isContainerPath,
  isCpu,
  isDomain,
  isExistingStorageName,
  isGitRef,
  isGitUrl,
  isImageRef,
  isMemory,
  isNetworkAlias,
  isNetworkName,
  isNewAppName,
  isNewProcessType,
  isProcessCount,
  isRepoPath,
  isSafeArg,
  isSafeContainerPath,
  isSafeDomain,
  isStorageName,
  parsePortMapping,
  portMappingProblem,
  reusedPort,
  storageNameOf,
} from "./grammar";

describe("app names", () => {
  test("accepts what apps:create accepts", () => {
    for (const name of ["hello", "1abc", "my-app.v2"]) expect(isAppName(name)).toBe(true);
  });

  test("refuses flags, uppercase, underscores and spaces", () => {
    for (const name of ["", "-h", "Bad_Name", "a b", "a;b", "../etc"]) {
      expect(isAppName(name)).toBe(false);
    }
  });

  test("a new app also fits a DNS label", () => {
    expect(isNewAppName("a".repeat(63))).toBe(true);
    expect(isNewAppName("a".repeat(64))).toBe(false);
  });
});

describe("domains", () => {
  test("accepts hostnames and wildcards", () => {
    for (const d of [
      "example.com",
      "pr1.dokku.localhost",
      "*.example.com",
      "a-b.c1.io",
      "x",
    ]) {
      expect(isDomain(d)).toBe(true);
    }
  });

  // Each of these is something `domains:add` accepted on Dokku 0.38.
  test("refuses what Dokku wrongly accepts", () => {
    for (const d of [
      "-h",
      "bad domain",
      "http://example.com",
      "example.com:8080",
      "example.com/path",
      "Example.com",
      "a..b",
      "-a.com",
      "a-.com",
      "*.*.com",
      "a.com;ls",
      "",
    ]) {
      expect(isDomain(d)).toBe(false);
    }
  });

  test("refuses labels and names that are too long", () => {
    expect(isDomain(`${"a".repeat(64)}.com`)).toBe(false);
    expect(isDomain(Array(60).fill("abcd").join("."))).toBe(false);
  });
});

describe("port mappings", () => {
  test("round-trips scheme:host:container", () => {
    const mapping = { scheme: "http", host: 8081, container: 5000 };
    expect(parsePortMapping("http:8081:5000")).toEqual(mapping);
    expect(formatPortMapping(mapping)).toBe("http:8081:5000");
  });

  test("refuses malformed or out-of-range mappings", () => {
    for (const text of [
      "",
      "80",
      "http:80",
      "http:80:5000:1",
      "ftp:80:5000",
      "http:0:5000",
      "http:80:65536",
      "http:eighty:5000",
      "http:80:-1",
      "http:8 0:5000",
      ":80:5000",
    ]) {
      expect(parsePortMapping(text)).toBeNull();
    }
  });

  test("explains a bad mapping object", () => {
    expect(portMappingProblem({ scheme: "tcp", host: 80, container: 80 })).toMatch(
      /scheme/,
    );
    expect(portMappingProblem({ scheme: "http", host: 1.5, container: 80 })).toMatch(
      /Ports/,
    );
    expect(
      portMappingProblem({ scheme: "http", host: Number.NaN, container: 80 }),
    ).toMatch(/Ports/);
    expect(portMappingProblem({ scheme: "https", host: 443, container: 80 })).toBeNull();
  });

  test("finds a scheme:host used twice, which Dokku refuses", () => {
    const a = { scheme: "http", host: 80, container: 5000 };
    expect(reusedPort([a, { ...a, container: 6000 }])).toBe("http:80");
    expect(reusedPort([a, { ...a, scheme: "https" }, { ...a, host: 81 }])).toBeNull();
  });
});

// The grammar for what Dokku already holds: anything it accepted, if a shell cannot misread it.
describe("safe arguments", () => {
  test("accepts values Dokku may hold that the strict grammars refuse", () => {
    for (const arg of ["Example.COM", "my_host.example", "tcp", "a:b", "x.y@z"]) {
      expect(isSafeArg(arg)).toBe(true);
    }
    expect(isSafeDomain("*.Example_Host.com")).toBe(true);
    expect(parsePortMapping("tcp:80:80")).toBeNull();
    expect(parsePortMapping("tcp:80:80", false)).toEqual({
      scheme: "tcp",
      host: 80,
      container: 80,
    });
  });

  test("refuses flags, whitespace, quotes and shell syntax", () => {
    for (const arg of [
      "",
      "-h",
      "--force",
      "a b",
      "a\tb",
      "a'b",
      'a"b',
      "$HOME",
      "a`b`",
      "a;b",
      "a|b",
      "a&b",
      "a\\b",
      "a*b",
      "a(b)",
      "a>b",
    ]) {
      expect(isSafeArg(arg)).toBe(false);
    }
    expect(isSafeDomain("*.")).toBe(false);
    expect(isSafeDomain("*.-x")).toBe(false);
    expect(isSafeArg("a".repeat(254))).toBe(false);
  });

  test("a loose port mapping still needs numeric ports and no colon in the scheme", () => {
    expect(
      portMappingProblem({ scheme: "tcp", host: 80, container: 80 }, false),
    ).toBeNull();
    expect(portMappingProblem({ scheme: "a;b", host: 80, container: 80 }, false)).toMatch(
      /scheme/,
    );
    expect(portMappingProblem({ scheme: "tcp", host: 0, container: 80 }, false)).toMatch(
      /Ports/,
    );
  });
});

describe("process types and counts", () => {
  test("new types are lowercase, never a flag", () => {
    for (const t of ["web", "worker_2", "a-b"]) expect(isNewProcessType(t)).toBe(true);
    for (const t of ["We-b", "-w", "w b", "", "a=b", "a".repeat(64)]) {
      expect(isNewProcessType(t)).toBe(false);
    }
  });

  test("counts are whole numbers from 0 to 20", () => {
    for (const n of [0, 1, 20]) expect(isProcessCount(n)).toBe(true);
    for (const n of [-1, 21, 1.5, Number.NaN]) expect(isProcessCount(n)).toBe(false);
  });
});

describe("networks", () => {
  test("names and aliases", () => {
    for (const n of ["a", "my_net.v2", "a-b"]) expect(isNetworkName(n)).toBe(true);
    for (const n of ["", "A", "-h", "a b", "a/b", "n".repeat(64)]) {
      expect(isNetworkName(n)).toBe(false);
    }
    expect(isNetworkAlias("api-2")).toBe(true);
    for (const a of ["Api", "a.b", "-a", "a-", "a_b", "x".repeat(64)]) {
      expect(isNetworkAlias(a)).toBe(false);
    }
  });
});

describe("repository paths", () => {
  test("relative, no .., no empty or dot segments", () => {
    for (const p of ["backend", "apps/web", "docker/Dockerfile.prod", "a_b-c/d.e"]) {
      expect(isRepoPath(p)).toBe(true);
    }
    for (const p of [
      "",
      "..",
      "../x",
      "a/../b",
      "/etc",
      "-h",
      "a//b",
      "a/",
      ".",
      "./a",
      "a b",
      "a;b",
      "a\\b",
    ]) {
      expect(isRepoPath(p)).toBe(false);
    }
  });
});

describe("resources", () => {
  test("memory is digits with an optional b, k, m or g", () => {
    for (const m of ["256m", "1g", "512", "6m", "6", "6144k", "6291456b"]) {
      expect(isMemory(m)).toBe(true);
    }
    for (const m of ["", "lots", "-1", "1.5g", "256mb", "256 m", "m", "1G"]) {
      expect(isMemory(m)).toBe(false);
    }
  });

  test("memory below Docker's 6 MiB minimum is refused", () => {
    for (const m of ["5m", "0", "0m", "5", "64k", "100b", "6143k", "6291455b"]) {
      expect(isMemory(m)).toBe(false);
    }
  });

  test("cpu is a number with at most two decimals", () => {
    for (const c of ["0.5", "2", "1.25", "0"]) expect(isCpu(c)).toBe(true);
    for (const c of ["", "-1", ".5", "1.234", "1e2", "abc", "1,5"]) {
      expect(isCpu(c)).toBe(false);
    }
  });
});

describe("storage", () => {
  test("a new directory name is lowercase without dots; an existing one may have them", () => {
    expect(isStorageName("my_data-2")).toBe(true);
    for (const n of ["", "A", "a.b", "-x", "../x", "a/b", "a b"]) {
      expect(isStorageName(n)).toBe(false);
    }
    expect(isExistingStorageName("old.dir")).toBe(true);
    for (const n of ["", ".", "..", "../x", "a/b", "-x"]) {
      expect(isExistingStorageName(n)).toBe(false);
    }
  });

  test("only a directory directly under the storage root has a name", () => {
    expect(storageNameOf("/var/lib/dokku/data/storage/my-data")).toBe("my-data");
    for (const path of [
      "/opt/data",
      "/var/lib/dokku/data/storage",
      "/var/lib/dokku/data/storage/",
      "/var/lib/dokku/data/storage/a/b",
      "/var/lib/dokku/data/storage/..",
      "/var/lib/dokku/data/storage/../etc",
      "/var/lib/dokku/data/storage-other/x",
    ]) {
      expect(storageNameOf(path)).toBeNull();
    }
  });

  test("container paths are absolute and clean; stored ones may use more characters but not : or ..", () => {
    for (const p of ["/data", "/var/lib/app.d/x_y-z"])
      expect(isContainerPath(p)).toBe(true);
    for (const p of [
      "",
      "/",
      "data",
      "/a/../b",
      "/a//b",
      "/a/",
      "/a b",
      "/a:ro",
      "/a;b",
      "/a*",
    ]) {
      expect(isContainerPath(p)).toBe(false);
    }
    expect(isSafeContainerPath("/data")).toBe(true);
    expect(isSafeContainerPath("/a@b")).toBe(true);
    for (const p of ["data", "/a/../b", "/a:ro", "/a b", "/a;b", "/a'b"]) {
      expect(isSafeContainerPath(p)).toBe(false);
    }
  });
});

describe("image references", () => {
  test("accepts registry, path, tag and digest forms", () => {
    for (const image of [
      "nginx",
      "nginx:alpine",
      "library/nginx:1.27-alpine",
      "ghcr.io/dokku/smoke-test_app:v1.2.3",
      "localhost:5000/team/app:dev",
      `nginx@sha256:${"a".repeat(64)}`,
      `nginx:1.27@sha256:${"0".repeat(64)}`,
    ]) {
      expect(isImageRef(image)).toBe(true);
    }
  });

  test("refuses flags, shell text, spaces, uppercase names and malformed tags", () => {
    for (const image of [
      "",
      "-x",
      "--rm",
      "nginx:alpine; rm",
      "nginx alpine",
      "nginx\nalpine",
      "$(id)",
      "Nginx",
      "nginx:",
      "nginx:-x",
      "nginx@sha256:abc",
      "nginx//x",
      "/nginx",
      `${"a".repeat(256)}`,
    ]) {
      expect(isImageRef(image)).toBe(false);
    }
  });
});

describe("git URLs and refs", () => {
  test("accepts https URLs and git@host:path", () => {
    for (const url of [
      "https://github.com/dokku/smoke-test-app",
      "https://github.com/crccheck/docker-hello-world.git",
      "https://git.example.com:8443/team/sub/repo",
      "git@github.com:owner/repo.git",
    ]) {
      expect(isGitUrl(url)).toBe(true);
    }
  });

  test("refuses local paths, other schemes, credentials, flags and shell text", () => {
    for (const url of [
      "",
      "file:///tmp",
      "file:///etc/passwd",
      "/tmp/x",
      "./repo",
      "-x",
      "--upload-pack=x",
      "ssh://git@host/owner/repo",
      "git://host/owner/repo",
      "http://github.com/owner/repo",
      "https://user:token@github.com/owner/repo",
      "https://github.com",
      "https://github.com/owner/repo?x=1",
      "https://github.com/owner/repo#main",
      "https://github.com/owner/repo extra",
      "https://github.com/../repo",
      "https://github.com/owner/repo;rm",
      "git@host:/abs/path",
      "git@host:../x",
      "evil@host:owner/repo",
    ]) {
      expect(isGitUrl(url)).toBe(false);
    }
  });

  test("refs are branch, tag or sha words, never a flag", () => {
    for (const ref of [
      "main",
      "release/1.2",
      "v1.0.0",
      "5c8a5e42bbd7fae98bd657fb17f41c6019b303f9",
    ]) {
      expect(isGitRef(ref)).toBe(true);
    }
    for (const ref of [
      "",
      "-x",
      "a b",
      "a;b",
      "a..b",
      "../x",
      "a//b",
      "a/",
      "$HEAD",
      "a:b",
    ]) {
      expect(isGitRef(ref)).toBe(false);
    }
  });
});
