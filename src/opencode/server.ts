import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureCommitDogDir } from "../config.js";

const HEALTH_TIMEOUT_MS = 2000;
const STARTUP_WAIT_MS = 3000;
const MAX_RETRIES = 10;

/**
 * Check if an OpenCode server is running on the given port
 */
export async function isServerRunning(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure an OpenCode server is running. Connects to existing or spawns new.
 * Returns the base URL.
 */
export async function ensureServer(port: number): Promise<string> {
  const baseUrl = `http://127.0.0.1:${port}`;

  // Check if already running
  if (await isServerRunning(port)) {
    return baseUrl;
  }

  // Spawn a new server
  await spawnServer(port);

  // Wait for it to be ready
  for (let i = 0; i < MAX_RETRIES; i++) {
    await sleep(STARTUP_WAIT_MS / MAX_RETRIES);
    if (await isServerRunning(port)) {
      return baseUrl;
    }
  }

  // Try a bit longer
  await sleep(STARTUP_WAIT_MS);
  if (await isServerRunning(port)) {
    return baseUrl;
  }

  throw new Error(
    `Failed to start OpenCode server on port ${port}. Is opencode installed? (npm i -g opencode-ai)`,
  );
}

/**
 * Spawn opencode serve as a detached background process
 */
async function spawnServer(port: number): Promise<void> {
  const dir = await ensureCommitDogDir();
  const pidFile = join(dir, "server.pid");

  // Check if opencode is installed
  try {
    await execa("which", ["opencode"]);
  } catch {
    throw new Error(
      "opencode not found. Install it: npm i -g opencode-ai\nSee: https://opencode.ai/docs/",
    );
  }

  const subprocess = execa("opencode", ["serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    cleanup: false,
  });

  // Write PID for later cleanup
  if (subprocess.pid) {
    await writeFile(pidFile, String(subprocess.pid), "utf-8");
  }

  // Unref so our process can exit
  subprocess.unref();
}

/**
 * Stop a previously spawned server
 */
export async function stopServer(): Promise<boolean> {
  const dir = join(process.cwd(), ".commitdog");
  const pidFile = join(dir, "server.pid");

  if (!existsSync(pidFile)) return false;

  try {
    const pid = parseInt(await readFile(pidFile, "utf-8"), 10);
    process.kill(pid, "SIGTERM");
    await unlink(pidFile);
    return true;
  } catch {
    // Process already dead, clean up pid file
    try {
      await unlink(pidFile);
    } catch {
      /* ignore */
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
