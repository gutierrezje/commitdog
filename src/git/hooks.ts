import { readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

const HOOK_MARKER = "# commitdog-managed";

/**
 * Get the .git/hooks directory path
 */
async function getHooksDir(): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--git-dir"]);
  return join(stdout.trim(), "hooks");
}

/**
 * Install the post-commit hook. Runs commitdog in the background (non-blocking).
 */
export async function installHook(): Promise<string> {
  const hooksDir = await getHooksDir();
  const hookPath = join(hooksDir, "post-commit");

  // Check if hook already exists and is not ours
  if (existsSync(hookPath)) {
    const existing = await readFile(hookPath, "utf-8");
    if (existing.includes(HOOK_MARKER)) {
      return hookPath; // Already installed
    }
    // Append to existing hook
    const updated = existing + "\n\n" + generateHookScript();
    await writeFile(hookPath, updated, "utf-8");
  } else {
    await writeFile(hookPath, generateHookScript(), "utf-8");
  }

  await chmod(hookPath, 0o755);
  return hookPath;
}

/**
 * Uninstall the post-commit hook
 */
export async function uninstallHook(): Promise<boolean> {
  const hooksDir = await getHooksDir();
  const hookPath = join(hooksDir, "post-commit");

  if (!existsSync(hookPath)) return false;

  const content = await readFile(hookPath, "utf-8");
  if (!content.includes(HOOK_MARKER)) return false;

  // If the entire file is our hook, remove it
  const lines = content.split("\n");
  const ourStart = lines.findIndex((l) => l.includes(HOOK_MARKER));
  const ourEnd = lines.findIndex((l, i) => i > ourStart && l.includes("# end-commitdog"));

  if (ourStart === 0 && (ourEnd === -1 || ourEnd === lines.length - 1)) {
    // Whole file is ours
    await unlink(hookPath);
  } else {
    // Remove just our section
    const cleaned = [...lines.slice(0, ourStart), ...lines.slice(ourEnd + 1)].join("\n").trim();
    if (cleaned === "#!/bin/sh" || cleaned === "") {
      await unlink(hookPath);
    } else {
      await writeFile(hookPath, cleaned + "\n", "utf-8");
    }
  }

  return true;
}

/**
 * Check if the hook is installed
 */
export async function isHookInstalled(): Promise<boolean> {
  const hooksDir = await getHooksDir();
  const hookPath = join(hooksDir, "post-commit");
  if (!existsSync(hookPath)) return false;
  const content = await readFile(hookPath, "utf-8");
  return content.includes(HOOK_MARKER);
}

function generateHookScript(): string {
  return `#!/bin/sh
${HOOK_MARKER}
# Run commitdog review in the background (non-blocking)
if command -v commitdog >/dev/null 2>&1; then
  commitdog review --hook &
fi
# end-commitdog
`;
}
