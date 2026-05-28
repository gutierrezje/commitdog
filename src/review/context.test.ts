import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { buildReviewContext, renderReviewContext } from "./context.js";
import type { CommitDogConfig } from "../config.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const config: CommitDogConfig = {
  model: "provider/model",
  server: {
    port: 4096,
    auto_start: true,
  },
  include: ["**/*"],
  exclude: [],
  rules: [],
};

describe("buildReviewContext", () => {
  it("collects staged diff, changed file content, related tests, and reference hints", async () => {
    const root = await mkdtemp(join(tmpdir(), "commitdog-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await mkdir("src");
    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 1;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await writeFile(
      "src/example.test.ts",
      "import { calculateTotal } from './example.js';\n",
      "utf-8",
    );
    await writeFile(
      "src/consumer.ts",
      "import { calculateTotal } from './example.js';\nconsole.log(calculateTotal(1));\n",
      "utf-8",
    );
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=CommitDog Test",
      "-c",
      "user.email=commitdog@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 2;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"]);

    const context = await buildReviewContext("staged", config);
    const rendered = renderReviewContext(context);

    expect(context.diff.files).toHaveLength(1);
    expect(context.changedFiles[0].symbols).toContain("calculateTotal");
    expect(rendered).toContain("src/example.ts");
    expect(rendered).toContain("src/example.test.ts");
    expect(rendered).toContain("src/consumer.ts");
    expect(rendered).toContain("return value + 2");
  });
});
