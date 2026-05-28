import chalk from "chalk";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReviewReport } from "../opencode/client.js";
import { getCommitDogDir } from "../config.js";

/**
 * Render a structured review into the markdown format we persist.
 */
export function renderMarkdown(report: ReviewReport): string {
  const lines: string[] = [];

  lines.push("### Summary");
  lines.push(report.summary.trim() || "No summary provided.");
  lines.push("");

  lines.push("### Issues Found");

  if (report.findings.length === 0) {
    lines.push("No issues were reported.");
  } else {
    for (const finding of report.findings) {
      lines.push(`**[${finding.severity.toUpperCase()}] ${finding.file}:${finding.line}**`);
      lines.push(finding.title.trim());
      lines.push("");
      if (finding.evidence) {
        lines.push(`> **Evidence:** \`${finding.evidence.trim()}\``);
        lines.push("");
      }
      lines.push(finding.body.trim());
      lines.push("");
    }
  }

  lines.push("### What Looks Good");
  lines.push("The reviewer did not flag additional issues beyond those listed above.");

  return lines.join("\n");
}

/**
 * Format and write the review output as a markdown file
 */
export async function writeMarkdownReport(review: string): Promise<string> {
  const dir = join(getCommitDogDir(), "reviews");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `review-${timestamp}.md`;
  const filepath = join(dir, filename);

  const content = `# CommitDog Review
_${new Date().toLocaleString()}_

${review}
`;

  await writeFile(filepath, content, "utf-8");

  // Also write as latest
  const latestPath = join(dir, "latest.md");
  await writeFile(latestPath, content, "utf-8");

  return filepath;
}

/**
 * Print the review header
 */
export function printHeader(): void {
  console.log();
  console.log(chalk.bold("commitdog") + chalk.dim(" reviewing..."));
  console.log(chalk.dim("─".repeat(50)));
  console.log();
}

/**
 * Print a chunk of the streaming response
 */
export function printChunk(text: string): void {
  // Apply some basic coloring to the streamed markdown
  process.stdout.write(colorizeMarkdown(text));
}

/**
 * Print the review footer with summary
 */
export function printFooter(report: ReviewReport, reportPath?: string): void {
  console.log();
  console.log(chalk.dim("─".repeat(50)));

  let errors = 0;
  let warnings = 0;
  let infos = 0;

  for (const finding of report.findings) {
    switch (finding.severity) {
      case "error":
        errors++;
        break;
      case "warning":
        warnings++;
        break;
      case "info":
        infos++;
        break;
    }
  }

  const parts: string[] = [];
  if (errors > 0) parts.push(chalk.red(`${errors} error${errors > 1 ? "s" : ""}`));
  if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning${warnings > 1 ? "s" : ""}`));
  if (infos > 0) parts.push(chalk.blue(`${infos} suggestion${infos > 1 ? "s" : ""}`));

  if (parts.length === 0) {
    console.log(chalk.green("✓ No issues found. Clean commit!"));
  } else {
    console.log(`Found ${parts.join(", ")}`);
  }

  if (reportPath) {
    console.log(chalk.dim(`Report saved: ${reportPath}`));
  }
  console.log();
}

/**
 * Basic markdown colorization for terminal output
 */
export function colorizeMarkdown(text: string): string {
  return text
    .replace(
      /\*\*\[(ERROR|WARNING|INFO)\]([^*]*)\*\*/g,
      (_match, label: string, rest: string) => `${colorizeSeverity(label)}${chalk.bold(rest)}`,
    )
    .replace(/### (.*)/g, (_match, title: string) => chalk.bold.underline(title))
    .replace(/\*\*([^*]+)\*\*/g, (_match, content: string) => chalk.bold(content));
}

function colorizeSeverity(label: string): string {
  switch (label) {
    case "ERROR":
      return chalk.red.bold(`[${label}]`);
    case "WARNING":
      return chalk.yellow.bold(`[${label}]`);
    default:
      return chalk.blue.bold(`[${label}]`);
  }
}
