# CommitDog

Local AI code review CLI. Orchestrates headless OpenCode server, delegates repo analysis to local agent.

## Architecture

- `src/cli.ts` — Commander entry point. All commands defined inline.
- `src/config.ts` — `.commitdog.yml` load/save. Searches upward from cwd. Deep-merges with defaults.
- `src/opencode/` — OpenCode SDK integration
  - `client.ts` — `runReview()`, `getAvailableModels()`. SSE streaming, session lifecycle.
  - `server.ts` — Process spawn / health check / stop. Detached, PID tracked in `.commitdog/server.pid`.
  - `agent.ts` — System prompt (`REVIEW_AGENT_PROMPT`) + `buildReviewPrompt()`.
- `src/git/` — Git operations
  - `diff.ts` — `git diff/show` parsing into `DiffResult`. Hand-rolled line parser.
  - `hooks.ts` — Post-commit hook install/uninstall. Generates shell script with managed section markers.
- `src/review/` — Output formatting
  - `formatter.ts` — Markdown colorization, report write to `.commitdog/reviews/`, `latest.md`.

## Tech Stack

- TypeScript 6, ESM, Node 22+
- Build: tsup → `dist/cli.js`
- Test: vitest
- Lint: oxlint, Format: oxfmt
- Runtime deps: commander, chalk, ora, execa, yaml, @opencode-ai/sdk

## Conventions

- ESM only. Import paths include `.js` extension.
- Node built-ins over third-party where possible.
- Shell out via `execa`, never raw `child_process`.
- Config defaults in `DEFAULT_CONFIG` object; always deep-merge.
- Spinner pattern: start → update text → stop/succeed/fail. Never leave spinning.
- CLI errors: `chalk.red` + `process.exit(1)`. Hook mode exits 0 even on failure.
- Report timestamps use `ISOString().replace(/[:.]/g, "-")`.

## Anti-Patterns / Gotchas

- `REVIEW_AGENT_PROMPT` is a large markdown template. Preserve exact heading structure and severity labels — the formatter regex depends on them.
- `parseDiff` is regex-based and brittle. Test against real `git diff` output when touching.
- `runReview` SSE event loop has a 5-min safety timeout and complex `settled` flag logic. Race conditions easy to introduce.
- `spawnServer` writes PID to `.commitdog/server.pid`; `stopServer` reads it. PID reuse edge case unhandled.
- Hook script uses `shellQuote` with single-quote escaping. Never inject unsanitized paths.
- `buildReviewPrompt` concatenates user-supplied `rules` and glob patterns directly into prompt. No sanitization — assume trusted config.

## Dogfooding (run locally, then commit)

- **One-time setup**:
  - `npm install`
  - `npm run build`
  - `npm link` (installs the `commitdog` binary on your PATH)
  - `commitdog init` (creates `.commitdog.yml` and selects a model)

- **Review staged changes (recommended loop)**:
  - Stage your work: `git add -p` (or `git add .`)
  - Run: `commitdog review --staged`
  - Read: `.commitdog/reviews/latest.md`
  - Iterate until clean, then commit: `git commit -m "..."` (or your preferred flow)

- **Review last commit**:
  - `commitdog review`

- **Dogfood hook mode** (non-blocking post-commit review):
  - Install: `commitdog hook install`
  - Make a commit as usual; the hook should run `commitdog review --hook` and write `.commitdog/reviews/latest.md`

- **Keeping the hook on the latest code while developing CommitDog**:
  - After changing `src/**`, re-run `npm run build` so `dist/cli.js` is up to date.
  - If you’re using `npm link`, the `commitdog` shim will pick up the updated `dist/cli.js` after rebuilding.
