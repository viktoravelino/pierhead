import { describe, expect, test } from "bun:test";
import {
  configCommandLine,
  configValueProblem,
  isConfigKey,
  isManagedKey,
  parseConfigKeys,
  parseConfigSetBody,
  parseConfigValue,
} from "./config";

describe("isConfigKey", () => {
  test("accepts env var names", () => {
    for (const key of ["A", "_x", "DATABASE_URL", "a1_b2"]) {
      expect(isConfigKey(key)).toBe(true);
    }
  });

  test("rejects anything that is not a name, including shell and flag syntax", () => {
    for (const key of [
      "",
      "1A",
      "A-B",
      "A B",
      "A=B",
      "A;rm",
      "$(x)",
      "--global",
      "é",
      "A\n",
    ]) {
      expect(isConfigKey(key)).toBe(false);
    }
    expect(isConfigKey("A".repeat(256))).toBe(false);
  });
});

describe("isManagedKey", () => {
  test("Dokku's own keys are managed, lookalikes are not", () => {
    expect(isManagedKey("GIT_REV")).toBe(true);
    expect(isManagedKey("DOKKU_APP_RESTORE")).toBe(true);
    expect(isManagedKey("DOKKU_PROXY_PORT")).toBe(true);
    for (const key of ["GIT_REVISION", "MY_GIT_REV", "DOKKU", "dokku_x", "API_TOKEN"]) {
      expect(isManagedKey(key)).toBe(false);
    }
  });
});

describe("configValueProblem", () => {
  test("accepts spaces, equals signs and quotes in the middle", () => {
    for (const value of ["", 'a b=c "q" x', "it's $HOME `x` ; ok", 'a\\"b', "é✓"]) {
      expect(configValueProblem(value)).toBeNull();
    }
  });

  test("refuses line breaks and values Dokku 0.38 cannot read back", () => {
    for (const value of [
      "a\nb",
      "a\r\nb",
      "a\0b",
      "ends\\",
      'ends"',
      "x".repeat(32_769),
    ]) {
      expect(configValueProblem(value)).not.toBeNull();
    }
  });
});

describe("parseConfigKeys", () => {
  // `dokku config:keys hello-multi` over SSH, Dokku 0.38.31 (sorted, one per line).
  test("flags managed keys", () => {
    expect(parseConfigKeys("DATABASE_URL\nGIT_REV\nSITE_NAME")).toEqual([
      { key: "DATABASE_URL", managed: false },
      { key: "GIT_REV", managed: true },
      { key: "SITE_NAME", managed: false },
    ]);
  });

  test("an app with no variables prints nothing", () => {
    expect(parseConfigKeys("")).toEqual([]);
  });

  test("skips lines that are not names", () => {
    expect(parseConfigKeys("-----> Discarding unparseable entries\nA\n")).toEqual([
      { key: "A", managed: false },
    ]);
  });
});

describe("parseConfigValue", () => {
  // `dokku config:get hello GREETING`: the value and one newline.
  test("drops only the final newline", () => {
    expect(parseConfigValue("hello from pierhead\n")).toBe("hello from pierhead");
    expect(parseConfigValue(" padded \n")).toBe(" padded ");
    expect(parseConfigValue("\n")).toBe("");
    expect(parseConfigValue("")).toBe("");
  });
});

describe("parseConfigSetBody", () => {
  test("needs a string value and a boolean restart", () => {
    expect(parseConfigSetBody({ value: "x", restart: false })).toEqual({
      value: "x",
      restart: false,
    });
    for (const body of [
      null,
      "x",
      {},
      { value: "x" },
      { value: 1, restart: true },
      { value: "x", restart: "true" },
    ]) {
      expect(parseConfigSetBody(body)).toBeNull();
    }
  });
});

describe("configCommandLine", () => {
  test("masks the value and shows the restart flag", () => {
    expect(
      configCommandLine({ kind: "set", app: "hello", key: "A", restart: false }),
    ).toBe("dokku config:set --no-restart hello A=********");
    expect(
      configCommandLine({ kind: "unset", app: "hello", key: "A", restart: true }),
    ).toBe("dokku config:unset hello A");
  });
});
