import { execa } from "execa";

export interface DiffResult {
  files: DiffFile[];
  raw: string;
  summary: string;
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

/**
 * Get the diff for the last commit (HEAD~1..HEAD)
 */
export async function getLastCommitDiff(): Promise<DiffResult> {
  const { stdout: raw } = await execa("git", [
    "diff",
    "HEAD~1..HEAD",
    "--stat",
    "--patch",
  ]);
  return parseDiff(raw);
}

/**
 * Get the diff for staged changes
 */
export async function getStagedDiff(): Promise<DiffResult> {
  const { stdout: raw } = await execa("git", [
    "diff",
    "--staged",
    "--stat",
    "--patch",
  ]);
  return parseDiff(raw);
}

/**
 * Get the diff summary (just file names and stats) for display purposes
 */
export async function getDiffSummary(
  mode: "last" | "staged"
): Promise<string> {
  const args =
    mode === "staged"
      ? ["diff", "--staged", "--stat"]
      : ["diff", "HEAD~1..HEAD", "--stat"];
  const { stdout } = await execa("git", args);
  return stdout;
}

/**
 * Get the commit message for the last commit
 */
export async function getLastCommitMessage(): Promise<string> {
  const { stdout } = await execa("git", [
    "log",
    "-1",
    "--format=%s",
  ]);
  return stdout.trim();
}

/**
 * Get the short SHA of the last commit
 */
export async function getLastCommitSha(): Promise<string> {
  const { stdout } = await execa("git", [
    "log",
    "-1",
    "--format=%h",
  ]);
  return stdout.trim();
}

/**
 * Check if we're in a git repo
 */
export async function isGitRepo(): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if there are any commits
 */
export async function hasCommits(): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function parseDiff(raw: string): DiffResult {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");

  for (const line of lines) {
    // Parse diff --git a/path b/path
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      files.push({
        path: fileMatch[2],
        status: "modified",
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    // Detect new files
    if (line === "--- /dev/null" && files.length > 0) {
      files[files.length - 1].status = "added";
      continue;
    }

    // Detect deleted files
    if (line === "+++ /dev/null" && files.length > 0) {
      files[files.length - 1].status = "deleted";
      continue;
    }

    // Count additions/deletions
    if (files.length > 0) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        files[files.length - 1].additions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        files[files.length - 1].deletions++;
      }
    }
  }

  const summary = files
    .map(
      (f) =>
        `${f.status === "added" ? "+" : f.status === "deleted" ? "-" : "~"} ${f.path} (+${f.additions}/-${f.deletions})`
    )
    .join("\n");

  return { files, raw, summary };
}
