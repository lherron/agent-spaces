//! raspd's observation domain: aspd's service state as one rebuildable,
//! ingest-only cardo document (docs/proposals/aspd-rust-front-door.md, "Cardo
//! kernel"). raspd feeds [`Observations`] from its own request events; the
//! `aspd.observe` ingest operation projects it. Nothing here sees request
//! content, and nothing here is on the aspc request path: recording is a short
//! mutex section, and the kernel reads on its own threads.
pub mod declarations;
pub mod observations;

pub use observations::{CompileRecord, Observations, Served, ServiceInfo};

use cardo_core::{CoreEdit, Refusal, decode_core_edit};
use serde_json::Value;

/// The provider, its ingest operation, and the document and binding raspd opens.
pub const PROVIDER: &str = "aspd";
pub const OPERATION: &str = "aspd.observe";
pub const DOCUMENT: &str = "aspd";
pub const BINDING: &str = "aspd";

pub fn decode_edits(wire: Value) -> Result<Vec<CoreEdit>, Refusal> {
    let Value::Array(items) = wire else {
        return Err(Refusal::invalid("edit_rejected", "edits must be an array"));
    };
    items
        .into_iter()
        .map(|v| {
            let Value::Object(mut fields) = v else {
                return Err(Refusal::invalid("edit_rejected", "edit must be an object"));
            };
            let kind = fields
                .remove("kind")
                .and_then(|k| k.as_str().map(str::to_owned))
                .ok_or_else(|| Refusal::invalid("edit_rejected", "missing kind"))?;
            decode_core_edit(&kind, Value::Object(fields)).unwrap_or_else(|| {
                Err(Refusal::invalid(
                    "edit_rejected",
                    format!("unknown kind {kind}"),
                ))
            })
        })
        .collect()
}
