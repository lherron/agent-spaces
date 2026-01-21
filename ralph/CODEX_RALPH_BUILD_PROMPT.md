Hey bud, need your help with a task.  Please follow these steps carefully and keep context tight.

0a. Study specs/* to learn the application specifications.
0b. Study IMPLEMENTATION_PLAN.md.
0c. For reference, the application source code is in packages/*.

1. Implement functionality per the specifications. Follow IMPLEMENTATION_PLAN.md and choose the most important item to address. Before making changes, search the codebase (don’t assume it’s not implemented) to confirm existing behavior. Do not parallelize build/tests; run them once directly. Use deeper reasoning when complex debugging or architectural decisions are needed.
2. After implementing functionality or resolving problems, run tests for the unit of code that was improved. If functionality is missing, it’s your job to add it as per the application specifications.
3. When you discover issues, immediately update IMPLEMENTATION_PLAN.md with your findings. When resolved, update and remove the item.
4. When tests pass, update IMPLEMENTATION_PLAN.md, then run git add -A, then git commit with a message describing the changes. After the commit, git push.
5. Important: When authoring documentation, capture the why — tests and implementation importance.
6. Important: Single sources of truth, no migrations/adapters. If tests unrelated to your work fail, resolve them as part of the increment.
7. As soon as there are no build or test errors create a git tag. If there are no git tags start at 0.0.0 and increment patch by 1 (e.g., 0.0.1 if 0.0.0 does not exist).
8. You may add extra logging if required to debug issues.
9. Keep IMPLEMENTATION_PLAN.md current with learnings — future work depends on this to avoid duplicating efforts. Update especially after finishing your turn.
9999999999. When you learn something new about how to run the application, update @AGENTS.md but keep it brief. For example, if you run commands multiple times before learning the correct command then that file should be updated.
99999999999. For any bugs you notice, resolve them or document them in IMPLEMENTATION_PLAN.md even if it is unrelated to the current piece of work.
999999999999. Implement functionality completely. Placeholders and stubs waste efforts and time redoing the same work.
9999999999999. When IMPLEMENTATION_PLAN.md becomes large periodically clean out the items that are completed from the file.
99999999999999. If you find inconsistencies in specs/* then update the specs with careful, thorough reasoning.
999999999999999. IMPORTANT: Keep @AGENTS.md operational only — status updates and progress notes belong in IMPLEMENTATION_PLAN.md. A bloated AGENTS.md pollutes every future loop’s context.

Note: This session is running non-interactive and no user will be able to respond to any questions.  Please proceed with the steps above as described.
