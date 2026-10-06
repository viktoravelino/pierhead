import { describe, expect, test } from "bun:test";
import { shellQuote } from "./dokku";

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
