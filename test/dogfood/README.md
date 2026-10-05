# Dogfood harness

A real model uses a candidate `agent-browser` build to finish realistic browser tasks against local fixture pages. Each scenario has a deterministic check that reads what the fixture server observed and what files the run left on disk. The model's own account of what it did is never the verdict.

The candidate runs next to the model gateway credentials, so run this only on builds whose diff has been reviewed.

## Usage

```bash
export ANTHROPIC_BASE_URL=...            # plus ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY

node test/dogfood/run.mjs --list
node test/dogfood/run.mjs --package <out>/artifacts/agent-browser-0.38.2.tgz              # native
node test/dogfood/run.mjs --platform linux --package <linux out>/artifacts/agent-browser-0.38.2.tgz
node test/dogfood/run.mjs --platform macos --remote macbook --package <macos out>/artifacts/agent-browser-0.38.2.tgz
node test/dogfood/run.mjs --package . --binary cli/target/release/agent-browser.exe       # source checkout plus a dev build
node test/dogfood/run.mjs --package <tgz> --scenarios form-fill,tabs
```

The local CI `global-install` jobs leave each platform's packed npm tarball, which contains that platform's release binary, in `<out>/artifacts/`. Container and remote runs accept only a tarball.

<table>
<tr><th>Option</th><th>Meaning</th></tr>
<tr><td><code>--package</code></td><td>The candidate: an npm tarball, or a source checkout together with <code>--binary</code>. Required.</td></tr>
<tr><td><code>--binary</code></td><td>Native binary to place in the package's <code>bin/</code> (native runs only).</td></tr>
<tr><td><code>--platform</code></td><td><code>native</code> (default), <code>linux</code> (Docker), or <code>macos</code> (with <code>--remote</code>).</td></tr>
<tr><td><code>--scenarios a,b</code></td><td>Run only these scenarios.</td></tr>
<tr><td><code>--model</code></td><td>Default <code>claude-opus-5-5</code> (env <code>DOGFOOD_MODEL</code>).</td></tr>
<tr><td><code>--concurrency</code></td><td>Scenarios run at once (default 3).</td></tr>
<tr><td><code>--work-root</code></td><td>Where per-scenario throwaway roots go (env <code>DOGFOOD_WORK_ROOT</code>, default the OS temp dir).</td></tr>
<tr><td><code>--cache</code></td><td>Chrome for Testing cache (env <code>DOGFOOD_CACHE</code>). Kept separate from local CI caches.</td></tr>
<tr><td><code>--out</code>, <code>--sha</code>, <code>--chrome-version</code></td><td>Output directory, commit recorded in the receipt, Chrome for Testing version.</td></tr>
</table>

## What one scenario run does

1. Creates a throwaway root with its own working directory, `HOME` (Linux and macOS), `TMPDIR`, `LOCALAPPDATA` and `APPDATA` (Windows), Claude config directory, and socket directory. Host `AGENT_BROWSER_*`, `CLAUDE_*`, and credential-shaped variables are dropped; only the model gateway variables are passed on.
2. Extracts the package the way npm installs it and puts the native binary on `PATH` as `agent-browser`.
3. Starts a fixture server on a random loopback port. Pages contain per-run random tokens, so answers cannot be guessed.
4. Runs `agent-browser skills get core` with the candidate and appends its output to the model's system prompt. A failure here fails the scenario.
5. Runs `claude -p` with bounded turns and wall-clock time. The model may run only `agent-browser` and `sleep` in Bash, plus Claude Code's file tools. Allow rules do not confine those tools to the working directory, so deny rules block them from the real home directory. On Windows, where the model's home is the real profile, `--work-root` must be outside the user profile.
6. Runs the scenario's check, then closes all sessions and stops any process that still references the run's directories.

A scenario ends as `pass`, `fail` (the check failed), or `error` (the harness or the model service failed before the candidate could be judged).

Results go to `<out>/<scenario>/`: the prompt, the appended skill text, the model transcript (`transcript.jsonl`, stream-json), server events and requests, the list of files left in the working directory, and `result.json`. `<out>/receipt.json` summarizes the run, including the tarball's SHA-256.

## Writing checks

Checks judge the end state, and they are written so the observed state cannot come from a shortcut:

- Values the model must report come from per-run tokens, and delayed values are released by the server only after the triggering action.
- Clicks and key presses are reported with `event.isTrusted`, which is false for events dispatched from page script.
- Downloads must arrive as a browser navigation (`sec-fetch-mode: navigate`), and pages keep their own reference to `fetch` from load time.
- Where server logs cannot prove the behavior (restoring saved state in a new browser), the check runs the candidate itself.

Each scenario may also list `uses`, groups of subcommands it exists to exercise. When the transcript shows none of a group, the result carries a warning (not a failure), which flags a run that routed around a broken command.

`pnpm run test:harness` runs every check against an empty run and requires it to fail.

## Adding a scenario

Add `scenarios/<id>.mjs` exporting `{ id, title, families, uses?, maxTurns, timeoutSec, tokens, files, routes?, prompt, check }`. `check` receives `{ events, requests, tokens, base, file, path, agentBrowser }` and returns a list of failure reasons (empty means pass). Fixture pages report observations with `__report({...})` after including `LOG_JS` from `server.mjs`. Routes receive `{ req, url, body, ctx }`, where `ctx` holds the run's tokens and can carry state between requests.

Add a targeted scenario for each behavior change, and keep checks independent of how the model chose to solve the task.
