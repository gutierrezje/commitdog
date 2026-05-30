import { readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { ensureCommitDogDir } from "../config.js";

const HOOK_MARKER = "# commitdog-managed";
const HOOK_END_MARKER = "# end-commitdog";
const HOOK_SHEBANG = "#!/bin/sh";
const LAST_HOOK_STATUS = ".commitdog/last-hook-status.json";
const HOOK_LOG_FILE = ".commitdog/hook.log";

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

export interface HookStatus {
  installed: boolean;
  stale: boolean;
  reason?: string;
}

export interface HookFailure {
  exitCode: number;
  timestamp: string;
}

/**
 * Check if the background post-commit hook failed recently.
 * Returns failure details only for non-zero exits within the last hour.
 */
export async function checkRecentHookFailure(): Promise<HookFailure | undefined> {
  const statusPath = join(process.cwd(), LAST_HOOK_STATUS);
  if (!existsSync(statusPath)) {
    return undefined;
  }

  try {
    const raw = await readFile(statusPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as any).exitCode !== "number" ||
      typeof (parsed as any).timestamp !== "string"
    ) {
      return undefined;
    }

    const { exitCode, timestamp } = parsed as HookFailure;
    if (exitCode === 0) {
      return undefined;
    }

    const failureTime = new Date(timestamp).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    if (Number.isNaN(failureTime) || failureTime < oneHourAgo) {
      return undefined;
    }

    return { exitCode, timestamp };
  } catch {
    return undefined;
  }
}

export async function runHookReview(): Promise<void> {
  const logFile = join(process.cwd(), HOOK_LOG_FILE);
  await ensureCommitDogDir();

  const outFd = openSync(logFile, "a");
  try {
    writeSync(
      outFd,
      `commitdog: review started at ${new Date().toString()}; latest report: .commitdog/reviews/latest.md\n`,
    );

    const subprocess = execa(
      process.execPath,
      [fileURLToPath(import.meta.url), "review", "--hook", "--quick"],
      {
        detached: true,
        cleanup: false,
        cwd: process.cwd(),
        stdio: ["ignore", outFd, outFd] as any,
        env: {
          ...process.env,
          PATH: buildHookPath(process.env["PATH"] ?? ""),
        },
      },
    );
    void subprocess.catch(() => {});
    subprocess.unref();

    console.log(
      `commitdog: review started in background; log: ${HOOK_LOG_FILE}; latest report: .commitdog/reviews/latest.md`,
    );
  } finally {
    closeSync(outFd);
  }
}

/**
 * Check if the installed hook matches what the current generator would produce.
 * Returns stale=true if the managed section differs (e.g., missing --quick flag,
 * outdated binary path, or changed script logic).
 */
export async function checkHookStale(): Promise<HookStatus> {
  let hooksDir: string;
  try {
    hooksDir = await getHooksDir();
  } catch {
    return { installed: false, stale: false, reason: "Not a git repository" };
  }

  const hookPath = join(hooksDir, "post-commit");

  if (!existsSync(hookPath)) {
    return { installed: false, stale: false, reason: "No post-commit hook found" };
  }

  let content: string;
  try {
    content = await readFile(hookPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: true, stale: false, reason: `Cannot read hook file: ${message}` };
  }

  if (!content.includes(HOOK_MARKER)) {
    return { installed: false, stale: false, reason: "Hook exists but is not commitdog-managed" };
  }

  let command: HookCommand;
  try {
    command = await resolveHookCommand();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: true, stale: false, reason: `Cannot resolve commitdog command: ${message}` };
  }

  const expected = generateManagedSection(command);
  const actual = extractManagedSection(content);

  if (!actual) {
    return { installed: true, stale: true, reason: "Could not extract managed section" };
  }

  if (actual.trim() !== expected.trim()) {
    return { installed: true, stale: true, reason: "Managed section differs from current generator" };
  }

  return { installed: true, stale: false };
}

function extractManagedSection(content: string): string | undefined {
  const lines = content.split("\n");
  const ourStart = lines.findIndex((line) => line.includes(HOOK_MARKER));
  if (ourStart === -1) return undefined;

  const ourEnd = lines.findIndex(
    (line, index) => index > ourStart && line.includes(HOOK_END_MARKER),
  );
  if (ourEnd === -1) return undefined;

  return lines.slice(ourStart, ourEnd + 1).join("\n");
}

interface HookCommand {
  commitdog: string;
  node: string;
  cli: string;
  pathDirs: string[];
}

async function resolveHookCommand(): Promise<HookCommand> {
  const commitdog = await resolveCommand("commitdog");
  const opencode = await resolveCommand("opencode");
  const node = process.execPath;
  return {
    commitdog,
    node,
    cli: fileURLToPath(import.meta.url),
    pathDirs: uniqueDirs([node, commitdog, opencode]),
  };
}

function uniqueDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    if (path.includes("/") || path.includes("\\")) {
      dirs.add(dirname(path));
    }
  }
  return [...dirs];
}

function buildHookPath(existingPath: string): string {
  const command = resolveHookCommandSync();
  const prefix = command.pathDirs?.join(":");
  return prefix ? `${prefix}:${existingPath}` : existingPath;
}

function resolveHookCommandSync(): HookCommand {
  const node = process.execPath;
  return {
    commitdog: "commitdog",
    node,
    cli: fileURLToPath(import.meta.url),
    pathDirs: uniqueDirs([node]),
  };
}

async function resolveCommand(command: string): Promise<string> {
  const isWin = process.platform === "win32";
  try {
    if (isWin) {
      const { stdout } = await execa("where", [command]);
      const lines = stdout.trim().split("\r\n").map(l => l.trim()).filter(Boolean);
      return lines[0] || command;
    } else {
      const { stdout } = await execa("which", [command]);
      return stdout.trim() || command;
    }
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

export function generateManagedSection(command: HookCommand): string {
  const isPath = command.commitdog.includes("/") || command.commitdog.includes("\\");
  const quotedCommitDog = shellQuote(command.commitdog);
  const quotedNode = shellQuote(command.node);
  const quotedCli = shellQuote(command.cli);
  const pathPrefix = command.pathDirs.length ? command.pathDirs.join(":") : undefined;
  const commitdogPathFallback = isPath
    ? `elif [ -x ${quotedCommitDog} ]; then
  ${quotedCommitDog} hook-run
`
    : "";

  const runBlock = `if [ -x ${quotedNode} ] && [ -f ${quotedCli} ]; then
  ${quotedNode} ${quotedCli} hook-run
${commitdogPathFallback}elif command -v commitdog >/dev/null 2>&1; then
  commitdog hook-run
else
  echo "commitdog: review not started; commitdog command not found or not executable; log: $COMMITDOG_LOG_FILE"
  echo "commitdog: review not started at $(date); commitdog command not found or not executable" >>"$COMMITDOG_LOG_FILE"
fi`;

  return `${HOOK_MARKER}
# Run commitdog review in the background (non-blocking)
COMMITDOG_LOG_DIR=".commitdog"
COMMITDOG_LOG_FILE="$COMMITDOG_LOG_DIR/hook.log"
mkdir -p "$COMMITDOG_LOG_DIR"
${pathPrefix ? `PATH=${shellQuote(pathPrefix)}":$PATH"
export PATH
` : ""}

${runBlock}
${HOOK_END_MARKER}
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
