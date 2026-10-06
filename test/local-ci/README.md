# Local CI

Runs every job in `.github/workflows/ci.yml` against a git ref on the machines you have, and writes a receipt. It replaces hosted CI for forks that keep GitHub Actions disabled, and it covers the push-only jobs (`rust-cross`, `native-e2e`, `windows-integration`, `global-install`) that pull requests never run.

## Usage

```bash
node test/local-ci/run.mjs --platform linux   --ref origin/main
node test/local-ci/run.mjs --platform windows --ref origin/main      # on a Windows host
node test/local-ci/run.mjs --platform macos   --ref origin/main      # on a Mac
node test/local-ci/run.mjs --platform macos   --ref origin/main --remote macbook
node test/local-ci/run.mjs --platform all     --ref origin/main --remote macbook
```

Options:

<table>
<tr><th>Option</th><th>Meaning</th></tr>
<tr><td><code>--ref</code></td><td>Any commit-ish. The run resolves it to a SHA first and records both.</td></tr>
<tr><td><code>--jobs a,b</code></td><td>Run only these job ids (see <code>jobs.mjs</code>).</td></tr>
<tr><td><code>--no-extra</code></td><td>Skip the checks that <code>ci.yml</code> does not run.</td></tr>
<tr><td><code>--out DIR</code></td><td>Receipt and log directory. Defaults to a new directory under the OS temp dir.</td></tr>
<tr><td><code>--slot N</code></td><td>Build-cache slot. A run holds its slot exclusively; a second run on the same slot waits until it is free.</td></tr>
<tr><td><code>--remote HOST</code></td><td>Run the macOS leg on <code>HOST</code> over SSH. The commit must be fetchable from <code>origin</code> there.</td></tr>
<tr><td><code>--work-root DIR</code></td><td>Where worktrees and build caches go (env <code>LOCAL_CI_WORK_ROOT</code>). Keep it short on Windows.</td></tr>
<tr><td><code>--cache DIR</code></td><td>Package-manager caches and Chrome for Testing (env <code>LOCAL_CI_CACHE</code>).</td></tr>
<tr><td><code>--untrusted</code></td><td>The ref's code has not been reviewed. Only the Linux leg is allowed, with cache volumes separate from trusted runs (<code>abci-u-*</code>).</td></tr>
<tr><td><code>--job-timeout-min N</code></td><td>Per-job time limit (default 120). A timed-out job fails.</td></tr>
</table>

The exit code is 0 only when every selected job passes.

## Trust

The Windows and macOS legs run the ref's code directly on the host, with the host's network and files. Run them only for code that someone has reviewed. Unreviewed refs (for example a fresh pull request) go through `--untrusted`, which runs only in Docker, mounts no credentials, and keeps its own caches so it cannot poison caches that later trusted runs read.

An untrusted run protects the host, not the result: the code under test runs as root in the same container as the runner and could rewrite its own receipt. Treat an untrusted receipt as a quick signal, and gate on a trusted run after review.

Interrupting a run (Ctrl-C, SIGTERM, or a dropped SSH connection to the Mac) stops the active step's processes and removes the job's worktree and scratch directories. The remote leg runs under a pseudo-terminal, and a wrapper script forwards the hangup to the remote runner. A run killed outright (for example by TerminateProcess on Windows) leaves its directories behind; the next run on the same work root removes them.

## Where each job runs

<table>
<tr><th>Platform</th><th>How</th><th>Jobs</th></tr>
<tr><td>Linux</td><td><code>linux/amd64</code> Docker container built from <code>linux.Dockerfile</code>. It receives only a <code>git archive</code> of the commit: no <code>.git</code> directory and no credentials. Cargo registry, build output, and package caches live in named volumes (<code>abci-*</code>).</td><td>version-sync, launcher, rust, dashboard, sandbox-package, eve-package, native-e2e, global-install (ubuntu)</td></tr>
<tr><td>Windows</td><td>Native, one throwaway <code>git worktree</code> per job.</td><td>rust-cross (x86_64-pc-windows-msvc), windows-integration, global-install (windows)</td></tr>
<tr><td>macOS</td><td>Native, one throwaway <code>git worktree</code> per job.</td><td>rust-cross (aarch64 and x86_64), global-install (macos)</td></tr>
</table>

Extra checks, reported separately as `extraResult`: clippy and the native e2e suite on Windows and macOS. `ci.yml` only runs these on Linux, but platform-specific code paths compile and behave differently.

## Isolation

- Jobs start from the host environment with every `AGENT_BROWSER_*` variable and anything credential-shaped (tokens, keys, passwords, cloud and model provider variables) removed. See `isolation.mjs`.
- npm global installs go to a throwaway prefix (`npm_config_prefix`), never the host's global tree.
- Temporary files, including Chrome's temporary profiles, go to the job's scratch directory (`TMPDIR`, `TMP`, `TEMP`).
- On Linux and macOS each job gets a throwaway `HOME`, so `agent-browser install` and session state stay inside the job.
- On Windows, `LOCALAPPDATA` and `APPDATA` point at empty scratch directories, so Chrome profile discovery cannot find the user's browser profiles.
- Windows resolves the profile directory through the Known Folder API, so no variable can move `%USERPROFILE%\.agent-browser`. Code under test (`windows-integration`'s `install`, e2e tests that save auth or sessions) writes there. Each run holds a lease: if the directory did not exist, the harness creates it with an ownership marker and removes it when the last concurrent harness run finishes. A directory without the marker belongs to the user and is never removed. A lock also serializes `windows-integration` across concurrent runs.
- Cross-run locks (build slots, the `windows-integration` lock, the profile lease) are exclusive listeners on `127.0.0.1`, on a port between 20000 and 31999 derived from the lock's name. The operating system frees a lock when its holder exits, even after a hard kill. If another program already listens on a lock's port, the run waits and then fails with a message naming the port.
- Browser tests on Windows and macOS use a Chrome for Testing build pinned through `AGENT_BROWSER_EXECUTABLE_PATH`, never a system Chrome.
- After each job, and when a step times out, the runner stops processes whose image path or command line contains that job's unique directories. On Linux and macOS each step leads its own process group, so a timeout also stops grandchildren.

## Known differences from hosted CI

- Line endings follow the host's git configuration. GitHub's Windows runners check out with `core.autocrlf=true`.
- `needs:` is honored within a platform. Cross-platform dependencies (for example `windows-integration` waiting on the macOS `rust-cross` legs) are not enforced.
- Linux job trees are a fresh extraction committed into a one-commit repository, not a clone. Code that calls `git rev-parse --show-toplevel` still finds a repository.
- Build output goes to `CARGO_TARGET_DIR` instead of `cli/target`, so cached builds survive between runs.
- The Linux image pins `rust:1.99-bookworm`, while `ci.yml` installs the current `stable`. Update the pin when stable moves.
- Native hosts use their installed toolchains; nothing runs `rustup target add`. The macOS host needs the `x86_64-apple-darwin` target, and Rosetta to run its tests.
- Per-step `timeout-minutes` values from `ci.yml` are not enforced; the per-job `--job-timeout-min` limit applies instead.
- Step shells follow GitHub's defaults (pwsh on Windows and `bash -e` elsewhere when a step names no shell, `bash -eo pipefail` for `shell: bash`), but run with `--noprofile --norc`, and bash on Windows is Git Bash.
- `git archive` is forced to LF line endings (`core.autocrlf=false`), whatever the host's git setting.
- Jobs that launch browsers (`windows-integration`, the e2e extras) run with `AGENT_BROWSER_CONFIG` pointing at an empty config, so a user config cannot make them attach to an existing browser. Unit-test jobs do not, to match hosted CI.
- The Linux image preinstalls ffmpeg, Chrome's runtime libraries, and `sudo` (which `install --with-deps` calls). The `native-e2e` steps still run `install --with-deps`.
- `jobs.test.mjs` pins a SHA-256 of `ci.yml`. Any edit to `ci.yml` fails that test until `jobs.mjs` is reviewed and `CI_YML_SHA256` updated.

## Receipt

`receipt.json` records the ref, SHA, host, toolchain versions, Chrome for Testing version, and for each job its status (`pass`, `fail`, `skipped`), duration, first failing step, and log file. The npm tarball packed by each `global-install` job (which contains that platform's release binary) is copied to `artifacts/` for the dogfood harness.
