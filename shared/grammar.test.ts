import { describe, expect, test } from "bun:test";
import {
  formatPortMapping,
  isAppName,
  isDomain,
  isNewAppName,
  isSafeArg,
  isSafeDomain,
  parsePortMapping,
  portMappingProblem,
  reusedPort,
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
