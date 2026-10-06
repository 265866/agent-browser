# Local CI

Runs every job in `.github/workflows/ci.yml` against a git ref on the machines you have, and writes a receipt. It replaces hosted CI for forks that keep GitHub Actions disabled, and it covers the push-only jobs (`rust-cross`, `native-e2e`, `windows-integration`, `global-install`) that pull requests never run.

## Usage

```bash
pnpm ci:local --platform linux   --ref origin/main
pnpm ci:local --platform linux   --ref <unreviewed-ref> --untrusted
pnpm ci:local --platform windows --ref origin/main      # on a Windows host
pnpm ci:local --platform macos   --ref origin/main      # on a Mac
pnpm ci:local --platform macos   --ref origin/main --remote macbook
pnpm ci:local --platform all     --ref origin/main --remote macbook
```

`pnpm ci:local` runs `node test/local-ci/run.mjs`. pnpm first installs the workspace dependencies when they are missing; in a fresh checkout, `node test/local-ci/run.mjs` with the same arguments starts at once.

Options:

<table>
<tr><th>Option</th><th>Meaning</th></tr>
<tr><td><code>--ref</code></td><td>Any commit-ish. The run resolves it to a SHA first and records both.</td></tr>
<tr><td><code>--jobs a,b</code></td><td>Run only these job ids (see <code>jobs.mjs</code>). An unknown id is an error. With <code>--platform all</code>, a platform left without selected jobs is skipped.</td></tr>
<tr><td><code>--no-extra</code></td><td>Skip the checks that <code>ci.yml</code> does not run.</td></tr>
<tr><td><code>--out DIR</code></td><td>Receipt and log directory. Defaults to a new directory under the OS temp dir.</td></tr>
<tr><td><code>--slot N</code></td><td>Build-cache slot. A run holds its slot exclusively; a second run on the same slot waits until it is free.</td></tr>
<tr><td><code>--remote HOST</code></td><td>Run the macOS leg on <code>HOST</code> over SSH. The commit must be fetchable from <code>origin</code> there.</td></tr>
<tr><td><code>--work-root DIR</code></td><td>Where worktrees and build caches go (env <code>LOCAL_CI_WORK_ROOT</code>). Keep it short on Windows.</td></tr>
<tr><td><code>--cache DIR</code></td><td>Package-manager caches and Chrome for Testing (env <code>LOCAL_CI_CACHE</code>).</td></tr>
<tr><td><code>--untrusted</code></td><td>The ref's code has not been reviewed. Only the Linux leg is allowed. It runs without access to the host's network services (see Trust), with cache volumes separate from trusted runs (<code>abci-u-*</code>), and keeps no npm package.</td></tr>
<tr><td><code>--job-timeout-min N</code></td><td>Per-job time limit (default 120), counted from when the job holds the locks it needs. A timed-out job fails.</td></tr>
<tr><td><code>--remote-root DIR</code></td><td>Where the remote macOS leg keeps its files on the Mac (default <code>~/abw-zero</code>; see Remote Mac).</td></tr>
</table>

The exit code is 0 only when every selected job passes. A selection of extra checks only (for example `--jobs extra-clippy-windows`) reports `ciResult: null`, because no `ci.yml` job ran. An invalid selection exits with 2 before anything starts.

## Trust

The Windows and macOS legs run the ref's code directly on the host, with the host's network and files. Run them only for code that someone has reviewed. Unreviewed refs (for example a fresh pull request) go through `--untrusted`, which runs only in Docker, mounts no credentials, keeps its own caches so it cannot poison caches that later trusted runs read, and cannot reach services on the host.

### Network of untrusted runs

On Docker Desktop, a container on the default network reaches the host's loopback services through `host.docker.internal`: a listener bound only to the host's `127.0.0.1` answers it (measured on Windows with Docker Desktop 29). Code under test could reach, for example, a browser's remote-debugging port or a local model gateway that way. Untrusted runs therefore sit behind a fence (`egress.mjs`):

- The job container joins a per-run internal Docker network, which has no route out and resolves no outside names. The network's bridge has no address, so the Docker VM is not reachable from it either.
- The only way out is an HTTP proxy in a second container, attached to that network and to the default bridge. The proxy resolves each destination itself, refuses loopback, private, link-local, shared (100.64.0.0/10), multicast, and reserved IPv4 ranges, every IPv6 address, and every address of the Docker host, and connects only to the address it checked. It runs as `nobody`, with no capabilities and a read-only file system, and with packet forwarding turned off (`net.ipv4.ip_forward=0`, `net.ipv6.conf.all.forwarding=0`), so it relays only the connections it vetted.
- Code in the job container runs as root but has no `CAP_NET_ADMIN` (it cannot add a route around the proxy), no `CAP_NET_RAW` (it cannot hand-craft packets for the proxy to forward), and no `CAP_MKNOD`. `isolation.test.mjs` measures the job container's capabilities and the proxy's forwarding settings.
- Jobs see `HTTP_PROXY` and `HTTPS_PROXY` (in both cases), `NO_PROXY=localhost,127.0.0.1,::1`, and `NODE_USE_ENV_PROXY=1`. `sudo` drops those variables, so `exec.mjs` also writes an apt proxy setting.

Every `ci.yml` step that needs the network goes through the proxy: cargo downloading crates, pnpm and corepack installing packages, `next build` fetching Google Fonts (`dashboard`), `install --with-deps` running `apt-get update` and downloading Chrome for Testing, and the e2e tests loading public sites such as `example.com` (`native-e2e`). Those steps reach public internet addresses (IPv4 only), never the host, the local network, or other containers. A tool that ignores the proxy variables fails instead of going around the fence. The proxy's log, including each refused destination, is saved as `egress.log` next to the receipt.

### Output of untrusted runs

An untrusted run protects the host, not the result: the code under test runs as root in the same container as the runner and could rewrite its own receipt. Treat an untrusted receipt as a quick signal, and gate on a trusted run after review.

The code under test can also leave anything in the directory the container writes to: a package, a receipt that claims the run was trusted, a directory or a link where the host expects a file. The host therefore keeps the container's output apart from its own files and never reads or writes it directly (`fence.mjs`):

- The container writes only into `container/` inside the output directory. The receipt, `egress.log`, and the source archive sit next to it, where the container cannot reach them. The source archive is mounted read-only.
- Before the container starts, the host writes a receipt marked `untrusted: true`, so even an interrupted run's output is never taken for a trusted one.
- After the container exits, a second throwaway container keeps only the regular `*.log` files in `container/`, cuts any of them beyond 50 MiB (with a note at the end of the file and in `truncatedLogs` in the host receipt), hands back the text of the receipt the job container left, and deletes everything else (packages, links, directories). Because it runs in a container, a planted link can only lead inside that container.
- The host then writes `receipt.json` itself from that text: only the fields it expects, with `untrusted: true`, `reportedByContainer`, job log paths under `container/`, and an empty `artifacts` list. Job results in it are what the code under test reported.
- Every cleanup step (proxy and network removal, the fence, releasing the build slot, removing the source archive) runs even when an earlier one fails, and any failure makes the leg an error. An interrupt also runs the fence.

Untrusted jobs save no npm package in the first place. The dogfood harness accepts a package only from a trusted receipt that lists its SHA-256, and refuses any package below an untrusted receipt (see `test/dogfood/README.md`).

### Interruption

Interrupting a run (Ctrl-C, SIGTERM, or a dropped SSH connection to the Mac) stops the active step's processes and removes the job's worktree and scratch directories. A job ended this way is recorded as `interrupted`, never `pass`. The remote leg runs under a pseudo-terminal, and a wrapper script forwards the hangup to the remote runner. A run killed outright (for example by TerminateProcess on Windows) leaves its directories behind; the next run on the same work root removes them. Its Linux container, egress proxy, and network keep running too. They carry an owner label (`agent-browser-harness.owner`, with the host, platform, and process id), and the next run on the host with a Linux leg removes those whose owner process is gone.

## Where each job runs

<table>
<tr><th>Platform</th><th>How</th><th>Jobs</th></tr>
<tr><td>Linux</td><td><code>linux/amd64</code> Docker container built from <code>linux.Dockerfile</code>. It receives only a <code>git archive</code> of the commit: no <code>.git</code> directory and no credentials. Cargo registry, build output, and package caches live in named volumes (<code>abci-*</code>).</td><td>version-sync, launcher, rust, dashboard, sandbox-package, eve-package, native-e2e, global-install (ubuntu)</td></tr>
<tr><td>Windows</td><td>Native, one throwaway <code>git worktree</code> per job.</td><td>rust-cross (x86_64-pc-windows-msvc), windows-integration, global-install (windows)</td></tr>
<tr><td>macOS</td><td>Native, one throwaway <code>git worktree</code> per job.</td><td>rust-cross (aarch64 and x86_64), global-install (macos)</td></tr>
</table>

Extra checks, reported separately as `extraResult`: clippy and the native e2e suite on Windows and macOS. `ci.yml` only runs these on Linux, but platform-specific code paths compile and behave differently.

## Isolation

- Jobs start from the host environment with every `AGENT_BROWSER_*` variable, the XDG base directory variables (`XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_DIRS`, `XDG_DATA_DIRS`), and anything credential-shaped (tokens, keys, passwords, cloud and model provider variables) removed. See `isolation.mjs`. With the XDG variables, agent-browser would keep its state in the host user's directories whatever `HOME` says.
- npm global installs go to a throwaway prefix (`npm_config_prefix`), never the host's global tree.
- Temporary files, including Chrome's temporary profiles, go to the job's scratch directory (`TMPDIR`, `TMP`, `TEMP`).
- On Linux and macOS each job gets a throwaway `HOME`, so `agent-browser install` and session state stay inside the job.
- A ref whose CLI reads `AGENT_BROWSER_HOME` gets `AGENT_BROWSER_HOME=<job scratch>/agent-browser-home` in every job on every platform, so config, sessions, auth profiles, the encryption key, installed browsers, default output, and (on Windows) the daemon port's identity belong to that job. The runner decides per ref, in two steps. First, `cli/src/paths.rs` at the commit under test must contain the string literal `"AGENT_BROWSER_HOME"` outside comments. The runner reads the file from the commit itself (`git show <sha>:cli/src/paths.rs`, or from the source archive on the Linux leg), never from a working tree, so a comment, a longer name such as `AGENT_BROWSER_HOME_DIR`, or documentation elsewhere does not count. Code can still name the variable without honoring it (dead code, a test module), so on Windows, before any job that writes the profile directory runs, the runner confirms with the ref's own CLI. It builds `agent-browser` the way `rust-cross-windows`'s integration tests do (`cargo build --profile ci --target x86_64-pc-windows-msvc --bin agent-browser`, `STATE_HOME_PROBE` in `jobs.mjs`), into the slot's target directory, where the dependencies are shared. Cargo fingerprints the `agent-browser` crate by its path and each job has its own worktree, so the crate builds once more for the probe: 1m50s and 3m46s on warm slots, measured. Then it opens and closes a named session on `about:blank` with `AGENT_BROWSER_HOME` set to a scratch directory and a random namespace whose daemon ports nothing listens on. The session's saved state must appear in the scratch directory and nothing in `%USERPROFILE%\.agent-browser`. The probe runs under the profile lease the run would take anyway, so the real directory exists and carries the harness marker while the ref's CLI runs: a CLI that ignores the variable writes only into a directory the harness owns, and the lease's release handles it as for any older ref. The probe removes its own namespace there and nothing else. The run keeps that lease unless the probe confirms the ref, and the probe does not run in a directory that belongs to you. Only a confirmed ref runs without the lease: when no selected job writes the profile directory (for example `--jobs global-install-windows`), nothing is probed and the run holds the lease for its whole length, as for any ref. A ref that does not match, or that the probe cannot confirm (a failed build, no Chrome, state in the wrong place), keeps the behavior described next. The receipt records the decision as `stateHome` and the probe as `stateHomeProbe`; `state-home-probe.log` holds the build and probe output.
- On Windows, `LOCALAPPDATA` and `APPDATA` point at empty scratch directories, so Chrome profile discovery cannot find the user's browser profiles.
- For refs without `AGENT_BROWSER_HOME`, Windows resolves the profile directory through the Known Folder API, so no variable can move `%USERPROFILE%\.agent-browser`. Code under test writes there: the Rust unit and e2e tests and `windows-integration`'s real `install`. If the directory does not exist, the harness creates it with an ownership marker and each run holds a lease file inside it. The last run to finish moves it to `agent-browser-harness-quarantine` in the temp directory (or `.agent-browser-harness-quarantine` next to it when the temp directory is on another drive); the first run that finishes three or more days later deletes it from there. If a file in it is open, the directory stays in place with a warning and a later run moves it. If you ran agent-browser on Windows while a harness run was active, your state went into that directory too: look in the quarantine to recover it. Jobs that write there take turns across concurrent runs. A job waits up to six hours for its turn; the wait does not count against its time limit and is recorded in the receipt as `lockWaitSec`. If the directory exists without the marker, it belongs to you: those jobs fail with a `refused` message instead of writing into it, and dogfood does not run on Windows with a candidate that needs it.
- Windows jobs of a ref with `AGENT_BROWSER_HOME` take neither the lease nor the real-home lock once the probe has confirmed the ref. The probe never runs in a directory that belongs to you, so there such a ref keeps the behavior described above, and its jobs that write the directory fail with `refused`. The probe is the guarantee that these jobs leave `%USERPROFILE%\.agent-browser` alone. As a safety net, each job lists the directory (every entry with its size and modification time, leaving out lease files and the harness marker) before its source is checked out and again after its cleanup, and compares the two. A change under the job's own namespace can only be the job's: it fails the job with a `profile-leak` message that lists the paths. Any other change may come from other runs (older refs and older dogfood candidates still write the directory), the profile keeper, or you, so the harness cannot judge it: the receipt lists it under `profileCheck.unattributedChanges` with its path, kind, and modification time, the log lists all of them, and the run prints a warning line for a person to read. Such changes never fail or pass the job by themselves. A directory that is missing at the start, deleted, or moved away (the last lease's release parks it) between the two listings is reported in `profileCheck.notes`.
- Cross-run locks (build slots, the profile directory, the Linux target volume, the profile lease) are exclusive listeners on `127.0.0.1`, on a port between 20000 and 31999 derived from the lock's name. The operating system frees a lock when its holder exits, even after a hard kill. If another program answers on a lock's port, the run fails at once with a message naming the port; a program that accepts connections without answering, or a socket bound to the port without listening, makes the run wait until its timeout and then fail with that description. Set `AGENT_BROWSER_HARNESS_LOCK_PORT_BASE` to move the range. Every run on a host must use the same value, and it is not forwarded over SSH, so set it on the Mac separately.
- Browser tests on Windows and macOS use a Chrome for Testing build pinned through `AGENT_BROWSER_EXECUTABLE_PATH`, never a system Chrome.
- Jobs that launch browsers download into their scratch directory (`AGENT_BROWSER_DOWNLOAD_PATH`). Chrome's default is the user's real Downloads folder, which no environment variable moves on Windows.
- Each job's worktree is removed with `git worktree remove --force` for that path only. The harness never runs `git worktree prune`, which would also drop the registration of one of your worktrees whose directory is missing for a moment (for example on an unmounted drive).
- After each job, and when a step times out, the runner stops processes whose image path or command line contains that job's unique directories. On Linux and macOS each step leads its own process group, so a timeout also stops grandchildren.

## Known differences from hosted CI

- GitHub's `pull_request` runs test the merge of the pull request into its base branch. Local CI tests the ref you name, which for a pull request is its head. Merge or rebase onto the base locally and pass that commit to test the merge result.
- Linux jobs run as root inside the container. Hosted runners run steps as the non-root `runner` user with passwordless `sudo`. Code that depends on the user (file permissions, `sudo`, Chrome's sandbox, which refuses to run as root without `--no-sandbox`) can behave differently.
- Untrusted Linux runs reach the internet only through the egress proxy (see Trust). Hosted runners connect directly.
- Line endings follow the host's git configuration. GitHub's Windows runners check out with `core.autocrlf=true`.
- `needs:` is honored within a platform. Cross-platform dependencies (for example `windows-integration` waiting on the macOS `rust-cross` legs) are not enforced.
- Linux job trees are a fresh extraction committed into a one-commit repository, not a clone. Code that calls `git rev-parse --show-toplevel` still finds a repository.
- Build output goes to `CARGO_TARGET_DIR` instead of `cli/target`, so cached builds survive between runs.
- Jobs of a ref whose CLI reads `AGENT_BROWSER_HOME` run with that variable set to a per-job directory (see Isolation), and `ci.yml` never sets it. The cargo tests and the real CLI therefore resolve their state directory, and on Windows their daemon ports, from that directory, not from the runner's `~/.agent-browser`. A test that assumes the default location without clearing the variable can pass on hosted CI and fail here, or the reverse.
- The Linux image pins `rust:1.99-bookworm`, while `ci.yml` installs the current `stable`. Update the pin when stable moves.
- Native hosts use their installed toolchains; nothing runs `rustup target add`. The macOS host needs the `x86_64-apple-darwin` target, and Rosetta to run its tests.
- Per-step `timeout-minutes` values from `ci.yml` are not enforced; the per-job `--job-timeout-min` limit applies instead.
- Step shells follow GitHub's defaults (pwsh on Windows and `bash -e` elsewhere when a step names no shell, `bash -eo pipefail` for `shell: bash`), but run with `--noprofile --norc`, and bash on Windows is Git Bash.
- `git archive` is forced to LF line endings (`core.autocrlf=false`), whatever the host's git setting.
- Jobs that launch browsers (`windows-integration`, the e2e extras) run with `AGENT_BROWSER_CONFIG` pointing at an empty config, so a user config cannot make them attach to an existing browser, and with `AGENT_BROWSER_DOWNLOAD_PATH` pointing at scratch. Unit-test jobs do not, to match hosted CI.
- The Linux image preinstalls ffmpeg, Chrome's runtime libraries, and `sudo` (which `install --with-deps` calls). The `native-e2e` steps still run `install --with-deps`.
- `jobs.test.mjs` pins a SHA-256 of `ci.yml`. Any edit to `ci.yml` fails that test until `jobs.mjs` is reviewed and `CI_YML_SHA256` updated.

## Receipt

`receipt.json` records the ref, SHA, host, toolchain versions, Chrome for Testing version, the harness revision (`harness.sha`, `harness.dirty`), whether the run was `untrusted` (set by the host, never by the code under test), a random `runToken`, the saved packages with their SHA-256 (`artifacts`), whether the ref's jobs got their own `AGENT_BROWSER_HOME` (`stateHome`) and how the Windows leg confirmed it (`stateHomeProbe`), and for each job its status (`pass`, `fail`, `skipped`, `interrupted`), duration, time spent waiting for the real-home lock (`lockWaitSec`, `null` when the job did not take it), the profile comparison (`profileCheck`, Windows jobs with their own home: `leaks`, `unattributedChanges`, and `notes`), first failing step, and log file. With `--platform all`, each platform's receipt is in its own subdirectory and the top-level receipt summarizes them; a platform skipped for lack of selected jobs is listed with `skipped`.

Before each platform starts, the runner deletes that platform's old `receipt.json`, and afterwards it accepts only a finished receipt with this run's SHA and `runToken`. Reusing an `--out` directory therefore cannot turn an earlier pass into this run's result: a runner that dies before writing its receipt leaves the platform with `ciResult: "error"`.

The exit code of each platform's runner must agree with its receipt: a receipt that reports `pass` from a runner that exited 1 (or `fail` from one that exited 0) makes the leg an `error`.

The npm tarball packed by each `global-install` job (which contains that platform's release binary) is copied to `artifacts/` for the dogfood harness. After a trusted leg finishes, the host records each tarball's name and SHA-256 in that leg's receipt (`artifacts`). Untrusted runs keep no tarball, and their receipt lists none.

## Remote Mac

`--remote HOST` copies the harness to `HOST` over SSH and runs the macOS leg there. The remote command runs in a login shell that is not interactive (`zsh -lc`), so the toolchain (`cargo`, `rustup`, `node`, `npm`, `git`) must be on the PATH that `~/.zprofile` sets, not only in `~/.zshrc`. ssh runs with `BatchMode=yes`, and git on the Mac runs with credential prompts turned off, so a missing key or credential fails the leg instead of waiting for input.

These stay on the Mac between runs, under `--remote-root` (default `~/abw-zero`):

<table>
<tr><th>Path</th><th>Contents</th></tr>
<tr><td><code>repo</code></td><td>A clone of <code>origin</code>, fetched before each run.</td></tr>
<tr><td><code>w</code></td><td>Build caches, one <code>target-macos-&lt;slot&gt;</code> per slot, and each running job's worktree and scratch directory.</td></tr>
<tr><td><code>cache</code></td><td>Chrome for Testing and package manager caches.</td></tr>
<tr><td><code>abdf-cache</code></td><td>The dogfood harness's Chrome for Testing.</td></tr>
</table>

Each run removes its own harness copy and output directory (`harness-*`, `out-*`, and dogfood's `df-*`). To remove everything, run `rm -rf ~/abw-zero` on the Mac while no run is active; the next run clones and builds from scratch.
