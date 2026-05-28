#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, saveConfig, configExists } from "./config.js";
import { runReview } from "./opencode/client.js";
import { ensureServer, isServerRunning, stopServer } from "./opencode/server.js";
import { installHook, uninstallHook, isHookInstalled } from "./git/hooks.js";
import { isGitRepo, hasCommits, getStagedDiff } from "./git/diff.js";
import {
  printHeader,
  printChunk,
  printFooter,
  writeMarkdownReport,
} from "./review/formatter.js";

const program = new Command();

program
  .name("commitdog")
  .description("🐕 Local AI code review agent powered by OpenCode")
  .version("0.1.0");

// Default command: review last commit
program
  .command("review", { isDefault: true })
  .description("Review the last commit or staged changes")
  .option("--staged", "Review staged changes instead of last commit")
  .option("--hook", "Running from git hook (non-blocking mode)")
  .action(async (options) => {
    // Preflight checks
    if (!(await isGitRepo())) {
      console.error(chalk.red("Not a git repository"));
      process.exit(1);
    }

    // First run: prompt for setup
    if (!configExists()) {
      console.log(chalk.yellow("No .commitdog.yml found. Running first-time setup...\n"));
      await runInit();
    }

    const config = await loadConfig();
    const mode = options.staged ? "staged" : "last-commit";

    if (mode === "last-commit" && !(await hasCommits())) {
      console.error(chalk.red("No commits found in this repository"));
      process.exit(1);
    }

    if (mode === "staged") {
      const diff = await getStagedDiff();
      if (diff.files.length === 0) {
        console.log(chalk.yellow("No staged changes to review"));
        process.exit(0);
      }
    }

    printHeader();

    const spinner = ora({
      text: "Connecting to OpenCode...",
      color: "cyan",
    }).start();

    try {
      // Ensure server and start review
      await ensureServer(config.server.port);
      spinner.text = "Reviewing changes...";
      spinner.stop();
      console.log(); // Space after spinner

      const review = await runReview({
        mode,
        config,
        onChunk: (chunk) => printChunk(chunk),
      });

      // Write markdown report
      const reportPath = await writeMarkdownReport(review);
      printFooter(review, reportPath);
    } catch (err) {
      spinner.stop();
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nReview failed: ${message}`));
      if (message.includes("opencode not found")) {
        console.log(chalk.dim("Install: npm i -g opencode-ai"));
        console.log(chalk.dim("Docs: https://opencode.ai/docs/"));
      }
      process.exit(1);
    }
  });

// Init command
program
  .command("init")
  .description("Set up CommitDog for this project")
  .action(async () => {
    await runInit();
  });

async function runInit() {
  console.log(chalk.bold("🐕 CommitDog Setup\n"));

  // For now, use a default model. In v2, we'll query OpenCode for available models.
  const config = await loadConfig();

  // Prompt-like output (we'll make this interactive with inquirer later)
  console.log(chalk.dim("Using default model: ") + chalk.cyan(config.model));
  console.log(chalk.dim("Change later with: ") + chalk.cyan("commitdog model"));
  console.log();

  const configPath = await saveConfig(config);
  console.log(chalk.green(`✓ Config saved to ${configPath}`));
  console.log();
}

// Model command
program
  .command("model")
  .description("View or change the AI model")
  .argument("[model]", "Model to use (e.g., anthropic/claude-sonnet-4-20250514)")
  .action(async (model?: string) => {
    const config = await loadConfig();

    if (!model) {
      console.log(chalk.bold("Current model: ") + chalk.cyan(config.model));
      console.log(chalk.dim("\nChange with: commitdog model <provider/model>"));
      console.log(chalk.dim("Example: commitdog model openai/gpt-4o"));
      return;
    }

    config.model = model;
    const configPath = await saveConfig(config);
    console.log(chalk.green(`✓ Model set to ${chalk.cyan(model)}`));
    console.log(chalk.dim(`Config: ${configPath}`));
  });

// Hook commands
const hookCmd = program
  .command("hook")
  .description("Manage git hooks");

hookCmd
  .command("install")
  .description("Install post-commit hook (non-blocking review)")
  .action(async () => {
    if (!(await isGitRepo())) {
      console.error(chalk.red("Not a git repository"));
      process.exit(1);
    }

    if (await isHookInstalled()) {
      console.log(chalk.yellow("Hook already installed"));
      return;
    }

    const hookPath = await installHook();
    console.log(chalk.green(`✓ Post-commit hook installed: ${hookPath}`));
    console.log(chalk.dim("Reviews will run automatically after each commit (non-blocking)"));
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
const serverCmd = program
  .command("server")
  .description("Manage the OpenCode server");

serverCmd
  .command("start")
  .description("Start the OpenCode server")
  .action(async () => {
    const config = await loadConfig();
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
    const config = await loadConfig();
    const running = await isServerRunning(config.server.port);
    if (running) {
      console.log(chalk.green(`✓ Server running on port ${config.server.port}`));
    } else {
      console.log(chalk.yellow(`✗ No server on port ${config.server.port}`));
    }
  });

program.parse();
