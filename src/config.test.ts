import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig, type CommitDogConfig } from "./config.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("config", () => {
  it("saves back to the discovered parent config", async () => {
    const root = await mkdtemp(join(tmpdir(), "commitdog-config-"));
    tempDirs.push(root);
    const child = join(root, "packages", "app");
    await mkdir(child, { recursive: true });

    const parentConfig = join(root, ".commitdog.yml");
    await writeFile(
      parentConfig,
      [
        "model: provider/original",
        "server:",
        "  port: 4096",
        "  auto_start: true",
        "include:",
        "  - '**/*'",
        "exclude: []",
        "rules: []",
      ].join("\n"),
      "utf-8",
    );

    process.chdir(child);

    const config: CommitDogConfig = {
      ...(await loadConfig()),
      model: "provider/updated",
    };
    const savedPath = await saveConfig(config);

    expect(await realpath(savedPath)).toBe(await realpath(parentConfig));
    expect(await readFile(parentConfig, "utf-8")).toContain("provider/updated");
  });

  it("reports malformed yaml instead of silently using defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "commitdog-config-"));
    tempDirs.push(root);
    await writeFile(join(root, ".commitdog.yml"), "model: [broken", "utf-8");
    process.chdir(root);

    await expect(loadConfig()).rejects.toThrow("Failed to load");
  });
});
