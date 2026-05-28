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

Clone the repository and install dependencies locally, or build the CLI:

```bash
# Clone and build
git clone https://github.com/jesus/commitdog.git
cd commitdog
npm install
npm run build
```

Link the package globally:

```bash
npm link
```

### Developing / dogfooding CommitDog (on this repo)

If you’re working on CommitDog itself, the simplest loop is:

```bash
# after editing src/**
npm run build

# review your staged changes
git add -p
commitdog review --staged
```

Notes:

- `npm link` installs the `commitdog` shim globally, and it runs `dist/cli.js` from this checkout.
- When you change `src/**`, re-run `npm run build` so `dist/` stays in sync (this also keeps the post-commit hook using the newest code).

### 3. Initialize CommitDog in Your Repository

To set up CommitDog for your project, run:

```bash
commitdog init
```

This will:

1. Start an OpenCode server (if not already running).
2. Fetch your connected providers and active models.
3. Allow you to select a model interactively.
4. Generate a `.commitdog.yml` configuration file in the project root.

---

## CLI Reference

### `commitdog` (or `commitdog review`)

Runs a code review on your repository.

- **Default**: Reviews the changes in the **last commit**.
- `--staged`: Reviews currently **staged changes** instead of the last commit.
- `--hook`: Runs in background, non-blocking mode (used by Git hook).

```bash
# Review last commit
commitdog

# Review staged files
commitdog review --staged
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

Installs or removes the post-commit Git hook.

```bash
# Install non-blocking post-commit review hook
commitdog hook install

# Uninstall the hook
commitdog hook uninstall
```

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

## Auto Run After Committing

You can set CommitDog up to run automatically in the background after you commit.

### Option A: Built-in git hook installer (recommended)

```bash
commitdog hook install
```

This installs a managed `.git/hooks/post-commit` section that runs `commitdog review --hook` via `nohup` and logs to `.commitdog/hook.log`.

### Option B: Husky

### 1. Install & Initialize Husky

If Husky is not already configured in your project, install it and run the initialization:

```bash
npm install husky --save-dev
npx husky init
```

### 2. Configure the post-commit Hook

Create or edit the `post-commit` hook in your `.husky/` directory to execute CommitDog in background mode:

```bash
echo "commitdog review --hook &" > .husky/post-commit
```

_Note: The trailing `&` is required. It forks the `commitdog` process into the background, returning control to your terminal instantly so your `git commit` completes without delay._

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
