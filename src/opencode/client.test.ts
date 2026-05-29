import { describe, expect, it } from "vitest";
import { parseStructuredReview, looksLikeCompleteStructuredReview } from "./client.js";

describe("parseStructuredReview", () => {
  it("parses the strict marker format", () => {
    const report = parseStructuredReview(
      'FINAL_REVIEW_JSON\n{"summary":"Looks safe.","findings":[]}',
    );

    expect(report.summary).toBe("Looks safe.");
    expect(report.findings).toEqual([]);
  });

  it("falls back to a bare JSON object when the marker is missing", () => {
    const report = parseStructuredReview('{"summary":"No issues.","findings":[]}');

    expect(report.summary).toBe("No issues.");
    expect(report.findings).toEqual([]);
  });

  it("includes a raw response preview when parsing fails", () => {
    expect(() => parseStructuredReview("I could not review this change.")).toThrow(
      /Raw response preview: I could not review this change\./,
    );
  });
});

describe("looksLikeCompleteStructuredReview", () => {

  it("returns false if marker is missing", () => {
    expect(looksLikeCompleteStructuredReview('{"summary":"abc","findings":[]}')).toBe(false);
  });

  it("returns false if braces do not match (incomplete payload)", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[{"severity":"warning"';
    expect(looksLikeCompleteStructuredReview(text)).toBe(false);
  });

  it("returns false if candidate JSON has unmatched curly braces", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[{"id":1}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(false);
  });

  it("returns true for a structurally complete review object", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[]}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(true);
  });

  it("ignores mismatched braces inside string values (like evidence)", () => {
    const text = 'FINAL_REVIEW_JSON\n{"summary":"abc","findings":[],"evidence":"function foo() {"}';
    expect(looksLikeCompleteStructuredReview(text)).toBe(true);
  });
});
