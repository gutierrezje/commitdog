import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { installHook, generateManagedSection } from "./hooks.js";

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
    expect(hook).toContain("review --hook --quick >>");
    expect(hook).toContain("review started at $(date)");
    expect(hook).not.toContain("commitdog review --hook &");
  });
});

describe("generateManagedSection", () => {
  it("omits -x check and uses command -v directly for bare command names", () => {
    const section = generateManagedSection({ commitdog: "commitdog" });
    expect(section).not.toContain("[ -x 'commitdog' ]");
    expect(section).toContain("command -v 'commitdog'");
  });

  it("includes -x check for absolute or relative paths with separators", () => {
    const section = generateManagedSection({ commitdog: "/usr/local/bin/commitdog" });
    expect(section).toContain("[ -x '/usr/local/bin/commitdog' ]");
    expect(section).toContain("command -v commitdog");
  });

  it("does not report a started review when no commitdog command can run", async () => {
    const root = await mkdtemp(join(tmpdir(), "commitdog-hooks-"));
    tempDirs.push(root);
    const scriptPath = join(root, "post-commit");
    await writeFile(
      scriptPath,
      ["#!/bin/sh", generateManagedSection({ commitdog: "/missing/commitdog" })].join("\n"),
      "utf-8",
    );

    const { stdout } = await execa("sh", [scriptPath], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
    });
    const log = await readFile(join(root, ".commitdog", "hook.log"), "utf-8");

    expect(stdout).toContain("commitdog: review not started");
    expect(stdout).not.toContain("commitdog: review started in background");
    expect(log).toContain("commitdog: review not started");
    expect(log).not.toContain("commitdog: review started at");
  });
});
