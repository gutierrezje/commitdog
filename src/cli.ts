#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig, configExists, type CommitDogConfig } from "./config.js";
import {
  runReview,
  getAvailableModels,
  type ReviewProgressEvent,
  type ReviewReport,
  type ReviewTiming,
  type ReviewFinding,
} from "./opencode/client.js";
import { ensureServer, isServerRunning, stopServer } from "./opencode/server.js";
import {
  installHook,
  uninstallHook,
  isHookInstalled,
  checkHookStale,
  checkRecentHookFailure,
} from "./git/hooks.js";
import { isGitRepo, hasCommits } from "./git/diff.js";
import { buildReviewContext, renderReviewContext } from "./review/context.js";
import {
  printHeader,
  printFooter,
  writeMarkdownReport,
  renderMarkdown,
  colorizeMarkdown,
} from "./review/formatter.js";

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

async function writeHookStatus(exitCode: number): Promise<void> {
  try {
    const statusPath = join(process.cwd(), ".commitdog", "last-hook-status.json");
    await writeFile(
      statusPath,
      JSON.stringify({ exitCode, timestamp: new Date().toISOString() }, null, 2),
      "utf-8",
    );
  } catch {
    // Best-effort: status file is advisory only
  }
}

const program = new Command();

program
  .name("commitdog")
  .description("Local AI code review agent powered by OpenCode")
  .version("0.1.0");

// Default command: review last commit
program
  .command("review", { isDefault: true })
  .description("Review the last commit or staged changes")
  .option("--staged", "Review staged changes instead of last commit")
  .option("--hook", "Running from git hook (non-blocking mode)")
  .option("--quick", "Use a smaller local-only review prompt")
  .option("--min-confidence <level>", "Minimum confidence level to report (low, medium, high)", "medium")
  .action(async (options) => {
    const totalStart = performance.now();
    const timings: ReviewTiming[] = [];

    // Preflight checks
    const gitRepoStart = performance.now();
    const isRepo = await isGitRepo();
    recordCliTiming(timings, "git-repo-check", "Git repository check", gitRepoStart);
    if (!isRepo) {
      console.error(chalk.red("Not a git repository"));
      process.exit(1);
    }

    // First run: prompt for setup
    if (!configExists()) {
      console.log(chalk.yellow("No .commitdog.yml found. Running first-time setup...\n"));
      await runInit();
    }

    const config = await loadConfigOrExit();
    const mode = options.staged ? "staged" : "last-commit";

    if (mode === "last-commit") {
      const hasCommitsStart = performance.now();
      const commitsExist = await hasCommits();
      recordCliTiming(timings, "git-commit-check", "Git commit check", hasCommitsStart);
      if (!commitsExist) {
        console.error(chalk.red("No commits found in this repository"));
        process.exit(1);
      }
    }

    printHeader();

    const hookFailure = await checkRecentHookFailure();
    if (hookFailure) {
      console.log(
        chalk.yellow(
          `⚠ Post-commit hook failed at ${new Date(hookFailure.timestamp).toLocaleString()}. Check .commitdog/hook.log`,
        ),
      );
      console.log();
    }

    const spinner = ora({
      text: "Building local review context...",
      color: "cyan",
    }).start();

    try {
      const contextStart = performance.now();
      const reviewContext = await buildReviewContext(mode, config);
      recordCliTiming(timings, "context-build", "Local review context build", contextStart);

      if (mode === "staged" && reviewContext.diff.files.length === 0) {
        spinner.stop();
        console.log(chalk.yellow("No staged changes to review"));
        process.exit(0);
      }

      const contextRenderStart = performance.now();
      const localContext = renderReviewContext(reviewContext, { quick: Boolean(options.quick) });
      recordCliTiming(timings, "context-render", "Local review context render", contextRenderStart);

      // Ensure server and start review
      spinner.text = "Connecting to OpenCode...";
      const serverStart = performance.now();
      await ensureServer(config.server.port);
      recordCliTiming(timings, "server-ensure", "OpenCode server ensure", serverStart);
      spinner.text = "Reviewing changes...";

      const reviewStart = performance.now();
      const report: ReviewReport = await runReview({
        mode,
        config,
        localContext,
        quick: Boolean(options.quick),
        onProgress: (event) => {
          spinner.text = formatReviewProgress(event);
        },
      });
      recordCliTiming(timings, "review-run", "OpenCode review run", reviewStart);
      spinner.succeed("Review complete.");
      console.log(); // Space after spinner

      // Filter findings by confidence
      const minConfidence = (options.minConfidence as string | undefined) ?? "medium";
      const validLevels = ["low", "medium", "high"];
      if (!validLevels.includes(minConfidence.toLowerCase())) {
        spinner.stop();
        console.error(chalk.red(`\nInvalid confidence level: "${minConfidence}". Must be one of: low, medium, high.`));
        process.exit(1);
      }
      report.findings = filterFindingsByConfidence(report.findings, minConfidence);

      // Filter findings by changed lines (anchoring: only keep if line is in diff hunks, or confidence is high)
      const changedLinesMap = new Map<string, number[]>();
      for (const file of reviewContext.changedFiles) {
        changedLinesMap.set(file.file.path, file.changedLines);
      }
      report.findings = filterFindingsByChangedLines(report.findings, changedLinesMap);

      const renderStart = performance.now();
      const markdown = renderMarkdown(report);
      recordCliTiming(timings, "render-report", "Markdown render", renderStart);

      // Write markdown report
      const writeStart = performance.now();
      const reportPath = await writeMarkdownReport(markdown);
      recordCliTiming(timings, "write-report", "Report write", writeStart);
      recordCliTiming(timings, "total", "Total review command", totalStart);

      // Print the rendered, colorized markdown to stdout
      console.log(colorizeMarkdown(markdown));

      printFooter(report, reportPath);
      printTimingSummary([...timings, ...(report.timings ?? [])]);
      if (options.hook) {
        await writeHookStatus(0);
        process.exit(0);
      }
    } catch (err) {
      spinner.stop();
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nReview failed: ${message}`));
      if (message.includes("opencode not found")) {
        console.log(chalk.dim("Install: npm i -g opencode-ai"));
        console.log(chalk.dim("Docs: https://opencode.ai/docs/"));
      }
      if (options.hook) {
        await writeHookStatus(1);
      }
      process.exit(1);
    }
  });

function formatReviewProgress(event: ReviewProgressEvent): string {
  switch (event.type) {
    case "server":
    case "session":
    case "idle":
      return event.message;
    case "tool":
      return `OpenCode tool: ${event.message}`;
    case "output":
      return event.message;
    case "timing":
      return event.message;
  }
}

function recordCliTiming(
  timings: ReviewTiming[],
  phase: string,
  label: string,
  start: number,
): void {
  timings.push({ phase, label, ms: performance.now() - start });
}

function printTimingSummary(timings: ReviewTiming[]): void {
  if (timings.length === 0) return;

  console.log(chalk.dim("Timing:"));
  for (const timing of timings) {
    console.log(chalk.dim(`  ${timing.label}: ${formatDuration(timing.ms)}`));
  }
  console.log();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Init command
program
  .command("init")
  .description("Set up CommitDog for this project")
  .action(async () => {
    await runInit();
  });

async function runInit() {
  console.log(chalk.bold("CommitDog Setup\n"));

  const config = await loadConfigOrExit();

  const spinner = ora("Querying available models from OpenCode...").start();
  let models: string[] = [];
  try {
    models = await getAvailableModels(config.server.port);
    spinner.stop();
  } catch {
    spinner.fail("Failed to query models from OpenCode server.");
  }

  let selectedModel = config.model;

  if (models.length > 0) {
    console.log(chalk.bold("Available models configured in OpenCode:"));
    models.forEach((m, idx) => {
      console.log(`  ${chalk.cyan(idx + 1)}. ${m}`);
    });
    console.log();

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      while (true) {
        const answer = await rl.question(
          chalk.yellow(`Select a model number (1-${models.length}) [default: 1]: `),
        );
        const trimmed = answer.trim();
        if (trimmed === "") {
          selectedModel = models[0]!;
          break;
        }
        const num = parseInt(trimmed, 10);
        if (num >= 1 && num <= models.length) {
          selectedModel = models[num - 1]!;
          break;
        }
        console.log(chalk.red("Invalid selection. Please enter a valid number."));
      }
    } finally {
      rl.close();
    }
  } else {
    console.log(chalk.yellow("No active/connected providers found in OpenCode."));
    console.log(
      chalk.dim("Make sure you run ") +
        chalk.cyan("opencode") +
        chalk.dim(" to authenticate and set up your providers/keys first."),
    );
    console.log(chalk.dim("Using fallback default model: ") + chalk.cyan(config.model));
    console.log();
  }

  config.model = selectedModel;
  const configPath = await saveConfig(config);
  console.log(chalk.green(`✓ Config saved to ${configPath}`));
  console.log(chalk.dim(`Model set to: `) + chalk.cyan(selectedModel));
  console.log();
}

// Model command
program
  .command("model")
  .description("View or change the AI model")
  .argument("[model]", "Model to use (e.g., github-copilot/claude-sonnet-4.5)")
  .action(async (model?: string) => {
    const config = await loadConfigOrExit();

    if (!model) {
      console.log(chalk.bold("Current model: ") + chalk.cyan(config.model));

      const spinner = ora("Querying available models from OpenCode...").start();
      let models: string[] = [];
      try {
        models = await getAvailableModels(config.server.port);
        spinner.stop();
      } catch {
        spinner.fail("Failed to query models from OpenCode server.");
      }

      if (models.length > 0) {
        console.log(chalk.bold("\nAvailable models configured in OpenCode:"));
        models.forEach((m, idx) => {
          console.log(`  ${chalk.cyan(idx + 1)}. ${m}`);
        });
        console.log();

        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        try {
          while (true) {
            const answer = await rl.question(
              chalk.yellow(
                `Select a model number (1-${models.length}) or press Enter to keep current: `,
              ),
            );
            const trimmed = answer.trim();
            if (trimmed === "") {
              break; // Keep current model
            }
            const num = parseInt(trimmed, 10);
            if (num >= 1 && num <= models.length) {
              const newModel = models[num - 1]!;
              config.model = newModel;
              await saveConfig(config);
              console.log(chalk.green(`✓ Model set to ${chalk.cyan(newModel)}`));
              break;
            }
            console.log(chalk.red("Invalid selection. Please enter a valid number."));
          }
        } finally {
          rl.close();
        }
      } else {
        console.log(chalk.dim("\nTo change manually: commitdog model <provider/model>"));
        console.log(chalk.dim("Example: commitdog model github-copilot/claude-sonnet-4.5"));
      }
      return;
    }

    config.model = model;
    const configPath = await saveConfig(config);
    console.log(chalk.green(`✓ Model set to ${chalk.cyan(model)}`));
    console.log(chalk.dim(`Config: ${configPath}`));
  });

// Hook commands
const hookCmd = program.command("hook").description("Manage git hooks");

hookCmd
  .command("install")
  .description("Install post-commit hook (non-blocking review)")
  .action(async () => {
    if (!(await isGitRepo())) {
      console.error(chalk.red("Not a git repository"));
      process.exit(1);
    }

    const alreadyInstalled = await isHookInstalled();
    const hookPath = await installHook();
    const action = alreadyInstalled ? "updated" : "installed";
    console.log(chalk.green(`✓ Post-commit hook ${action}: ${hookPath}`));
    console.log(chalk.dim("Reviews will run automatically after each commit (non-blocking)"));
    console.log(
      chalk.dim("Hook output: .commitdog/hook.log; latest report: .commitdog/reviews/latest.md"),
    );
  });

hookCmd
  .command("status")
  .description("Check if the post-commit hook is installed and up to date")
  .action(async () => {
    const status = await checkHookStale();

    if (!status.installed) {
      console.log(chalk.yellow(`✗ ${status.reason ?? "Hook not installed"}`));
      return;
    }

    if (status.stale) {
      console.log(chalk.yellow("⚠ Hook is installed but stale"));
      console.log(chalk.dim(`Reason: ${status.reason}`));
      console.log(chalk.dim("Run `commitdog hook install` to update it."));
      return;
    }

    console.log(chalk.green("✓ Hook is installed and up to date"));
  });

hookCmd
  .command("uninstall")
  .description("Remove the post-commit hook")
  .action(async () => {
    if (await uninstallHook()) {
      console.log(chalk.green("✓ Hook removed"));
    } else {
      console.log(chalk.yellow("No commitdog hook found"));
    }
  });

// Server commands
const serverCmd = program.command("server").description("Manage the OpenCode server");

serverCmd
  .command("start")
  .description("Start the OpenCode server")
  .action(async () => {
    const config = await loadConfigOrExit();
    const spinner = ora("Starting OpenCode server...").start();
    try {
      const url = await ensureServer(config.server.port);
      spinner.succeed(`Server running at ${url}`);
    } catch (err) {
      spinner.fail(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

serverCmd
  .command("stop")
  .description("Stop the OpenCode server")
  .action(async () => {
    if (await stopServer()) {
      console.log(chalk.green("✓ Server stopped"));
    } else {
      console.log(chalk.yellow("No managed server found"));
    }
  });

serverCmd
  .command("status")
  .description("Check if the OpenCode server is running")
  .action(async () => {
    const config = await loadConfigOrExit();
    const running = await isServerRunning(config.server.port);
    if (running) {
      console.log(chalk.green(`✓ Server running on port ${config.server.port}`));
    } else {
      console.log(chalk.yellow(`✗ No server on port ${config.server.port}`));
    }
  });

program.parse();

async function loadConfigOrExit(): Promise<CommitDogConfig> {
  try {
    return await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Config error: ${message}`));
    process.exit(1);
  }
}

function filterFindingsByConfidence(findings: ReviewFinding[], minConfidence: string): ReviewFinding[] {
  const levels = ["low", "medium", "high"];
  const minIndex = levels.indexOf(minConfidence.toLowerCase());
  if (minIndex === -1) return findings;

  return findings.filter((f) => {
    const idx = levels.indexOf(f.confidence.toLowerCase());
    return idx >= minIndex;
  });
}

function filterFindingsByChangedLines(findings: ReviewFinding[], changedLines: Map<string, number[]>): ReviewFinding[] {
  return findings.filter((f) => {
    const fileLines = changedLines.get(f.file);
    if (!fileLines) {
      // If the file wasn't changed in this diff at all, it's a hallucinated file.
      // We only keep it if the AI is extremely confident.
      return f.confidence === "high";
    }
    // If the specific line wasn't modified in the diff hunks, discard it unless it's high confidence.
    if (!fileLines.includes(f.line)) {
      return f.confidence === "high";
    }
    return true;
  });
}
