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
    expect(hook).toContain("hook-run");
    expect(hook).toContain("PATH=");
    expect(hook).toContain("COMMITDOG_LOG_FILE");
    expect(hook).not.toContain("commitdog review --hook &");
  });
});

describe("generateManagedSection", () => {
  it("omits -x check and uses command -v directly for bare command names", () => {
    const section = generateManagedSection({
      commitdog: "commitdog",
      node: "/opt/node/bin/node",
      cli: "/usr/local/lib/commitdog/dist/cli.js",
      pathDirs: [],
    });
    expect(section).not.toContain("[ -x 'commitdog' ]");
    expect(section).toContain("command -v commitdog");
  });

  it("includes -x check for absolute or relative paths with separators", () => {
    const section = generateManagedSection({
      commitdog: "/usr/local/bin/commitdog",
      node: "/opt/node/bin/node",
      cli: "/usr/local/lib/commitdog/dist/cli.js",
      pathDirs: [],
    });
    expect(section).toContain("[ -x '/usr/local/bin/commitdog' ]");
    expect(section).toContain("command -v commitdog");
  });

  it("prefers the current node executable and extends PATH for hook environments", () => {
    const section = generateManagedSection({
      commitdog: "/usr/local/bin/commitdog",
      node: "/opt/node/bin/node",
      cli: "/usr/local/lib/commitdog/dist/cli.js",
      pathDirs: ["/opt/node/bin", "/opt/homebrew/bin"],
    });

    expect(section).toContain("PATH='/opt/node/bin:/opt/homebrew/bin'\":$PATH\"");
    expect(section).toContain("'/opt/node/bin/node' '/usr/local/lib/commitdog/dist/cli.js' hook-run");
    expect(section).toContain("elif [ -x '/usr/local/bin/commitdog' ]; then");
  });

  it("does not report a started review when no commitdog command can run", async () => {
    const root = await mkdtemp(join(tmpdir(), "commitdog-hooks-"));
    tempDirs.push(root);
    const scriptPath = join(root, "post-commit");
    await writeFile(
      scriptPath,
      [
        "#!/bin/sh",
        generateManagedSection({
          commitdog: "/missing/commitdog",
          node: "/missing/node",
          cli: "/missing/cli.js",
          pathDirs: [],
        }),
      ].join("\n"),
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
