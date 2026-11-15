//! Compile in what raspd reports about itself: its source commit (the release
//! builder passes RASPD_SOURCE_COMMIT; a checkout build asks git) and the
//! aspc-facade version Bun's hello reports, from the same tree. And the
//! forward reasons the disposition table names (`reason!` checks a reason
//! against them at compile time).
use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-env-changed=RASPD_SOURCE_COMMIT");
    let commit = std::env::var("RASPD_SOURCE_COMMIT")
        .ok()
        .filter(|c| !c.trim().is_empty())
        .or_else(|| {
            let out = Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()?;
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        })
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=RASPD_SOURCE_COMMIT={commit}");

    let dir = std::env::var("CARGO_MANIFEST_DIR")?;
    let manifest = format!("{dir}/../../harness/aspc/package.json");
    println!("cargo:rerun-if-changed={manifest}");
    let text = std::fs::read_to_string(&manifest)?;
    let version = text
        .lines()
        .find_map(|l| {
            let l = l.trim();
            l.strip_prefix("\"version\":")
                .map(|v| v.trim().trim_end_matches(',').trim_matches('"').to_owned())
        })
        .ok_or("harness/aspc/package.json version is missing")?;
    println!("cargo:rustc-env=RASPD_ASPC_FACADE_VERSION={version}");

    let table = format!("{dir}/dispositions.json");
    println!("cargo:rerun-if-changed={table}");
    let text = std::fs::read_to_string(&table)?;
    let parsed: serde_json::Value = serde_json::from_str(&text)?;
    let mut reasons: Vec<String> = parsed["rows"]
        .as_array()
        .ok_or("dispositions.json rows must be an array")?
        .iter()
        .map(|r| {
            r["reason"]
                .as_str()
                .map(str::to_owned)
                .ok_or("row reason must be a string")
        })
        .collect::<Result<_, _>>()?;
    reasons.sort();
    let list: Vec<String> = reasons.iter().map(|r| format!("{r:?}")).collect();
    let out = std::env::var("OUT_DIR")?;
    std::fs::write(
        format!("{out}/reasons.rs"),
        format!(
            "/// Every forward reason with a row in dispositions.json.\npub const REASONS: &[&str] = &[{}];\n",
            list.join(", ")
        ),
    )?;
    Ok(())
}
