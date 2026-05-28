import { describe, expect, it } from "vitest";
import { parseStructuredReview } from "./client.js";

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
