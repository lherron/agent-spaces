# Agent-Hygiene Lint Rules (W4xx ledger)

Tier-1 deterministic rules for the two-tier hygiene linter. Criteria are ported from
`~/praesidium/archagent/agent-hygiene/` (PROMPT-HYGIENE-CORE C-block, profiles/,
CROSS-LAYER XL-block, reference/SKILL-RUBRIC `[MECHANICAL]` checks).

**This linter is advisory** (`asp lint --hygiene` exits 0 by default; `--strict` exits
nonzero only on `error`-severity findings). It is deliberately NOT wired into
`just check`, so it does NOT get a `checks/AUTHORING.md` row — that ledger governs
verify-gating `scripts/check-*.ts` only, and an unwired row is a `RULE-AUTHORING-STALE-ROW`
violation. This file is the W4xx ledger instead.

| code | criterion (source) | applies to | severity | check |
|------|--------------------|-----------|----------|-------|
| W400 | U1 / BP-64 name==dirname + kebab | skills | warning | frontmatter `name` equals dir basename and is kebab-case (M2) |
| W401 | U11 / BP-17 / CF-3 description budget | model-invoked skills | warning >500c / info >350c | `description` char count vs the ~500-char resident ceiling (M4) |
| W402 | U11 / BP-17 / CF-3 body budget | resident prompts / all bodies | warning (resident words) / info (line backstop) | resident body word budget; universal ~500-line backstop. On-demand skill bodies get NO word cap (CF-3) |
| W410 | BP-01 optional step | skills | info | optionality token on a step (M6) |
| W411 | BP-02/03 fuzzy gate | skills + prompts | info | belief/judgement gate language (M6) |
| W412 | BP-25 nuance clause | skills + prompts | info | appended `unless`/`except`/`doesn't apply` clause (M6) |
| W413 | BP-31 dated content | skills + prompts | info | date / URL / session-narrative in a runtime file (M6) |
| W414 | BP-39 @-include | skills + prompts | info | `@file.md` include that loads immediately (M6) |
| W415 | MR3 / BP-69 model-name weld | skills + prompts | info | hard model name as live guidance (M7) |
| W416 | MR5 / BP-71 reasoning echo | skills + prompts | info | "show your reasoning"-style instruction (M7) |
| W417 | MR2 / SP4 / BP-68 human-in-the-loop | skills + prompts | info | ask/confirm/human-partner remedy w/o autonomous branch (M7) |
| W420 | U21 / BP-58 orphaned artifact | skills | warning | bundled file no pointer reaches, or dev/test/log artifact in runtime dir (M5) |
| W421 | U13 / BP-11 broken pointer | skills | error | markdown link to a file that does not exist (M5) |
| W422 | U14 / BP-12 reference nesting | skills | info | reference file >100 lines with no top-of-file Contents list (M5) |
| W430 | XL0 dead layer | agent-root instruction files | error | `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`.cursorrules` referenced by no context template or profile |

## Severity → `--strict`

`--strict` exits nonzero on any non-suppressed `error`-severity finding (W421 broken
pointer, W430 dead layer). `warning` and `info` are advisory and never gate.

## W41x tripwires are candidates, not verdicts

Every W41x hit is a grep candidate (a line to read, per the rubric's "a hit is a
CANDIDATE, not a verdict"). They emit `info` and are scanned over the primary file
only (line-accurate evidence); fenced code blocks are skipped. Deeper judgement —
supporting files, context-sensitive verdicts — is tier 2 (`--judge`).

## Baseline (`.hygiene-baseline.json`)

`--baseline <path>` suppresses findings whose fingerprint `sha256(code, relPath,
message)` is recorded. `--update-baseline` regenerates it (reviewed grandfather/reset
only). Tripwire line anchors are normalized out of the fingerprint so a one-line shift
does not un-suppress a grandfathered finding.
