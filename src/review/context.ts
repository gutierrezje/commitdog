import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { execa } from "execa";
import { getLastCommitDiff, getStagedDiff, type DiffFile, type DiffResult } from "../git/diff.js";
import type { CommitDogConfig } from "../config.js";

const MAX_DIFF_CHARS = 40_000;
const MAX_FILE_CHARS = 12_000;
const MAX_RELATED_FILE_CHARS = 6_000;
const MAX_REFERENCES_PER_TERM = 8;
const MAX_REFERENCE_TERMS = 8;
const MAX_REFERENCE_LINE_CHARS = 220;

export interface ReviewContext {
  mode: "last-commit" | "staged";
  diff: DiffResult;
  changedFiles: ChangedFileContext[];
  relatedFiles: RelatedFileContext[];
  references: ReferenceContext[];
}

export interface ChangedFileContext {
  file: DiffFile;
  imports: string[];
  symbols: string[];
  content?: string;
  truncated: boolean;
  skippedReason?: string;
}

export interface RelatedFileContext {
  path: string;
  reason: string;
  content: string;
  truncated: boolean;
}

export interface ReferenceContext {
  term: string;
  matches: ReferenceMatch[];
}

export interface ReferenceMatch {
  path: string;
  line: number;
  text: string;
}

export async function buildReviewContext(
  mode: "last-commit" | "staged",
  _config: CommitDogConfig,
): Promise<ReviewContext> {
  const diff = mode === "staged" ? await getStagedDiff() : await getLastCommitDiff();
  const changedFiles = await Promise.all(diff.files.map((file) => buildChangedFileContext(file)));
  const relatedFiles = await buildRelatedFileContexts(diff.files);
  const references = await buildReferenceContexts(changedFiles);

  return {
    mode,
    diff,
    changedFiles,
    relatedFiles,
    references,
  };
}

export function renderReviewContext(context: ReviewContext): string {
  const lines: string[] = [];

  lines.push("## Local Review Context");
  lines.push("");
  lines.push(`Mode: ${context.mode}`);
  lines.push("");
  lines.push("### Changed Files");
  lines.push(context.diff.summary || "No changed files detected.");
  lines.push("");
  lines.push("### Diff");
  lines.push(fence(truncateText(context.diff.raw, MAX_DIFF_CHARS).text, "diff"));
  lines.push("");

  for (const fileContext of context.changedFiles) {
    lines.push(`### File Context: ${fileContext.file.path}`);
    lines.push(
      `Status: ${fileContext.file.status}; additions: ${fileContext.file.additions}; deletions: ${fileContext.file.deletions}`,
    );

    if (fileContext.imports.length > 0) {
      lines.push("");
      lines.push("Imports:");
      lines.push(fileContext.imports.map((line) => `- ${line}`).join("\n"));
    }

    if (fileContext.symbols.length > 0) {
      lines.push("");
      lines.push("Symbols:");
      lines.push(fileContext.symbols.map((symbol) => `- ${symbol}`).join("\n"));
    }

    lines.push("");
    if (fileContext.content) {
      lines.push(fence(fileContext.content, languageForPath(fileContext.file.path)));
      if (fileContext.truncated) {
        lines.push("_File content truncated._");
      }
    } else {
      lines.push(`_File content skipped: ${fileContext.skippedReason ?? "unavailable"}._`);
    }
    lines.push("");
  }

  if (context.relatedFiles.length > 0) {
    lines.push("### Related Test Files");
    for (const related of context.relatedFiles) {
      lines.push(`#### ${related.path}`);
      lines.push(`Reason: ${related.reason}`);
      lines.push(fence(related.content, languageForPath(related.path)));
      if (related.truncated) {
        lines.push("_File content truncated._");
      }
      lines.push("");
    }
  }

  if (context.references.length > 0) {
    lines.push("### Reference Hints");
    for (const reference of context.references) {
      lines.push(`Term: ${reference.term}`);
      for (const match of reference.matches) {
        lines.push(`- ${match.path}:${match.line}: ${match.text}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

async function buildChangedFileContext(file: DiffFile): Promise<ChangedFileContext> {
  if (file.status === "deleted") {
    return {
      file,
      imports: [],
      symbols: [],
      truncated: false,
      skippedReason: "deleted file",
    };
  }

  const contentResult = await readTextFile(file.path, MAX_FILE_CHARS);
  if (!contentResult.content) {
    return {
      file,
      imports: [],
      symbols: [],
      truncated: false,
      skippedReason: contentResult.reason,
    };
  }

  return {
    file,
    imports: extractImports(contentResult.content),
    symbols: extractSymbols(contentResult.content),
    content: contentResult.content,
    truncated: contentResult.truncated,
  };
}

async function buildRelatedFileContexts(files: DiffFile[]): Promise<RelatedFileContext[]> {
  const seen = new Set<string>();
  const related: RelatedFileContext[] = [];

  for (const file of files) {
    if (file.status === "deleted") continue;

    for (const candidate of testCandidates(file.path)) {
      if (seen.has(candidate) || !existsSync(candidate)) continue;
      seen.add(candidate);

      const result = await readTextFile(candidate, MAX_RELATED_FILE_CHARS);
      if (!result.content) continue;

      related.push({
        path: candidate,
        reason: `Likely test file for ${file.path}`,
        content: result.content,
        truncated: result.truncated,
      });
    }
  }

  return related;
}

async function buildReferenceContexts(
  changedFiles: ChangedFileContext[],
): Promise<ReferenceContext[]> {
  const terms = new Set<string>();
  const changedPaths = new Set(changedFiles.map((file) => file.file.path));

  for (const file of changedFiles) {
    terms.add(basename(file.file.path, extname(file.file.path)));
    for (const symbol of file.symbols.slice(0, 4)) {
      terms.add(symbol);
    }
  }

  const references: ReferenceContext[] = [];
  for (const term of [...terms]
    .filter((value) => value.length >= 3)
    .slice(0, MAX_REFERENCE_TERMS)) {
    const matches = await findReferences(term, changedPaths);
    if (matches.length > 0) {
      references.push({ term, matches });
    }
  }

  return references;
}

async function findReferences(term: string, changedPaths: Set<string>): Promise<ReferenceMatch[]> {
  const gitMatches = await findReferencesWithGitGrep(term, changedPaths);
  if (gitMatches.length > 0) {
    return gitMatches;
  }

  return findReferencesWithRipgrep(term, changedPaths);
}

async function findReferencesWithGitGrep(
  term: string,
  changedPaths: Set<string>,
): Promise<ReferenceMatch[]> {
  try {
    const { stdout } = await execa("git", ["grep", "-n", "--fixed-strings", "--", term], {
      timeout: 1500,
    });

    return parseReferenceLines(stdout, changedPaths);
  } catch {
    return [];
  }
}

async function findReferencesWithRipgrep(
  term: string,
  changedPaths: Set<string>,
): Promise<ReferenceMatch[]> {
  try {
    const { stdout } = await execa(
      "rg",
      [
        "--line-number",
        "--fixed-strings",
        "--glob",
        "!node_modules/**",
        "--glob",
        "!dist/**",
        "--glob",
        "!.git/**",
        "--glob",
        "!*lock*",
        term,
      ],
      { timeout: 1500 },
    );

    return parseReferenceLines(stdout, changedPaths);
  } catch {
    return [];
  }
}

function parseReferenceLines(stdout: string, changedPaths: Set<string>): ReferenceMatch[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map(parseReferenceLine)
    .filter((match): match is ReferenceMatch => Boolean(match))
    .filter((match) => !changedPaths.has(match.path))
    .slice(0, MAX_REFERENCES_PER_TERM);
}

function parseReferenceLine(line: string): ReferenceMatch | undefined {
  const match = line.match(/^(.+?):(\d+):(.*)$/);
  if (!match) return undefined;

  return {
    path: match[1],
    line: Number(match[2]),
    text: match[3].trim().slice(0, MAX_REFERENCE_LINE_CHARS),
  };
}

async function readTextFile(
  path: string,
  maxChars: number,
): Promise<{ content?: string; truncated: boolean; reason?: string }> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return { truncated: false, reason: "not a regular file" };
    }

    const raw = await readFile(path, "utf-8");
    if (raw.includes("\0")) {
      return { truncated: false, reason: "binary file" };
    }

    const result = truncateText(raw, maxChars);
    return { content: result.text, truncated: result.truncated };
  } catch (err) {
    return {
      truncated: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractImports(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("import ") || /^export\s+.*\sfrom\s+/.test(line))
    .slice(0, 30);
}

function extractSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      symbols.add(match[1]);
    }
  }

  return [...symbols].slice(0, 30);
}

function testCandidates(path: string): string[] {
  const dir = dirname(path);
  const ext = extname(path);
  const base = basename(path, ext);
  return [
    join(dir, `${base}.test${ext}`),
    join(dir, `${base}.spec${ext}`),
    join(dir, "__tests__", `${base}.test${ext}`),
    join(dir, "__tests__", `${base}.spec${ext}`),
  ];
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}

function fence(content: string, language = ""): string {
  return `\`\`\`${language}\n${content.replaceAll("```", "'''")}\n\`\`\``;
}

function languageForPath(path: string): string {
  const ext = extname(path).slice(1);
  if (ext === "ts" || ext === "tsx") return "ts";
  if (ext === "js" || ext === "jsx") return "js";
  if (ext === "json") return "json";
  if (ext === "md") return "md";
  if (ext === "yml" || ext === "yaml") return "yaml";
  return "";
}
