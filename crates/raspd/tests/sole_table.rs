//! raspd sole mode against its disposition table (T-13039): every runnable
//! T-13008 case of every refuse and impossible row, sent to this build of
//! raspd started without --upstream on a fresh scratch stage; and every case
//! of the rows answered natively, judged against the recorded Bun reply
//! (T-13048, scripts/raspd-sole/native.ts). The cases build
//! their requests with the TypeScript compare-runner fixture, so the check is
//! scripts/raspd-sole/table-e2e.ts; this runs it against the raspd binary
//! cargo built for this test.
use std::path::Path;
use std::process::Command;

#[test]
fn sole_mode_answers_every_refuse_and_impossible_row_from_the_table() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let status = Command::new("bun")
        .arg("scripts/raspd-sole/table-e2e.ts")
        .arg("--raspd")
        .arg(env!("CARGO_BIN_EXE_raspd"))
        .current_dir(&repo)
        .status()
        .expect("run bun scripts/raspd-sole/table-e2e.ts");
    assert!(
        status.success(),
        "scripts/raspd-sole/table-e2e.ts failed: {status}"
    );
}
