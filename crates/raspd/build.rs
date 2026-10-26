//! Compile in what raspd reports about itself: its source commit (the release
//! builder passes RASPD_SOURCE_COMMIT; a checkout build asks git) and the
//! aspc-facade version Bun's hello reports, from the same tree.
use std::process::Command;

fn main() {
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

    let dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let manifest = format!("{dir}/../../harness/aspc/package.json");
    println!("cargo:rerun-if-changed={manifest}");
    let text = std::fs::read_to_string(&manifest).expect("harness/aspc/package.json");
    let version = text
        .lines()
        .find_map(|l| {
            let l = l.trim();
            l.strip_prefix("\"version\":")
                .map(|v| v.trim().trim_end_matches(',').trim_matches('"').to_owned())
        })
        .expect("harness/aspc/package.json version");
    println!("cargo:rustc-env=RASPD_ASPC_FACADE_VERSION={version}");
}
