#!/usr/bin/env bash
# Deliver only the lock commit made by this explicit consumer pull. Git delivery
# starts HRC's owner-monitored CI; it does not select or activate an HRC release.
set -euo pipefail
fail() { printf 'hrc-sync: %s\n' "$*" >&2; exit 1; }
[[ $# == 1 ]] || fail 'usage: sync-hrc-downstream.sh <hrc-runtime-checkout>'
[[ -z "${GIT_INDEX_FILE:-}" ]] || fail 'GIT_INDEX_FILE is set; run outside a Git hook before syncing HRC.'
command -v wrkc >/dev/null || fail 'wrkc is required to notify mable@hrc-runtime:primary before syncing HRC.'
cd "$1"
[[ "$(git branch --show-current)" == main ]] || fail 'consumer must be on main; ask the HRC owner to reconcile its checkout.'
git fetch origin main
before="$(git rev-parse HEAD)"
[[ "$before" == "$(git rev-parse refs/remotes/origin/main)" ]] || fail 'consumer HEAD differs from origin/main; deliver or reconcile existing work with the HRC owner first.'
git ls-files --error-unmatch bun.lock >/dev/null || fail 'consumer has no tracked bun.lock.'
lock_status="$(git status --porcelain -- bun.lock)" || fail 'cannot inspect bun.lock before pulling.'
[[ -z "$lock_status" ]] || fail 'bun.lock must be clean before pulling; preserve the owner’s lock edits.'
just pull-deps
after="$(git rev-parse HEAD)"
[[ "$(git branch --show-current)" == main ]] || fail 'consumer branch changed during pull; ask the HRC owner to reconcile it.'
lock_status="$(git status --porcelain -- bun.lock)" || fail 'cannot inspect bun.lock after pulling; no build or delivery claimed.'
[[ -z "$lock_status" ]] || fail 'pull-deps left uncommitted bun.lock; ask the HRC owner to commit and deliver it before retrying. No build or delivery claimed.'
if [[ "$after" != "$before" ]]; then
  [[ "$(git show -s --format=%P "$after")" == "$before" ]] || fail "pull created unexpected history at $after; refusing to push unrelated work."
  [[ "$(git diff-tree --no-commit-id --name-only -r "$after")" == bun.lock ]] || fail "pull commit $after is not lock-only; refusing to push unrelated work."
  subject="$(git show -s --format=%s "$after")"
  [[ "$subject" == 'chore: sync bun.lock ('* ]] || fail "pull commit $after is not a generated lock sync; refusing to push unrelated work."
  git push origin "$after:refs/heads/main" || fail "push failed for generated lock $after; it remains local. Ask the HRC owner to reconcile and push that exact commit; do not activate it."
  notice="ASP downstream sync pushed HRC $after (parent $before): $subject. Monitor HRC post-push-verify; this push may supersede an in-flight run. No HRC release selection/publication/activation was performed."
  wrkc say mable@hrc-runtime:primary --to mable@hrc-runtime:primary --fyi -m "$notice" || fail "already pushed HRC $after but could not notify its owner. Retry: wrkc say mable@hrc-runtime:primary --to mable@hrc-runtime:primary --fyi -m 'Monitor post-push-verify for $after; no activation performed.'"
  git fetch origin main || fail "pushed HRC $after and notified its owner, but remote readback failed."
  git merge-base --is-ancestor "$after" refs/remotes/origin/main || fail "cannot prove delivery of pushed HRC $after; ask the notified HRC owner to inspect origin/main."
  printf 'hrc-sync: delivered lock %s and notified mable@hrc-runtime:primary; HRC CI/activation remain owner-gated.\n' "$after"
else
  printf 'hrc-sync: unchanged HEAD and clean bun.lock; no new commit to deliver.\n'
fi
bun run build
