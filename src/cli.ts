#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig, configExists } from "./config.js";
import { runReview, getAvailableModels } from "./opencode/client.js";
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

  const config = await loadConfig();

  const spinner = ora("Querying available models from OpenCode...").start();
  let models: string[] = [];
  try {
    models = await getAvailableModels(config.server.port);
    spinner.stop();
  } catch (err) {
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
          chalk.yellow(`Select a model number (1-${models.length}) [default: 1]: `)
        );
        const trimmed = answer.trim();
        if (trimmed === "") {
          selectedModel = models[0];
          break;
        }
        const num = parseInt(trimmed, 10);
        if (num >= 1 && num <= models.length) {
          selectedModel = models[num - 1];
          break;
        }
        console.log(chalk.red("Invalid selection. Please enter a valid number."));
      }
    } finally {
      rl.close();
    }
  } else {
    console.log(chalk.yellow("No active/connected providers found in OpenCode."));
    console.log(chalk.dim("Make sure you run ") + chalk.cyan("opencode") + chalk.dim(" to authenticate and set up your providers/keys first."));
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
    const config = await loadConfig();

    if (!model) {
      console.log(chalk.bold("Current model: ") + chalk.cyan(config.model));
      
      const spinner = ora("Querying available models from OpenCode...").start();
      let models: string[] = [];
      try {
        models = await getAvailableModels(config.server.port);
        spinner.stop();
      } catch (err) {
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
              chalk.yellow(`Select a model number (1-${models.length}) or press Enter to keep current: `)
            );
            const trimmed = answer.trim();
            if (trimmed === "") {
              break; // Keep current model
            }
            const num = parseInt(trimmed, 10);
            if (num >= 1 && num <= models.length) {
              const newModel = models[num - 1];
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
