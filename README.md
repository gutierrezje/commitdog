# 🐕 CommitDog

> **Local AI Code Review Agent powered by [OpenCode](https://opencode.ai)**
> Build-time quality reviews, running locally, on your own terms.

CommitDog is a thin, extremely fast CLI that hooks into your Git workflow to provide CodeRabbit-quality code reviews locally. Instead of rebuilding LLM logic or managing API integrations from scratch, CommitDog orchestrates a headless [OpenCode Server](https://opencode.ai/docs/server/) session and lets the local agent explore your codebase using its own advanced tools.

---

## ✨ Features

- **🧠 Powered by OpenCode**: Reuses OpenCode's comprehensive local environment, 75+ model integrations, tool use, and codebase index.
- **⚡ Non-Blocking Git Hooks**: Reviews run asynchronously in a separate terminal tab or in the background when committing. It will never slow down your `git commit` or `git push`.
- **🎯 Intelligent File Filtering**: Supports `include` and `exclude` glob patterns to focus reviews on source directories while skipping build artifacts, lockfiles, and node modules.
- **🛠️ Project-Specific Rules**: Inject custom guidelines directly into the reviewer's system prompt (e.g., "Check for SQL injection", "Ensure TypeScript types are explicit").
- **💻 Interactive Setup & Model Selector**: Automatically queries OpenCode to present an interactive list of your connected providers and models.
- **📄 Markdown Reports**: Generates comprehensive markdown reviews and saves them locally under `.commitdog/reviews/` for easy viewing.

---

## 🚀 Quick Start

### 1. Prerequisites

1. **Install OpenCode CLI**:
   ```bash
   npm i -g opencode-ai
   ```
2. **Set up a Provider & Model**:
   Run `opencode` in your terminal, connect a provider (e.g., GitHub Copilot, OpenAI, Ollama, etc.), and verify it's active.

### 2. Install CommitDog

Clone the repository and install dependencies locally, or run the built CLI:

```bash
# Clone and build
git clone https://github.com/jesus/commitdog.git
cd commitdog
npm install
npm run build
```

Link or run it globally:
```bash
npm link
```

### 3. Initialize CommitDog in Your Repository

To set up CommitDog for your project, run:

```bash
commitdog init
```

This will:
1. Start an OpenCode server (if not already running).
2. Fetch your connected providers and active models.
3. Let you interactively select the model you want to use.
4. Generate a `.commitdog.yml` configuration file in the project root.

---

## 📖 CLI Reference

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

## ⚙️ Configuration (`.commitdog.yml`)

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

## 🛡️ License

MIT © [Jesus](https://github.com/jesus)
