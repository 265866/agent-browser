# Dogfood harness

A real model uses a candidate `agent-browser` build to finish realistic browser tasks against local fixture pages. Each scenario has a deterministic check that reads what the fixture server observed and what files the run left on disk. The model's own account of what it did is never the verdict.

The candidate runs next to the model gateway credentials, so run this only on builds whose diff has been reviewed. A tarball needs positive provenance:

- It is `<out>/artifacts/<name>.tgz` from a trusted local CI run, and `<out>/receipt.json` says `untrusted: false` and lists the tarball's name with its SHA-256, which local CI records from the host side. A tarball whose bytes differ from the recorded hash is refused.
- Or you vouch for it by hash with `--package-sha256 <hex>`, for example a tarball from a local CI run older than the recorded hashes. The run refuses a tarball without either and prints the hash to pass after you have reviewed the build.
- Either way, a tarball below any directory whose `receipt.json` says `untrusted: true` is refused: code under test in an `--untrusted` run can write look-alike files, including a receipt claiming trust, inside its own output directory.

A source checkout with `--binary` needs no receipt.

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
<tr><td><code>--package-sha256</code></td><td>Vouches for a reviewed tarball that no trusted local CI receipt lists. Must match the tarball's SHA-256.</td></tr>
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
2. Extracts the package the way npm installs it. The model's `PATH` starts with the guard's `agent-browser` wrapper (step 5), not with the native binary. Browser downloads go to the working directory itself (`AGENT_BROWSER_DOWNLOAD_PATH`), where the checks look, never to the user's Downloads folder.
3. Starts a fixture server on a random loopback port. Pages contain per-run random tokens, so answers cannot be guessed. Starts a forward proxy (`proxy.mjs`) that admits only the fixture server's origin, and launches the candidate's browser through it (`AGENT_BROWSER_PROXY`, with `AGENT_BROWSER_PROXY_BYPASS=<-loopback>`, because Chrome otherwise sends loopback addresses around any proxy). Every other request, including one to the candidate daemon's own loopback stream server, whose `/api/command` relays commands such as a launch with another CDP endpoint, gets a 403. Host `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` (either case) never reach the candidate. Refused requests are saved in `proxy-refused.json`; refused loopback requests are a warning.
4. Runs `agent-browser skills get core` with the candidate and appends its output to the model's system prompt. A failure here fails the scenario.
5. Runs `claude -p` with bounded turns and wall-clock time. Claude Code gets only the Bash, Read, Write, Edit, Glob, and Grep tools (`--tools`), and loads settings only from the throwaway config directory and the guard's settings file (`--setting-sources user --settings`), so settings the model writes into `work/.claude/` are never read (measured with planted project and local hooks). The candidate runs with an empty `AGENT_BROWSER_CONFIG`, and the model is told never to attach to an existing browser. `guard.mjs` enforces the limits before anything runs, at two layers that live outside the working directory, where the model cannot change them. Both fail closed: if the guard itself fails, the call is blocked.
   - A `PreToolUse` hook, in the settings file passed with `claude --settings`, allows only the six tools above. It does not try to understand general shell. A Bash command may contain only `agent-browser` invocations, `sleep <seconds>`, and the core skill's session idioms (`export AGENT_BROWSER_SESSION="$(agent-browser session id ...)"`, `SESSION="$(agent-browser session id ...)"`, a literal session name, or `AGENT_BROWSER_SESSION=<name> agent-browser ...`), joined by `;`, `&&`, or newlines. Words may be plain text, single-quoted, or double-quoted, and the only expansions allowed are `$AGENT_BROWSER_SESSION`, `$SESSION`, and `"$(agent-browser session id ...)"`. The skill's `cat <<'EOF' | agent-browser eval --stdin` form and `agent-browser ... <<'EOF'` are allowed when the heredoc delimiter is quoted, so the body is literal. The only redirects are `2>&1`-style descriptor copies and output to `/dev/null`. Everything else is refused before bash sees it: other programs (`cat` with a file, `cp`, `mv`, `rm`, `mkdir`, `echo`, `printf`, `curl`, interpreters), redirects to files, pipes into other programs, `||`, `&`, subshells, `$'...'` and `$"..."` quoting, brace expansion, globs, `~`, backquotes, other command substitutions, and other variables. Claude Code runs some read-only commands without any allow rule (measured: `curl`, `ls`, `head`), so the hook is what enforces this. The prompt tells the model that its shell runs only agent-browser and sleep, and to use the Read and Write tools for files. File tool paths must be inside the working directory; Write and Edit may not touch `work/.claude/`. Read, Glob, and Grep may also read `projects/` in the throwaway Claude config directory, where Claude Code saves long tool output and tells the model to read it. The model's `PATH` keeps only absolute entries, so no program in the working directory can stand in for one the shell runs.
   - The wrapper named `agent-browser` checks the final arguments. It allows only the browsing subcommands the scenarios and the core skill use (`open`, `click`, `fill`, `snapshot`, `eval`, `screenshot`, `download`, `state`, `network`, `batch`, and the like) and refuses the rest: `connect`, `mcp`, `plugin`, `chat`, `install`, and `upgrade` as attempts to leave the fence, and others the scenarios do not need, such as `dashboard`, `stream`, `doctor`, `profiles`, and `auth`. It reads global flags exactly as the CLI does (including the optional value of `--restore`), allows only harmless ones, and refuses the others, including `--cdp`, `--auto-connect`, `--profile`, `--config`, `--executable-path`, `--namespace`, `--provider`, `--engine`, `--extension`, `--args`, `--proxy`, and `--proxy-bypass`. `--restore`, `--restore-save`, and `--restore-check-*` are allowed, as the core skill recommends; restore state lives in the scenario's throwaway state directory (on Windows, the namespace's directory under the leased profile directory, removed with the scenario). Session and restore names must be 1 to 64 ASCII letters, digits, `-`, or `_`. Arguments that name files (screenshots, downloads, uploads, state, traces, `--download-path`, `--state`) must be inside the working directory and outside `work/.claude/`. URLs the browser would load (`open`, `goto`, `navigate`, `tab new`, `diff url`, `record start`, and any argument that starts with a URL scheme) must be `about:blank` or on the scenario server's origin. Commands inside `batch` (arguments or stdin) are checked the same way. Of the `AGENT_BROWSER_*` variables, the model may set only `AGENT_BROWSER_SESSION`; the harness's own (socket directory, namespace, config, browser, download directory, proxy) must keep their values, and any other is refused, so `AGENT_BROWSER_PLUGINS`, `AGENT_BROWSER_PROVIDER`, and the like cannot reach the candidate. The candidate also gets the harness's `PATH`, `HOME`, and temp and app data directories whatever the model's shell set.
   - On Windows the CLI reaches a session's daemon over TCP. When the session has no `.port` file yet, the CLI connects to a port derived from the namespace and session name, so a chosen name could point it at another program's port, where it would send commands and shutdown requests. The wrapper computes that port the way the CLI does and, without connecting, refuses the call when anything other than the session's own daemon (named by its `.pid` file) listens there.

   `installGuard` copies `guard.mjs` into the scenario's guard directory and the hook and wrapper run that copy, so editing the source tree during a run cannot change a running scenario's guard. A blocked call never starts the candidate: negative controls against the real binary, with a fake CDP endpoint, showed no connection and no program run through the wrapper for `mcp` tool calls, plugin variables, `--executable-path`, `--namespace ""`, `connect`, `--cdp`, and `batch` stdin, each of which connected or ran a program without it. The guard logs each block to `guard-blocked.jsonl`. An attempt to attach or to leave the fence (`attach` and `escape` blocks) makes the scenario an `error`, and so does a guard failure (`guard-error`, logged with its stack); a blocked path, URL, session name, port collision, `file:` URL, tool, or other command is a warning. Deny rules for the common attach forms and a transcript audit remain as further lines.

6. Runs the scenario's check, then closes all sessions and stops any process that still references the run's directories. Removing the scenario's directories is retried for up to 30 seconds while stopping what is left (Windows keeps a running process's files locked). A directory that stays is reported as a warning, not held against the candidate, and the next run's sweep removes it.

A scenario ends as `pass`, `fail` (the check failed), or `error` (the harness or the model service failed before the candidate could be judged, or the model tried to attach to an existing browser). The run passes only when every selected scenario produced a result and passed.

Results go to `<out>/<scenario>/`: the prompt, the appended skill text, the model transcript (`transcript.jsonl`, stream-json), server events and requests, the list of files left in the working directory, what the guard blocked (`guard-blocked.jsonl`), what the proxy refused (`proxy-refused.json`), the guard files the scenario ran (`guard/`, with their SHA-256 under `guard` in `result.json`), and `result.json`. `<out>/receipt.json` summarizes the run, including the tarball's SHA-256 and the harness revision.

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
