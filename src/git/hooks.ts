import { readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

const HOOK_MARKER = "# commitdog-managed";
const HOOK_END_MARKER = "# end-commitdog";
const HOOK_SHEBANG = "#!/bin/sh";

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
  const command = await resolveHookCommand();

  // Check if hook already exists and is not ours
  if (existsSync(hookPath)) {
    const existing = await readFile(hookPath, "utf-8");
    const base = existing.includes(HOOK_MARKER)
      ? removeManagedSection(existing)
      : existing.trimEnd();
    const hookSection = generateManagedSection(command);
    const updated =
      base && !isOnlyShebangs(base) ? `${base}\n\n${hookSection}` : generateHookScript(command);
    await writeFile(hookPath, updated, "utf-8");
  } else {
    await writeFile(hookPath, generateHookScript(command), "utf-8");
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

  const cleaned = removeManagedSection(content);
  if (isOnlyShebangs(cleaned) || cleaned === "") {
    await unlink(hookPath);
  } else {
    await writeFile(hookPath, cleaned + "\n", "utf-8");
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

interface HookCommand {
  commitdog: string;
}

async function resolveHookCommand(): Promise<HookCommand> {
  return {
    commitdog: await resolveCommand("commitdog"),
  };
}

async function resolveCommand(command: string): Promise<string> {
  try {
    const { stdout } = await execa("sh", ["-c", `command -v ${command}`]);
    return stdout.trim() || command;
  } catch {
    return command;
  }
}

function removeManagedSection(content: string): string {
  const lines = content.split("\n");
  const ourStart = lines.findIndex((line) => line.includes(HOOK_MARKER));
  if (ourStart === -1) return content.trim();

  const ourEnd = lines.findIndex(
    (line, index) => index > ourStart && line.includes(HOOK_END_MARKER),
  );
  const endIndex = ourEnd === -1 ? ourStart : ourEnd;
  return [...lines.slice(0, ourStart), ...lines.slice(endIndex + 1)].join("\n").trim();
}

function isOnlyShebangs(content: string): boolean {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => line === HOOK_SHEBANG);
}

function generateHookScript(command: HookCommand): string {
  return `${HOOK_SHEBANG}
${generateManagedSection(command)}`;
}

function generateManagedSection(command: HookCommand): string {
  const quotedCommitDog = shellQuote(command.commitdog);
  return `${HOOK_MARKER}
# Run commitdog review in the background (non-blocking)
COMMITDOG_LOG_DIR=".commitdog"
COMMITDOG_LOG_FILE="$COMMITDOG_LOG_DIR/hook.log"
mkdir -p "$COMMITDOG_LOG_DIR"

if [ -x ${quotedCommitDog} ]; then
  nohup ${quotedCommitDog} review --hook >>"$COMMITDOG_LOG_FILE" 2>&1 </dev/null &
elif command -v commitdog >/dev/null 2>&1; then
  nohup commitdog review --hook >>"$COMMITDOG_LOG_FILE" 2>&1 </dev/null &
fi
${HOOK_END_MARKER}
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
