import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "./agent.js";

describe("buildReviewPrompt", () => {
  it("uses the same root-commit-safe command as the diff reader", () => {
    const prompt = buildReviewPrompt("last-commit", []);

    expect(prompt).toContain("git show --format= --stat --patch HEAD");
    expect(prompt).not.toContain("git diff HEAD~1..HEAD");
  });
});
