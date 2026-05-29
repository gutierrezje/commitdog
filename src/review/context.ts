import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import picomatch from "picomatch";
import type tsType from "typescript";
import { getLastCommitDiff, getStagedDiff, parseGitDiffLine, type DiffFile, type DiffResult } from "../git/diff.js";
import type { CommitDogConfig } from "../config.js";

type tsNode = tsType.Node;
type tsIdentifier = tsType.Identifier;

let cachedTs: any = null;

function tryLoadUserTypescript(): any {
  if (cachedTs !== null) return cachedTs;
  try {
    const require = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
    cachedTs = require("typescript");
  } catch {
    try {
      const fallbackRequire = createRequire(import.meta.url);
      cachedTs = fallbackRequire("typescript");
    } catch {
      cachedTs = undefined;
    }
  }
  return cachedTs;
}

const MAX_DIFF_CHARS = 40_000;
const MAX_FILE_CHARS = 12_000;
const MAX_RELATED_FILE_CHARS = 6_000;
const MAX_AST_SYMBOL_CHARS = 8_000;
const MAX_QUICK_DIFF_CHARS = 12_000;
const MAX_QUICK_SYMBOL_CHARS = 4_000;
const MAX_QUICK_FILE_CHARS = 4_000;
const MAX_REFERENCES_PER_TERM = 8;
const MAX_REFERENCE_TERMS = 8;
const MAX_REFERENCE_LINE_CHARS = 220;
const LOCKFILE_EXCLUDES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

export interface ReviewContext {
  mode: "last-commit" | "staged";
  diff: DiffResult;
  changedFiles: ChangedFileContext[];
  skippedFiles: DiffFile[];
  relatedFiles: RelatedFileContext[];
  references: ReferenceContext[];
}

export interface ChangedFileContext {
  file: DiffFile;
  imports: string[];
  symbols: string[];
  changedLines: number[];
  astSymbols: AstSymbolContext[];
  content?: string;
  truncated: boolean;
  skippedReason?: string | undefined;
}

export interface AstSymbolContext {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
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

export interface RenderReviewContextOptions {
  quick?: boolean;
}

export async function buildReviewContext(
  mode: "last-commit" | "staged",
  config: CommitDogConfig,
): Promise<ReviewContext> {
  const diff = mode === "staged" ? await getStagedDiff() : await getLastCommitDiff();
  const reviewableFiles = diff.files.filter((file) => shouldReviewFile(file.path, config));
  const skippedFiles = diff.files.filter((file) => !shouldReviewFile(file.path, config));
  const changedLines = getChangedLinesByFile(diff.raw);
  const changedFiles = await Promise.all(
    reviewableFiles.map((file) => buildChangedFileContext(file, changedLines.get(file.path) ?? [])),
  );
  const relatedFiles = await buildRelatedFileContexts(reviewableFiles);
  const references = await buildReferenceContexts(changedFiles, skippedFiles);

  return {
    mode,
    diff,
    changedFiles,
    skippedFiles,
    relatedFiles,
    references,
  };
}

export function renderReviewContext(
  context: ReviewContext,
  options: RenderReviewContextOptions = {},
): string {
  const quick = Boolean(options.quick);
  const lines: string[] = [];

  lines.push("## Local Review Context");
  lines.push("");
  lines.push(`Mode: ${context.mode}`);
  if (quick) {
    lines.push("Review depth: quick");
  }
  lines.push("");
  lines.push("### Changed Files");
  lines.push(context.diff.summary || "No changed files detected.");
  if (context.skippedFiles.length > 0) {
    lines.push("");
    lines.push("Skipped by include/exclude rules:");
    lines.push(context.skippedFiles.map((file) => `- ${file.path}`).join("\n"));
  }
  lines.push("");
  lines.push("### Diff");
  lines.push(
    fence(
      truncateText(
        filterDiffRaw(
          context.diff.raw,
          new Set(context.changedFiles.map((fileContext) => fileContext.file.path)),
        ),
        quick ? MAX_QUICK_DIFF_CHARS : MAX_DIFF_CHARS,
      ).text,
      "diff",
    ),
  );
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
    if (fileContext.changedLines.length > 0) {
      lines.push(`Changed lines: ${summarizeLines(fileContext.changedLines)}`);
      lines.push("");
    }

    if (fileContext.astSymbols.length > 0) {
      lines.push("Changed TypeScript AST symbols:");
      for (const symbol of quick ? fileContext.astSymbols.slice(0, 5) : fileContext.astSymbols) {
        lines.push(`#### ${symbol.kind} ${symbol.name} (${symbol.startLine}-${symbol.endLine})`);
        lines.push(
          fence(
            truncateText(symbol.text, quick ? MAX_QUICK_SYMBOL_CHARS : MAX_AST_SYMBOL_CHARS).text,
            languageForPath(fileContext.file.path),
          ),
        );
        if (symbol.truncated) {
          lines.push("_Symbol content truncated._");
        }
        lines.push("");
      }
    }

    if (fileContext.content && fileContext.astSymbols.length === 0) {
      lines.push(
        fence(
          quick
            ? truncateText(fileContext.content, MAX_QUICK_FILE_CHARS).text
            : fileContext.content,
          languageForPath(fileContext.file.path),
        ),
      );
      if (fileContext.truncated) {
        lines.push("_File content truncated._");
      }
    } else if (fileContext.content) {
      lines.push("_Full file content omitted because changed TypeScript AST symbols are shown._");
    } else {
      lines.push(`_File content skipped: ${fileContext.skippedReason ?? "unavailable"}._`);
    }
    lines.push("");
  }

  if (!quick && context.relatedFiles.length > 0) {
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

  if (!quick && context.references.length > 0) {
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

async function buildChangedFileContext(
  file: DiffFile,
  changedLines: number[],
): Promise<ChangedFileContext> {
  if (file.status === "deleted") {
    return {
      file,
      imports: [],
      symbols: [],
      changedLines,
      astSymbols: [],
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
      changedLines,
      astSymbols: [],
      truncated: false,
      skippedReason: contentResult.reason,
    };
  }

  const astSymbols = extractAstSymbols(file.path, contentResult.content, changedLines);
  return {
    file,
    imports: extractImports(contentResult.content),
    symbols: mergeSymbols(
      extractSymbols(contentResult.content),
      astSymbols.map((symbol) => symbol.name),
    ),
    changedLines,
    astSymbols,
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
  skippedFiles: DiffFile[],
): Promise<ReferenceContext[]> {
  const terms = new Set<string>();
  const ignoredPaths = new Set([
    ...changedFiles.map((file) => file.file.path),
    ...skippedFiles.map((file) => file.path),
  ]);

  for (const file of changedFiles) {
    terms.add(basename(file.file.path, extname(file.file.path)));
    for (const symbol of file.symbols.slice(0, 4)) {
      terms.add(symbol);
    }
  }

  const validTerms = [...terms]
    .filter((value) => value.length >= 3)
    .slice(0, MAX_REFERENCE_TERMS);

  if (validTerms.length === 0) {
    return [];
  }

  const allMatches = await findBatchReferences(validTerms, ignoredPaths);

  const references: ReferenceContext[] = [];
  for (const term of validTerms) {
    const matches = allMatches
      .filter((match) => match.text.includes(term))
      .slice(0, MAX_REFERENCES_PER_TERM);

    if (matches.length > 0) {
      references.push({ term, matches });
    }
  }

  return references;
}

async function findBatchReferences(
  terms: string[],
  ignoredPaths: Set<string>,
): Promise<ReferenceMatch[]> {
  const gitMatches = await findBatchReferencesWithGitGrep(terms, ignoredPaths);
  if (gitMatches.length > 0) {
    return gitMatches;
  }

  return findBatchReferencesWithRipgrep(terms, ignoredPaths);
}

async function findBatchReferencesWithGitGrep(
  terms: string[],
  ignoredPaths: Set<string>,
): Promise<ReferenceMatch[]> {
  try {
    const args = ["grep", "-n", "--fixed-strings"];
    for (const term of terms) {
      args.push("-e", term);
    }
    args.push("--");

    const { stdout } = await execa("git", args, { timeout: 2000 });
    return parseBatchReferenceLines(stdout, ignoredPaths);
  } catch {
    return [];
  }
}

async function findBatchReferencesWithRipgrep(
  terms: string[],
  ignoredPaths: Set<string>,
): Promise<ReferenceMatch[]> {
  try {
    const args = [
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
    ];
    for (const term of terms) {
      args.push("-e", term);
    }

    const { stdout } = await execa("rg", args, { timeout: 2000 });
    return parseBatchReferenceLines(stdout, ignoredPaths);
  } catch {
    return [];
  }
}

function parseBatchReferenceLines(stdout: string, ignoredPaths: Set<string>): ReferenceMatch[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map(parseReferenceLine)
    .filter((match): match is ReferenceMatch => Boolean(match))
    .filter((match) => !ignoredPaths.has(match.path));
}

function parseReferenceLine(line: string): ReferenceMatch | undefined {
  const match = line.match(/^(.+?):(\d+):(.*)$/);
  if (!match) return undefined;

  return {
    path: match[1]!,
    line: Number(match[2]),
    text: match[3]!.trim().slice(0, MAX_REFERENCE_LINE_CHARS),
  };
}

function shouldReviewFile(path: string, config: CommitDogConfig): boolean {
  if (LOCKFILE_EXCLUDES.includes(path)) return false;

  const include = config.include.length > 0 ? config.include : ["**/*"];
  if (!include.some((pattern) => picomatch.isMatch(path, pattern))) {
    return false;
  }

  return !config.exclude.some((pattern) => picomatch.isMatch(path, pattern));
}

function filterDiffRaw(rawDiff: string, includedPaths: Set<string>): string {
  if (includedPaths.size === 0) {
    return "No included file diffs.";
  }

  const lines: string[] = [];
  let includeCurrentFile = false;

  for (const line of rawDiff.split("\n")) {
    const gitDiffPaths = parseGitDiffLine(line);
    if (gitDiffPaths) {
      includeCurrentFile = includedPaths.has(gitDiffPaths.pathB);
    }

    if (includeCurrentFile) {
      lines.push(line);
    }
  }

  return lines.join("\n");
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
      symbols.add(match[1]!);
    }
  }

  return [...symbols].slice(0, 30);
}

function extractAstSymbols(
  path: string,
  content: string,
  changedLines: number[],
): AstSymbolContext[] {
  if (!isTypeScriptPath(path) || changedLines.length === 0) {
    return [];
  }

  const activeTs = tryLoadUserTypescript();
  if (!activeTs) {
    return [];
  }

  const sourceFile = activeTs.createSourceFile(path, content, activeTs.ScriptTarget.Latest, true);
  const changed = new Set(changedLines);
  const symbols: AstSymbolContext[] = [];

  const visit = (node: tsNode) => {
    const namedNode = getNamedDeclarationNode(activeTs, node);
    if (namedNode) {
      const startLine =
        sourceFile.getLineAndCharacterOfPosition(namedNode.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(namedNode.getEnd()).line + 1;
      if (containsChangedLine(changed, startLine, endLine)) {
        const text = truncateText(namedNode.getText(sourceFile), MAX_AST_SYMBOL_CHARS);
        symbols.push({
          name: getDeclarationName(activeTs, namedNode),
          kind: getDeclarationKind(activeTs, namedNode),
          startLine,
          endLine,
          text: text.text,
          truncated: text.truncated,
        });
      }
    }

    activeTs.forEachChild(node, visit);
  };

  visit(sourceFile);
  return dedupeAstSymbols(symbols);
}

function getNamedDeclarationNode(ts: typeof tsType, node: tsNode): tsNode | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    return hasIdentifierName(ts, node) ? node : undefined;
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return findAncestor(node, ts.isVariableStatement) ?? node;
  }

  return undefined;
}

function hasIdentifierName(ts: typeof tsType, node: tsNode): node is tsNode & { name: tsIdentifier } {
  const name = (node as { name?: tsNode }).name;
  return Boolean(name && ts.isIdentifier(name));
}

function findAncestor<T extends tsNode>(
  node: tsNode,
  predicate: (node: tsNode) => node is T,
): T | undefined {
  let current = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function getDeclarationName(ts: typeof tsType, node: tsNode): string {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((declaration: any) => declaration.name.getText())
      .join(", ");
  }

  if (hasIdentifierName(ts, node)) {
    return node.name.text;
  }

  return "<anonymous>";
}

function getDeclarationKind(ts: typeof tsType, node: tsNode): string {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isPropertyDeclaration(node)) return "property";
  if (ts.isVariableStatement(node)) return "const";
  return ts.SyntaxKind[node.kind] ?? "symbol";
}

function dedupeAstSymbols(symbols: AstSymbolContext[]): AstSymbolContext[] {
  const seen = new Set<string>();
  const unique: AstSymbolContext[] = [];

  for (const symbol of symbols.sort((a, b) => a.startLine - b.startLine)) {
    const key = `${symbol.kind}:${symbol.name}:${symbol.startLine}:${symbol.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(symbol);
  }

  return unique.slice(0, 20);
}

function containsChangedLine(
  changedLines: Set<number>,
  startLine: number,
  endLine: number,
): boolean {
  for (let line = startLine; line <= endLine; line++) {
    if (changedLines.has(line)) return true;
  }
  return false;
}

function mergeSymbols(...groups: string[][]): string[] {
  const symbols = new Set<string>();
  for (const group of groups) {
    for (const symbol of group) {
      symbols.add(symbol);
    }
  }
  return [...symbols].slice(0, 30);
}

function getChangedLinesByFile(rawDiff: string): Map<string, number[]> {
  const changed = new Map<string, number[]>();
  let currentPath: string | undefined;
  let newLine: number | undefined;

  for (const line of rawDiff.split("\n")) {
    const gitDiffPaths = parseGitDiffLine(line);
    if (gitDiffPaths) {
      currentPath = gitDiffPaths.pathB;
      continue;
    }

    if (line.startsWith("rename to ")) {
      currentPath = line.slice("rename to ".length);
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (!currentPath || newLine === undefined) continue;

    if (line.startsWith("+++")) {
      continue;
    }

    if (line.startsWith("+")) {
      const lines = changed.get(currentPath) ?? [];
      lines.push(newLine);
      changed.set(currentPath, lines);
      newLine++;
      continue;
    }

    if (line.startsWith("-")) {
      continue;
    }

    newLine++;
  }

  return changed;
}

function summarizeLines(lines: number[]): string {
  return [...new Set(lines)].sort((a, b) => a - b).join(", ");
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

function isTypeScriptPath(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx");
}
