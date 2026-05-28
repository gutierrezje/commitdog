import { describe, expect, it } from "vitest";
import { colorizeMarkdown } from "./formatter.js";

describe("colorizeMarkdown", () => {
  it("consumes full bold severity markers", () => {
    const output = colorizeMarkdown("**[ERROR]** broken\n**[WARNING]** risky\n**[INFO]** note");

    expect(output).toContain("[ERROR]");
    expect(output).toContain("[WARNING]");
    expect(output).toContain("[INFO]");
    expect(output).not.toContain("**");
  });

  it("formats severity lines that include file references", () => {
    const output = colorizeMarkdown("**[ERROR] src/config.ts:45**\nDescription");

    expect(output).toContain("[ERROR]");
    expect(output).toContain(" src/config.ts:45");
    expect(output).not.toContain("**");
  });

  it("formats regular bold markdown without leaking replacement tokens", () => {
    const output = colorizeMarkdown("Review **this file** please");

    expect(output).toContain("this file");
    expect(output).not.toContain("$1");
  });
});
