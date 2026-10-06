# Dogfood harness

A real model uses a candidate `agent-browser` build to finish realistic browser tasks against local fixture pages. Each scenario has a deterministic check that reads what the fixture server observed and what files the run left on disk. The model's own account of what it did is never the verdict.

The candidate runs next to the model gateway credentials, so run this only on builds whose diff has been reviewed. The harness refuses a tarball from an `--untrusted` local CI run (one whose `<out>/receipt.json` says `untrusted: true`); such runs keep no package in the first place.

## Usage

```bash
export ANTHROPIC_BASE_URL=...            # plus ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY

pnpm dogfood --list
pnpm dogfood --package <out>/artifacts/agent-browser-0.38.2.tgz              # native
pnpm dogfood --platform linux --package <linux out>/artifacts/agent-browser-0.38.2.tgz
pnpm dogfood --platform macos --remote macbook --package <macos out>/artifacts/agent-browser-0.38.2.tgz
pnpm dogfood --package . --binary cli/target/release/agent-browser.exe       # source checkout plus a dev build
pnpm dogfood --package <tgz> --scenarios form-fill,tabs
```

`pnpm dogfood` runs `node test/dogfood/run.mjs`. pnpm first installs the workspace dependencies when they are missing; in a fresh checkout, `node test/dogfood/run.mjs` with the same arguments starts at once.

The container and the remote Mac need a gateway URL they can reach. A loopback `ANTHROPIC_BASE_URL` (`127.0.0.1` or `localhost`) works only for native runs: inside the container and on the Mac, loopback is that machine itself, so the model calls fail and every scenario ends as `error`.

The local CI `global-install` jobs leave each platform's packed npm tarball, which contains that platform's release binary, in `<out>/artifacts/`. Container and remote runs accept only a tarball.

<table>
<tr><th>Option</th><th>Meaning</th></tr>
<tr><td><code>--package</code></td><td>The candidate: an npm tarball, or a source checkout together with <code>--binary</code>. Required.</td></tr>
<tr><td><code>--binary</code></td><td>Native binary to place in the package's <code>bin/</code> (native runs only).</td></tr>
<tr><td><code>--platform</code></td><td><code>native</code> (default), <code>linux</code> (Docker), or <code>macos</code> (with <code>--remote</code>).</td></tr>
<tr><td><code>--scenarios a,b</code></td><td>Run only these scenarios.</td></tr>
<tr><td><code>--model</code></td><td>Default <code>claude-opus-5-5</code> (env <code>DOGFOOD_MODEL</code>).</td></tr>
<tr><td><code>--concurrency</code></td><td>Scenarios run at once: a whole number, at least 1 (default 3).</td></tr>
<tr><td><code>--work-root</code></td><td>Where per-scenario throwaway roots go (env <code>DOGFOOD_WORK_ROOT</code>). It must be outside the home directory. Defaults to the OS temp dir on Linux and macOS; required on Windows, where the temp dir is inside the user profile.</td></tr>
<tr><td><code>--cache</code></td><td>Chrome for Testing cache (env <code>DOGFOOD_CACHE</code>). Kept separate from local CI caches.</td></tr>
<tr><td><code>--remote</code>, <code>--remote-root</code></td><td>SSH host for <code>--platform macos</code>, and the directory there (default <code>~/abw-zero</code>; see Remote Mac).</td></tr>
<tr><td><code>--out</code>, <code>--sha</code>, <code>--chrome-version</code></td><td>Output directory, commit recorded in the receipt, Chrome for Testing version.</td></tr>
</table>

## What one scenario run does

1. Creates a throwaway root with its own working directory, `HOME` (Linux and macOS), `TMPDIR`, `LOCALAPPDATA` and `APPDATA` (Windows), Claude config directory, socket directory, and `AGENT_BROWSER_NAMESPACE`. Host `AGENT_BROWSER_*`, `CLAUDE_*`, and credential-shaped variables are dropped; only the model gateway variables are passed on. On Windows the CLI keeps some state in `%USERPROFILE%\.agent-browser` whatever the environment says, so dogfood shares local CI's profile lease (see `test/local-ci/README.md`) and does not run while that directory belongs to you.
2. Extracts the package the way npm installs it. The model's `PATH` starts with the guard's `agent-browser` wrapper (step 5), not with the native binary. Browser downloads go to `downloads/` in the working directory (`AGENT_BROWSER_DOWNLOAD_PATH`), never to the user's Downloads folder.
3. Starts a fixture server on a random loopback port. Pages contain per-run random tokens, so answers cannot be guessed.
4. Runs `agent-browser skills get core` with the candidate and appends its output to the model's system prompt. A failure here fails the scenario.
5. Runs `claude -p` with bounded turns and wall-clock time. The model may run only `agent-browser` and `sleep` in Bash, plus Claude Code's file tools. The candidate runs with an empty `AGENT_BROWSER_CONFIG`, and the model is told never to attach to an existing browser. `guard.mjs` enforces the limits before anything runs, at two layers that live outside the working directory, where the model cannot change them:
   - A `PreToolUse` hook, in the settings file passed with `claude --settings`, rejects a Bash command whose text attaches to an existing browser (`connect`, `--cdp`, `--auto-connect`, `--profile`, `--config`, or the matching `AGENT_BROWSER_*` variables), contains a `file:` URL, names a path outside the working directory, or uses a variable such as `$HOME`. It also rejects a file tool call whose path is outside the working directory. Allow rules alone do not confine the file tools (verified), and Claude Code runs some shell commands on its own, such as `printf` with a redirect, so the hook checks the text of every command.
   - The wrapper named `agent-browser` checks the final arguments, after the shell has expanded variables, with the same rules. It also refuses changes to the harness's `AGENT_BROWSER_*` settings (socket directory, namespace, config, browser, download directory). Then it runs the real binary. `AGENT_BROWSER_SESSION` and other variables stay the model's to set.

   A blocked call never starts the candidate. The guard logs each one to `guard-blocked.jsonl`. An attempt to attach makes the scenario an `error`; a blocked path or `file:` URL is a warning. Deny rules for the common attach forms and a transcript audit remain as further lines.

6. Runs the scenario's check, then closes all sessions and stops any process that still references the run's directories.

A scenario ends as `pass`, `fail` (the check failed), or `error` (the harness or the model service failed before the candidate could be judged, or the model tried to attach to an existing browser). The run passes only when every selected scenario produced a result and passed.

Results go to `<out>/<scenario>/`: the prompt, the appended skill text, the model transcript (`transcript.jsonl`, stream-json), server events and requests, the list of files left in the working directory, what the guard blocked (`guard-blocked.jsonl`), and `result.json`. `<out>/receipt.json` summarizes the run, including the tarball's SHA-256.

## Remote Mac

`--platform macos --remote HOST` copies the harness and the tarball to `--remote-root` on the Mac, passes the gateway variables over ssh stdin into a file that the remote run deletes as soon as it has read it, runs there, and copies the results back. The remote command runs in a login shell that is not interactive (`zsh -lc`), so `node` and `claude` must be on the PATH that `~/.zprofile` sets. Each run removes its own `df-*` directory. Chrome for Testing stays in `abdf-cache` for later runs. "Remote Mac" in `test/local-ci/README.md` lists everything that stays under that directory and how to remove it.

## Writing checks

Checks judge the end state, and they are written so the observed state is hard to produce by a shortcut (page script with full page access could still fake some of it, which the `uses` warnings help surface):

- Fixture logic runs inside a closure (`pageScript` in `server.mjs`), so nothing on `window` reports observations, and the server records which page sent each event.

- Values the model must report come from per-run tokens, and delayed values are released by the server only after the triggering action.
- Clicks and key presses are reported with `event.isTrusted`, which is false for events dispatched from page script.
- Downloads must arrive as a browser navigation (`sec-fetch-mode: navigate`), and pages keep their own reference to `fetch` from load time.
- Where server logs cannot prove the behavior (restoring saved state in a new browser), the check runs the candidate itself.

Each scenario may also list `uses`, groups of subcommands it exists to exercise. When the transcript shows none of a group, the result carries a warning (not a failure), which flags a run that routed around a broken command.

`pnpm run test:harness` runs every check against an empty run and requires it to fail.

## Adding a scenario

Add `scenarios/<id>.mjs` exporting `{ id, title, families, uses?, maxTurns, timeoutSec, tokens, files, routes?, prompt, check }`. `check` receives `{ events, requests, tokens, base, file, path, agentBrowser }` and returns a list of failure reasons (empty means pass). Fixture pages report observations by calling `report({...})` inside `pageScript(body)` from `server.mjs`; bind handlers inside the closure rather than in HTML attributes. Routes receive `{ req, url, body, ctx }`, where `ctx` holds the run's tokens and can carry state between requests.

Add a targeted scenario for each behavior change, and keep checks independent of how the model chose to solve the task.
