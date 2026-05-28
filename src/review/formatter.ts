import chalk from "chalk";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Format and write the review output as a markdown file
 */
export async function writeMarkdownReport(review: string): Promise<string> {
  const dir = join(process.cwd(), ".commitdog", "reviews");
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
export function printFooter(review: string, reportPath?: string): void {
  console.log();
  console.log(chalk.dim("─".repeat(50)));

  // Count issues
  const errors = (review.match(/\[ERROR\]/g) || []).length;
  const warnings = (review.match(/\[WARNING\]/g) || []).length;
  const infos = (review.match(/\[INFO\]/g) || []).length;

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
    .replace(/\*\*\[(ERROR)\]\*\*/g, (_match, label: string) =>
      chalk.red.bold(`[${label}]`)
    )
    .replace(/\*\*\[(WARNING)\]\*\*/g, (_match, label: string) =>
      chalk.yellow.bold(`[${label}]`)
    )
    .replace(/\*\*\[(INFO)\]\*\*/g, (_match, label: string) =>
      chalk.blue.bold(`[${label}]`)
    )
    .replace(/### (.*)/g, (_match, title: string) => chalk.bold.underline(title))
    .replace(/\*\*([^*]+)\*\*/g, (_match, content: string) =>
      chalk.bold(content)
    );
}
