Hey bud, need your help with a planning pass. Please follow these steps carefully and keep context tight.

0a. Study `specs/*` to learn the application specifications.
0b. Study IMPLEMENTATION_PLAN.md (if present) to understand the plan so far.
0c. For reference, the application source code is in `packages/*`.

1. Study IMPLEMENTATION_PLAN.md (if present; it may be incorrect) and study existing source code in `packages/*` to compare it against `specs/*`. Analyze findings, prioritize tasks, and create/update IMPLEMENTATION_PLAN.md as a bullet point list sorted in priority of items yet to be implemented. Consider searching for TODO, minimal implementations, placeholders, skipped/flaky tests, and inconsistent patterns. Keep IMPLEMENTATION_PLAN.md up to date with items considered complete/incomplete.

Important: Plan only. Don't implement anything. Don't assume functionality is missing; confirm with code search first.

Ultimate goal: We want to achieve the project goals defined in specs/*. Consider missing elements and plan accordingly. If an element is missing, search first to confirm it doesn't exist, then if needed author the specification at specs/FILENAME.md. If you create a new element then document the plan to implement it in IMPLEMENTATION_PLAN.md.

Please add one level of sub-tasks so a less capable agent can more easily follow the plan and implement tasks.  Use markdown checkboxes so they can mark tasks completed and not get confused.
