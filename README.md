# CommitDog

> **Local AI Code Review Agent powered by [OpenCode](https://opencode.ai)**
> Build-time quality reviews, running locally, on your own terms.

CommitDog is a lightweight CLI that integrates into your Git workflow to provide high-quality code reviews locally. Instead of rebuilding LLM integrations or managing provider keys from scratch, CommitDog orchestrates a headless [OpenCode Server](https://opencode.ai/docs/server/) session and delegates the repository analysis to the local agent, which uses its own advanced reasoning and file tools.

---

## Features

- **Powered by OpenCode**: Integrates seamlessly with OpenCode's local environment, supporting 75+ AI models, tool use, and codebase indexing.
- **Non-Blocking Git Hooks**: Runs asynchronously in the background. It will never slow down or block your `git commit` or `git push` operations.
- **Intelligent File Filtering**: Supports `include` and `exclude` glob patterns to focus reviews on source directories while skipping build artifacts, lockfiles, and node modules.
- **Project-Specific Rules**: Inject custom guidelines directly into the reviewer's system prompt (e.g., "Check for SQL injection", "Ensure TypeScript types are explicit").
- **Interactive Model Selector**: Automatically queries OpenCode to present a clean, interactive list of your connected providers and models.
- **Local Reports**: Generates comprehensive markdown reviews and saves them locally under `.commitdog/reviews/` for easy viewing.

---

## Quick Start

### 1. Prerequisites

1. **Install OpenCode CLI**:
   ```bash
   npm i -g opencode-ai
   ```
2. **Set up a Provider & Model**:
   Run `opencode` in your terminal, connect a provider (e.g., GitHub Copilot, OpenAI, Ollama, etc.), and verify it is active.

### 2. Install CommitDog

Clone the repository and build/link the CLI globally:

```bash
git clone https://github.com/jesus/commitdog.git
cd commitdog

# Using pnpm (recommended)
pnpm install && pnpm run build && pnpm link --global

# Or using npm
npm install && npm run build && npm link -g
```

### Developing & Dogfooding

When making edits to `src/**`, rebuild to update your globally linked CLI and git hooks:

```bash
pnpm run build
git add -p
commitdog review --staged
```

### 3. Initialize CommitDog in Your Repository

To set up CommitDog for your project, navigate to your target git repository and run:

```bash
commitdog init
```

This will:

1. Start an OpenCode server (if not already running).
2. Fetch your connected providers and active models.
3. Allow you to select a model interactively.
4. Generate a `.commitdog.yml` configuration file in the project root.

> [!IMPORTANT]
> **Ensure OpenCode is configured first!** Before running `commitdog init`, make sure you have run the `opencode` CLI/UI at least once to authenticate and connect a provider (like GitHub Copilot, OpenAI, Ollama, etc.) with active models. If no active models are configured in OpenCode, the initialization command will fall back to a default configuration.

---

## CLI Reference

### `commitdog` (or `commitdog review`)

Runs a code review on your repository.

- **Default**: Reviews the changes in the **last commit**.
- `--staged`: Reviews currently **staged changes** instead of the last commit.
- `--hook`: Runs in background, non-blocking mode (used by Git hook).
- `--quick`: Runs in quick review mode. This disables AI tool-calling, relying entirely on the pre-collected local diff context for a faster review.
- `--min-confidence <level>`: Minimum confidence level of findings to report (`low`, `medium`, `high`). Defaults to `medium`.

```bash
# Review last commit
commitdog

# Review staged files
commitdog review --staged

# Review with lower confidence threshold
commitdog review --min-confidence low
```

### `commitdog model`

View or interactively change the active AI model.

```bash
# Interactively pick a model
commitdog model

# Manually set a model
commitdog model github-copilot/claude-sonnet-4.5
```

### `commitdog hook install | uninstall`

Installs or removes a managed post-commit Git hook that runs reviews automatically and asynchronously in the background.

```bash
# Install non-blocking post-commit review hook
commitdog hook install

# Uninstall the hook
commitdog hook uninstall
```

*Runs reviews asynchronously in the background via `nohup` (`--quick` mode enabled), saving execution output to `.commitdog/hook.log` and the latest report to `.commitdog/reviews/latest.md`. It returns control to your terminal instantly (ensuring `git commit` has zero delay) and avoids clobbering any existing post-commit hook scripts.*

### `commitdog server start | stop | status`

Manually manage the OpenCode server lifecycle.

```bash
# Check if OpenCode serve is running
commitdog server status

# Start it manually
commitdog server start

# Stop the server
commitdog server stop
```

---

## Configuration (`.commitdog.yml`)

Your `.commitdog.yml` configures everything for CommitDog in your project:

```yaml
# Model to use for reviews (provider/model)
model: github-copilot/claude-sonnet-4.5

# OpenCode server settings
server:
  port: 4096
  auto_start: true

# Review scope
include:
  - "src/**/*"
  - "lib/**/*"

exclude:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/*.lock"
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/build/**"

# Custom project-specific review rules
rules:
  - "Check for potential security vulnerabilities like SQL injection or SSRF"
  - "Flag any hardcoded secrets, tokens, or private keys"
  - "Suggest readability and architectural improvements where relevant"
```

---

## License

MIT © [Jesus](https://github.com/jesus)
