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
<tr><td><code>--slot N</code></td><td>Build-cache slot. Concurrent runs on one host need different slots.</td></tr>
<tr><td><code>--remote HOST</code></td><td>Run the macOS leg on <code>HOST</code> over SSH. The commit must be fetchable from <code>origin</code> there.</td></tr>
<tr><td><code>--work-root DIR</code></td><td>Where worktrees and build caches go (env <code>LOCAL_CI_WORK_ROOT</code>). Keep it short on Windows.</td></tr>
<tr><td><code>--cache DIR</code></td><td>Package-manager caches and Chrome for Testing (env <code>LOCAL_CI_CACHE</code>).</td></tr>
</table>

The exit code is 0 only when every selected job passes.

## Where each job runs

<table>
<tr><th>Platform</th><th>How</th><th>Jobs</th></tr>
<tr><td>Linux</td><td><code>linux/amd64</code> Docker container built from <code>linux.Dockerfile</code>. It receives only a <code>git archive</code> of the commit: no <code>.git</code> directory and no credentials. Cargo registry, build output, and package caches live in named volumes (<code>abci-*</code>).</td><td>version-sync, launcher, rust, dashboard, sandbox-package, eve-package, native-e2e, global-install (ubuntu)</td></tr>
<tr><td>Windows</td><td>Native, one throwaway <code>git worktree</code> per job.</td><td>rust-cross (x86_64-pc-windows-msvc), windows-integration, global-install (windows)</td></tr>
<tr><td>macOS</td><td>Native, one throwaway <code>git worktree</code> per job.</td><td>rust-cross (aarch64 and x86_64), global-install (macos)</td></tr>
</table>

Extra checks, reported separately as `extraResult`: clippy and the native e2e suite on Windows and macOS. `ci.yml` only runs these on Linux, but platform-specific code paths compile and behave differently.

## Isolation

- npm global installs go to a throwaway prefix (`npm_config_prefix`), never the host's global tree.
- On Linux and macOS each job gets a throwaway `HOME`, so `agent-browser install` and session state stay inside the job.
- Windows resolves the profile directory through the Known Folder API, so `HOME` cannot redirect it. `windows-integration` runs the real `install` and removes `%USERPROFILE%\.agent-browser` afterwards only if the job created it. A lock serializes that job across concurrent runs.
- Browser tests on Windows and macOS use a Chrome for Testing build pinned through `AGENT_BROWSER_EXECUTABLE_PATH`, never a system Chrome.
- After each job, the runner stops processes whose image path or command line contains that job's unique directories.

## Known differences from hosted CI

- Line endings follow the host's git configuration. GitHub's Windows runners check out with `core.autocrlf=true`.
- `needs:` is honored within a platform. Cross-platform dependencies (for example `windows-integration` waiting on the macOS `rust-cross` legs) are not enforced.
- Linux job trees are a fresh extraction committed into a one-commit repository, not a clone. Code that calls `git rev-parse --show-toplevel` still finds a repository.
- Build output goes to `CARGO_TARGET_DIR` instead of `cli/target`, so cached builds survive between runs.

## Receipt

`receipt.json` records the ref, SHA, host, toolchain versions, Chrome for Testing version, and for each job its status (`pass`, `fail`, `skipped`), duration, first failing step, and log file. Release binaries built by the `global-install` jobs are copied to `artifacts/` for the dogfood harness.
