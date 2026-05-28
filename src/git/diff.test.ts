import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.js";

describe("parseDiff", () => {
  it("parses standard unquoted paths and counts additions and deletions", () => {
    const rawDiff = [
      "diff --git a/src/cli.ts b/src/cli.ts",
      "index 1234567..89abcde 100644",
      "--- a/src/cli.ts",
      "+++ b/src/cli.ts",
      "@@ -10,3 +10,4 @@",
      " unchanged line",
      "-deleted line",
      "+added line 1",
      "+added line 2",
    ].join("\n");

    const result = parseDiff(rawDiff);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("src/cli.ts");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it("parses quoted paths with spaces", () => {
    const rawDiff = [
      'diff --git "a/src/my folder/file name.ts" "b/src/my folder/file name.ts"',
      "index 1234567..89abcde 100644",
      '--- "a/src/my folder/file name.ts"',
      '+++ "b/src/my folder/file name.ts"',
      "@@ -1,2 +1,3 @@",
      " unchanged",
      "+added line",
    ].join("\n");

    const result = parseDiff(rawDiff);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("src/my folder/file name.ts");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(0);
  });

  it("parses quoted paths with escaped characters", () => {
    const rawDiff = [
      'diff --git "a/src/my \\"cool\\" file.ts" "b/src/my \\"cool\\" file.ts"',
      "index 1234567..89abcde 100644",
      "@@ -1,1 +1,2 @@",
      " unchanged",
      "+added",
    ].join("\n");

    const result = parseDiff(rawDiff);

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe('src/my "cool" file.ts');
    expect(file.status).toBe("modified");
  });

  it("parses combined merge conflict diffs (diff --cc and diff --combined)", () => {
    const rawDiffCC = [
      'diff --cc "src/conflict file.ts"',
      "index 1234567,7654321..89abcde",
      "--- a/src/conflict file.ts",
      "+++ b/src/conflict file.ts",
      "@@@ -1,2 +1,3 @@@",
      "  unchanged",
      "++added in merge",
    ].join("\n");

    const resultCC = parseDiff(rawDiffCC);

    expect(resultCC.files).toHaveLength(1);
    const fileCC = resultCC.files[0]!;
    expect(fileCC.path).toBe("src/conflict file.ts");
    expect(fileCC.status).toBe("modified");
    expect(fileCC.additions).toBe(1);

    const rawDiffCombined = [
      "diff --combined src/combined.ts",
      "index 1234567,7654321..89abcde",
      "@@@ -1,2 +1,3 @@@",
      "  unchanged",
      "++added",
    ].join("\n");

    const resultCombined = parseDiff(rawDiffCombined);

    expect(resultCombined.files).toHaveLength(1);
    const fileCombined = resultCombined.files[0]!;
    expect(fileCombined.path).toBe("src/combined.ts");
    expect(fileCombined.status).toBe("modified");
  });

  it("parses renames with unquoted and quoted target paths", () => {
    const rawDiffRenameQuoted = [
      "diff --git a/old_name.ts b/new_name.ts",
      "similarity index 85%",
      "rename from old_name.ts",
      'rename to "src/new name.ts"',
    ].join("\n");

    const resultRenameQuoted = parseDiff(rawDiffRenameQuoted);

    expect(resultRenameQuoted.files).toHaveLength(1);
    const file = resultRenameQuoted.files[0]!;
    expect(file.path).toBe("src/new name.ts");
    expect(file.status).toBe("renamed");
  });

  it("handles mode-only changes", () => {
    const rawDiffMode = [
      "diff --git a/foo.sh b/foo.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");

    const resultMode = parseDiff(rawDiffMode);

    expect(resultMode.files).toHaveLength(1);
    const file = resultMode.files[0]!;
    expect(file.path).toBe("foo.sh");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
  });
});
