import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "./agent.js";

describe("buildReviewPrompt", () => {
  it("uses provided local context before asking for tool follow-up", () => {
    const prompt = buildReviewPrompt("last-commit", [], undefined, undefined, "LOCAL CONTEXT");

    expect(prompt).toContain("Review the last commit.");
    expect(prompt).toContain("LOCAL CONTEXT");
    expect(prompt).toContain("Use this context first");
    expect(prompt).toContain("Only call tools for narrow follow-up");
  });
});
