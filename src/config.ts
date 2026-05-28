import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse, stringify } from "yaml";

export interface CommitDogConfig {
  model: string;
  server: {
    port: number;
    auto_start: boolean;
  };
  include: string[];
  exclude: string[];
  rules: string[];
}

const DEFAULT_CONFIG: CommitDogConfig = {
  model: "anthropic/claude-sonnet-4-20250514",
  server: {
    port: 4096,
    auto_start: true,
  },
  include: ["**/*"],
  exclude: [
    "**/*.test.*",
    "**/*.spec.*",
    "**/*.lock",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
  ],
  rules: [],
};

const CONFIG_FILENAME = ".commitdog.yml";

function findConfigPath(): string {
  // Look in current directory first, then walk up
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), CONFIG_FILENAME);
}

export async function loadConfig(): Promise<CommitDogConfig> {
  const configPath = findConfigPath();
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parse(raw) as Partial<CommitDogConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      server: { ...DEFAULT_CONFIG.server, ...parsed.server },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load ${configPath}: ${message}`);
  }
}

export async function saveConfig(config: CommitDogConfig): Promise<string> {
  const configPath = findConfigPath();
  const content = stringify(config, { lineWidth: 0 });
  await writeFile(configPath, content, "utf-8");
  return configPath;
}

export function getCommitDogDir(): string {
  const configPath = findConfigPath();
  const projectRoot = dirname(configPath);
  return join(projectRoot, ".commitdog");
}

export async function ensureCommitDogDir(): Promise<string> {
  const dir = getCommitDogDir();
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

export function configExists(): boolean {
  return existsSync(findConfigPath());
}
