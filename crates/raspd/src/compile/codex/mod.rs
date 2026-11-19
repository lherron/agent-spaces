//! The codex-app-server recipe's materialization, with Bun's write rules.
//! Each submodule ports one Bun source of the Codex adapter
//! (drivers/harness-codex/src/adapters/codex-adapter.ts and its helpers):
//! `discovery` (codex-discovery.ts, `detect`), `space` (`materializeSpace`),
//! `hooks` (codex-hooks.ts), `config` (codex-config.ts), `agents`
//! (codex-agents.ts), `bundle` (`composeTarget`/`loadTargetBundle`) and
//! `runtime_home` (drivers/execution/src/run-codex.ts
//! `prepareCodexRuntimeHome`: the stable home under `.asp-runtime.lock`,
//! gated by its `.asp-runtime.json` fingerprint). The bundle publish, lock and
//! prune protocol is bundle_publish.rs's.
mod agents;
pub mod bundle;
pub mod config;
pub mod discovery;
mod hooks;
pub mod runtime_home;
pub mod space;

/// `DEFAULT_CODEX_ENABLED_FEATURES` (core/config/src/core/codex-launch.ts).
pub const DEFAULT_FEATURES: [&str; 1] = ["goals"];
/// The CodexAdapter's `models` ids: a runtime plan's model must be one.
pub const ADAPTER_MODELS: [&str; 15] = [
    "gpt-5.6-terra",
    "gpt-6.2-sol",
    "gpt-6.2-astra",
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.3-codex",
    "gpt-5.3",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
];
