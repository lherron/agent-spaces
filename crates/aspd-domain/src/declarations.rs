//! The `aspd` provider's declarations: four observation types under one family.
use serde_json::{Map, Value, json};

fn payload(fields: &[(&str, &str)], required: &[&str], nullable: &[&str]) -> Value {
    let fields: Map<String, Value> = fields
        .iter()
        .map(|(name, kind)| ((*name).to_owned(), json!({ "kind": kind })))
        .collect();
    json!({"kind":"object","fields":fields,"required":required,"nullable":nullable})
}

fn observation(name: &str, key: &[&str], payload: Value, title: &str) -> Value {
    json!({
        "name": name,
        "schema_version": 1,
        "family": "aspd.observation",
        "root": true,
        "observation": true,
        "natural_key": key,
        "payload": payload,
        "hints": {"title_field": title},
    })
}

pub fn declarations() -> Value {
    let service = payload(
        &[
            ("name", "string"),
            ("role", "string"),
            ("releaseId", "string"),
            ("sourceCommit", "string"),
            ("builtAt", "string"),
            ("raspdSourceCommit", "string"),
            ("socket", "string"),
            ("upstreamSocket", "string"),
            ("pid", "integer"),
            ("startedAt", "string"),
        ],
        &[
            "name",
            "role",
            "releaseId",
            "sourceCommit",
            "builtAt",
            "raspdSourceCommit",
            "socket",
            "upstreamSocket",
            "pid",
            "startedAt",
        ],
        &[],
    );
    let upstream = payload(
        &[
            ("name", "string"),
            ("socket", "string"),
            ("state", "string"),
            ("lastOkAt", "string"),
            ("lastFailureAt", "string"),
            ("lastError", "string"),
            ("failures", "integer"),
        ],
        &["name", "socket", "state", "failures"],
        &["lastOkAt", "lastFailureAt", "lastError"],
    );
    let op = payload(
        &[
            ("op", "string"),
            ("native", "integer"),
            ("relayed", "integer"),
            ("upstreamFailed", "integer"),
        ],
        &["op", "native", "relayed", "upstreamFailed"],
        &[],
    );
    let compile = payload(
        &[
            ("compileId", "string"),
            ("planHash", "string"),
            ("recipe", "string"),
            ("outcome", "string"),
            ("servedBy", "string"),
            ("durationMs", "integer"),
            ("completedAt", "string"),
        ],
        &[
            "compileId",
            "outcome",
            "servedBy",
            "durationMs",
            "completedAt",
        ],
        &["planHash", "recipe"],
    );
    json!({
        "provider": crate::PROVIDER,
        "version": "1",
        "node_families": [{
            "name": "aspd.observation",
            "domain_attributes": {
                "kind": "object",
                "fields": {"source": {"kind": "string"}},
                "required": ["source"],
            },
        }],
        "node_types": [
            observation("aspd.service", &["name"], service, "name"),
            observation("aspd.upstream", &["name"], upstream, "name"),
            observation("aspd.op", &["op"], op, "op"),
            observation("aspd.compile", &["compileId"], compile, "compileId"),
        ],
        "operations": [{
            "name": crate::OPERATION,
            "kind": "ingest",
            "writes": ["aspd.service", "aspd.upstream", "aspd.op", "aspd.compile"],
            "reports_catch_up": true,
            "input": {"kind": "object", "fields": {}},
            "output": {"kind": "object", "fields": {}},
        }],
    })
}
