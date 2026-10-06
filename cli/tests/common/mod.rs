//! Shared by the integration tests. Each test binary that declares `mod common;`
//! gets its own temporary `AGENT_BROWSER_HOME`, which the CLI processes it
//! spawns inherit (see `src/test_home.rs`).

#[path = "../../src/test_home.rs"]
mod test_home;
