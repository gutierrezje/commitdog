import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { installHook } from "./hooks.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("installHook", () => {
  it("refreshes existing managed hooks with a detached logged runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "commitdog-hooks-"));
    tempDirs.push(root);
    await execa("git", ["init"], { cwd: root });

    const hookPath = join(root, ".git", "hooks", "post-commit");
    await writeFile(
      hookPath,
      [
        "#!/bin/sh",
        "# commitdog-managed",
        "if command -v commitdog >/dev/null 2>&1; then",
        "  commitdog review --hook &",
        "fi",
        "# end-commitdog",
        "",
      ].join("\n"),
      "utf-8",
    );

    process.chdir(root);
    await installHook();

    const hook = await readFile(hookPath, "utf-8");
    expect(hook.match(/^#!\/bin\/sh/gm)).toHaveLength(1);
    expect(hook).toContain("nohup");
    expect(hook).toContain("COMMITDOG_LOG_FILE");
    expect(hook).toContain(" review --hook >>");
    expect(hook).not.toContain("commitdog review --hook &");
  });
});
