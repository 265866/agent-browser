// Job table for the local CI runner. Each entry mirrors one job (or one
// matrix leg) of .github/workflows/ci.yml. `kind: 'extra'` marks checks that
// ci.yml does not run; receipts report them separately from the ci.yml verdict.
//
// Steps run with the job's source directory as cwd. `shell` follows the
// workflow: omit it where ci.yml does (pwsh on Windows, `bash -e` elsewhere),
// or set 'bash' (`bash -eo pipefail`) or 'pwsh' where ci.yml names one.

const cargo = (args) => `cargo ${args} --manifest-path cli/Cargo.toml`;

const buildRelease = (target) => ({
  name: 'Build Rust CLI',
  run: `cargo build --release --manifest-path cli/Cargo.toml --target ${target}`,
});

// Not in ci.yml: keeps the packed npm tarball (which contains the native
// binary) so the dogfood harness can run exactly what local CI tested.
const savePackage = {
  name: 'Save npm package artifact (local-ci only)',
  shell: 'bash',
  run: 'mkdir -p "$LOCAL_CI_ARTIFACTS" && cp agent-browser-*.tgz "$LOCAL_CI_ARTIFACTS/"',
};

const npmGlobalInstall = {
  name: 'Test npm global install',
  shell: 'bash',
  // The prefix is a throwaway directory created by the executor
  // (npm_config_prefix), so this never touches the host's global npm tree.
  run: 'npm pack\nnpm install -g agent-browser-*.tgz\nagent-browser --version',
};

const unixSymlinkCheck = (binary) => ({
  name: 'Verify symlink points to native binary (Unix)',
  shell: 'bash',
  run: [
    'SYMLINK=$(npm prefix -g)/bin/agent-browser',
    'TARGET=$(readlink "$SYMLINK")',
    'echo "Symlink: $SYMLINK"',
    'echo "Target: $TARGET"',
    `if [[ "$TARGET" != *"${binary}"* ]]; then echo "ERROR: Symlink should point to native binary, not JS wrapper"; exit 1; fi`,
    'echo "Symlink correctly points to native binary"',
  ].join('\n'),
});

export const JOBS = [
  // ---- ubuntu-latest jobs (Docker, linux/amd64) ----
  {
    // GitHub refuses a workflow file it cannot parse or whose expressions use
    // a context where it is not available, and fails every job in it. The
    // fork never runs Actions, so this is the only check on them. The script
    // and the tools come from the harness, never from the ref. First on the
    // Linux leg: in an untrusted run, later jobs run the ref's code as root in
    // the same container and could replace the tools.
    id: 'extra-actionlint',
    kind: 'extra',
    platform: 'linux',
    steps: [
      { name: 'actionlint .github/workflows', run: 'node "$LOCAL_CI_HARNESS/actionlint.mjs"' },
    ],
  },
  {
    id: 'version-sync',
    ciJob: 'version-sync',
    platform: 'linux',
    steps: [{ name: 'Check version sync', run: 'node scripts/check-version-sync.js' }],
  },
  {
    id: 'launcher',
    ciJob: 'launcher',
    platform: 'linux',
    steps: [{ name: 'Run launcher tests', run: 'pnpm run test:launcher' }],
  },
  {
    id: 'rust',
    ciJob: 'rust',
    platform: 'linux',
    steps: [
      { name: 'Format check', run: 'cargo fmt --manifest-path cli/Cargo.toml -- --check' },
      { name: 'Clippy check', run: `${cargo('clippy')} -- -D warnings` },
      { name: 'Run Rust tests', run: cargo('test --profile ci') },
    ],
  },
  {
    id: 'dashboard',
    ciJob: 'dashboard',
    platform: 'linux',
    steps: [
      {
        name: 'Install dependencies',
        cwd: 'packages/dashboard',
        run: 'pnpm install --filter dashboard',
      },
      { name: 'Build dashboard', cwd: 'packages/dashboard', run: 'pnpm build' },
    ],
  },
  {
    id: 'sandbox-package',
    ciJob: 'sandbox-package',
    platform: 'linux',
    steps: [
      { name: 'Install dependencies', run: 'pnpm install --frozen-lockfile' },
      { name: 'Test sandbox package', run: 'pnpm --filter @agent-browser/sandbox test' },
    ],
  },
  {
    id: 'eve-package',
    ciJob: 'eve-package',
    platform: 'linux',
    steps: [
      { name: 'Install dependencies', run: 'pnpm install --frozen-lockfile' },
      { name: 'Typecheck Eve package', run: 'pnpm --filter @agent-browser/eve typecheck' },
      { name: 'Test Eve package', run: 'pnpm --filter @agent-browser/eve test' },
    ],
  },
  {
    // ci.yml shares one AGENT_BROWSER_HOME across this job's steps; the runner already gives
    // every job its own (see Isolation in README.md).
    id: 'native-e2e',
    ciJob: 'native-e2e',
    platform: 'linux',
    pushOnly: true,
    needs: ['rust'],
    steps: [
      {
        name: 'Install Chrome',
        run: 'cargo run --manifest-path cli/Cargo.toml -- install --with-deps',
      },
      { name: 'Install ffmpeg', run: 'command -v ffmpeg' },
      {
        name: 'Run e2e tests',
        run: `${cargo('test --profile ci')} e2e -- --ignored --test-threads=1`,
      },
    ],
  },
  {
    id: 'global-install-linux',
    ciJob: 'global-install (ubuntu-latest)',
    platform: 'linux',
    pushOnly: true,
    steps: [
      buildRelease('x86_64-unknown-linux-gnu'),
      {
        name: 'Copy CLI binary to bin directory (Unix)',
        run: 'cp "$CARGO_TARGET_DIR/x86_64-unknown-linux-gnu/release/agent-browser" bin/agent-browser-linux-x64',
      },
      npmGlobalInstall,
      savePackage,
      unixSymlinkCheck('agent-browser-linux-x64'),
    ],
  },

  {
    id: 'extra-harness-selftest',
    kind: 'extra',
    platform: 'linux',
    steps: [
      // Refs from before the harness existed have nothing to test.
      {
        name: 'Local CI and dogfood harness self-tests',
        shell: 'bash',
        run: 'if [ -d test/local-ci ]; then pnpm run test:harness; else echo "harness not present in this ref"; fi',
      },
    ],
  },

  // ---- windows-latest jobs (native) ----
  {
    id: 'rust-cross-windows',
    ciJob: 'rust-cross (windows-latest - x86_64-pc-windows-msvc)',
    platform: 'windows',
    pushOnly: true,
    writesProfile: true,
    steps: [
      {
        name: 'Run Rust tests',
        run: `${cargo('test --profile ci')} --target x86_64-pc-windows-msvc`,
      },
    ],
  },
  {
    id: 'windows-integration',
    ciJob: 'windows-integration',
    platform: 'windows',
    pushOnly: true,
    needs: ['rust-cross-windows'],
    usesRealHome: true,
    writesProfile: true,
    steps: [
      buildRelease('x86_64-pc-windows-msvc'),
      {
        name: 'Copy CLI binary to bin directory',
        shell: 'pwsh',
        run: 'Copy-Item "$env:CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/agent-browser.exe" bin/agent-browser-win32-x64.exe',
      },
      {
        name: 'Test agent-browser install command',
        shell: 'pwsh',
        run: [
          '$env:PATH = "$pwd\\bin;$env:PATH"',
          'for ($i = 1; $i -le 3; $i++) {',
          '  bin/agent-browser-win32-x64.exe install',
          '  if ($LASTEXITCODE -eq 0) { exit 0 }',
          '  Write-Host "Attempt $i failed, retrying in 10 seconds..."',
          '  Start-Sleep -Seconds 10',
          '}',
          'exit 1',
        ].join('\n'),
      },
      {
        name: 'Test daemon lifecycle (open, snapshot, close)',
        shell: 'pwsh',
        run: [
          '$env:PATH = "$pwd\\bin;$env:PATH"',
          'Write-Host "--- Opening page ---"',
          'bin/agent-browser-win32-x64.exe open https://example.com',
          'if ($LASTEXITCODE -ne 0) { Write-Error "open failed"; exit 1 }',
          'Write-Host "--- Taking snapshot ---"',
          '$snapshot = bin/agent-browser-win32-x64.exe snapshot',
          'if ($LASTEXITCODE -ne 0) { Write-Error "snapshot failed"; exit 1 }',
          'Write-Host $snapshot',
          'Write-Host "--- Closing browser ---"',
          'bin/agent-browser-win32-x64.exe close',
          'if ($LASTEXITCODE -ne 0) { Write-Error "close failed"; exit 1 }',
          'Write-Host "--- Windows daemon lifecycle test passed ---"',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'global-install-windows',
    ciJob: 'global-install (windows-latest)',
    platform: 'windows',
    pushOnly: true,
    needs: ['rust-cross-windows'],
    steps: [
      buildRelease('x86_64-pc-windows-msvc'),
      {
        name: 'Copy CLI binary to bin directory (Windows)',
        shell: 'pwsh',
        run: 'Copy-Item "$env:CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/agent-browser.exe" bin/agent-browser-win32-x64.exe',
      },
      npmGlobalInstall,
      savePackage,
      {
        name: 'Verify shim points to native binary (Windows)',
        shell: 'pwsh',
        run: [
          '$shimPath = "$(npm prefix -g)\\agent-browser.cmd"',
          '$content = Get-Content $shimPath -Raw',
          'echo "Shim path: $shimPath"',
          'echo "Shim content:"',
          'echo $content',
          'if ($content -notmatch "agent-browser-win32-x64\\.exe") { echo "ERROR: Shim should point to native .exe, not JS wrapper"; exit 1 }',
          'echo "Shim correctly points to native binary"',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'extra-clippy-windows',
    kind: 'extra',
    platform: 'windows',
    steps: [{ name: 'Clippy (Windows cfg)', run: `${cargo('clippy')} -- -D warnings` }],
  },
  {
    id: 'extra-e2e-windows',
    kind: 'extra',
    platform: 'windows',
    needsChrome: true,
    writesProfile: true,
    steps: [
      {
        name: 'Run e2e tests (Windows)',
        run: `${cargo('test --profile ci')} e2e -- --ignored --test-threads=1`,
      },
    ],
  },

  // ---- macos-latest jobs (native on the Mac) ----
  {
    id: 'rust-cross-macos-aarch64',
    ciJob: 'rust-cross (macos-latest - aarch64-apple-darwin)',
    platform: 'macos',
    pushOnly: true,
    steps: [
      {
        name: 'Run Rust tests',
        run: `${cargo('test --profile ci')} --target aarch64-apple-darwin`,
      },
    ],
  },
  {
    id: 'rust-cross-macos-x86_64',
    ciJob: 'rust-cross (macos-latest - x86_64-apple-darwin)',
    platform: 'macos',
    pushOnly: true,
    steps: [
      { name: 'Run Rust tests', run: `${cargo('test --profile ci')} --target x86_64-apple-darwin` },
    ],
  },
  {
    id: 'global-install-macos',
    ciJob: 'global-install (macos-latest)',
    platform: 'macos',
    pushOnly: true,
    needs: ['rust-cross-macos-aarch64', 'rust-cross-macos-x86_64'],
    steps: [
      buildRelease('aarch64-apple-darwin'),
      {
        name: 'Copy CLI binary to bin directory (Unix)',
        run: 'cp "$CARGO_TARGET_DIR/aarch64-apple-darwin/release/agent-browser" bin/agent-browser-darwin-arm64',
      },
      npmGlobalInstall,
      savePackage,
      unixSymlinkCheck('agent-browser-darwin-arm64'),
    ],
  },
  {
    id: 'extra-clippy-macos',
    kind: 'extra',
    platform: 'macos',
    steps: [{ name: 'Clippy (macOS cfg)', run: `${cargo('clippy')} -- -D warnings` }],
  },
  {
    id: 'extra-e2e-macos',
    kind: 'extra',
    platform: 'macos',
    needsChrome: true,
    steps: [
      {
        name: 'Run e2e tests (macOS)',
        run: `${cargo('test --profile ci')} e2e -- --ignored --test-threads=1`,
      },
    ],
  },
];

// How exec.mjs confirms that a ref which names AGENT_BROWSER_HOME honors it,
// before any job that writes the profile directory skips the lock: build the
// CLI with rust-cross-windows's profile and target, into the slot's target
// dir, where the dependencies are shared. Cargo fingerprints the agent-browser
// crate by its path and each job has its own worktree, so the crate itself
// builds once more (1m50s and 3m46s measured on warm slots). `binary` may name
// $CARGO_TARGET_DIR; a relative path is relative to the source tree.
// `runner`, when set, runs the binary (a stand-in table's script).
export const STATE_HOME_PROBE = {
  build: {
    name: 'Build the CLI to confirm AGENT_BROWSER_HOME',
    run: `${cargo('build --profile ci')} --target x86_64-pc-windows-msvc --bin agent-browser`,
  },
  binary: '$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/ci/agent-browser.exe',
};

// SHA-256 of .github/workflows/ci.yml (LF line endings) that this table was
// last reviewed against. jobs.test.mjs fails when ci.yml changes, so step and
// runner changes get mirrored here, not only new jobs.
export const CI_YML_SHA256 = '3d649be88b6ed77b0cdb289bd56ab0e21f0202895d9ef3f66fd0addf3cfd2112';

export function jobsFor(platform, { only, includeExtra = true } = {}) {
  return JOBS.filter((j) => j.platform === platform)
    .filter((j) => includeExtra || j.kind !== 'extra')
    .filter((j) => !only || only.includes(j.id));
}
