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
      ["domains:add", "hello"],
      ["ports:add", "hello", "http:80"],
      ["ports:add", "hello", "http:80:5000;ls"],
      [],
    ]) {
      expect(buildStep(argv).ok).toBe(false);
    }
  });
});
