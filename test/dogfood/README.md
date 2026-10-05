# Dogfood harness

A real model uses a candidate `agent-browser` binary to finish realistic browser tasks against local fixture pages. Each scenario has a deterministic check that reads what the fixture server observed and what files the run left on disk. The model's own account of what it did is never the verdict.

## Usage

```bash
export ANTHROPIC_BASE_URL=...            # plus ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY

node test/dogfood/run.mjs --list
node test/dogfood/run.mjs --binary ./agent-browser.exe                       # native
node test/dogfood/run.mjs --platform linux --binary ./agent-browser-linux-x64  # Docker
node test/dogfood/run.mjs --platform macos --remote macbook --binary ./agent-browser-darwin-arm64
node test/dogfood/run.mjs --binary ./agent-browser --scenarios form-fill,tabs
```

The local CI `global-install` jobs leave each platform's release binary in `<out>/artifacts/`.

Options: `--model` (default `claude-opus-5-5`, env `DOGFOOD_MODEL`), `--concurrency` (default 3), `--out`, `--sha` (recorded in the receipt), `--chrome-version`.

## What one scenario run does

1. Creates a throwaway root with its own working directory, `HOME` (Linux and macOS), `TMPDIR`, Claude config directory, and socket directory. `AGENT_BROWSER_*` and `CLAUDE_*` variables from the host are dropped.
2. Starts a fixture server on a random loopback port. Pages contain per-run random tokens, so answers cannot be guessed.
3. Runs `agent-browser skills get core` with the candidate binary and appends its output to the model's system prompt. A failure here fails the scenario.
4. Runs `claude -p` with bounded turns and wall-clock time. The model may only run `agent-browser` (plus `sleep`, `ls`, `cat`) and file tools.
5. Runs the scenario's check, then closes all sessions and stops any process that still references the run's directories.

Results go to `<out>/<scenario>/`: the prompt, the appended skill text, the model transcript (`transcript.jsonl`, stream-json), server events and requests, the list of files left in the working directory, and `result.json`. `<out>/receipt.json` summarizes the run.

## Adding a scenario

Add `scenarios/<id>.mjs` exporting `{ id, title, families, maxTurns, timeoutSec, tokens, files, routes?, prompt, check }`. `check` receives `{ events, requests, tokens, base, file, path, agentBrowser }` and returns a list of failure reasons (empty means pass). Fixture pages report observations with `__report({...})` after including `LOG_JS` from `server.mjs`.

Add a targeted scenario for each behavior change, and keep checks independent of how the model chose to solve the task.
