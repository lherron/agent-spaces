#!/usr/bin/env python3
"""Run cardo's pinned suite against an ASP release without installing it."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil
import traceback

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--workdir', required=True, type=Path)
    parser.add_argument('--artifact-dir', required=True, type=Path)
    parser.add_argument('--class', dest='only', action='append')
    parser.add_argument('--suite', choices=['wire', 'embed', 'both'], default='both')
    args = parser.parse_args()
    import tomllib
    # Match the commit Cargo.lock locked, so a pin spelled as a tag, a tag
    # object id or a commit all resolve to the same checkout (cardo-app-guide §3.11).
    lock = tomllib.loads((ROOT / 'crates/Cargo.lock').read_text())['package']
    revs = {p['source'].rsplit('#', 1)[1] for p in lock
            if p['name'].startswith('cardo-') and 'github.com/lherron/cardo' in p.get('source', '')}
    if len(revs) != 1:
        parser.error(f'Cargo.lock must lock every cardo crate to one commit, found {sorted(revs)}')
    rev = revs.pop()
    # Reuse Cargo's exact checkout; never depend on another repo's moving HEAD.
    cargo = Path(os.environ.get('CARGO_HOME', Path.home() / '.cargo'))
    checkouts = [p for p in (cargo / 'git/checkouts').glob('cardo-*/*')
                 if (p / 'conformance/wire_suite.py').exists()
                 and subprocess.check_output(['git', '-C', str(p), 'rev-parse', 'HEAD'], text=True).strip() == rev]
    if not checkouts:
        parser.error(f'Cargo checkout for cardo {rev} missing; build raspd first')
    sys.path.insert(0, str(checkouts[0] / 'conformance'))
    # Prefer this repo's fake after cardo deletes its old copy.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import wire_suite as suite
    from profile import AspdProfile, aspd_projection
    suite.aspd_projection = aspd_projection
    suite.V.set(3)
    args.workdir.mkdir(parents=True, exist_ok=True)
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    args.workdir = str(args.workdir.resolve())
    args.artifact_dir = str(args.artifact_dir.resolve())
    args.target = 'aspd'
    profile = AspdProfile(args.workdir, str(args.release.resolve()))
    if not Path(profile.host_binary).is_file():
        parser.error(f'no raspd launcher in {args.release}')
    cli = shutil.which('cardo')
    try:
        cli_version = subprocess.run([cli, '--version'], capture_output=True, text=True, timeout=10).stdout.strip() if cli else ''
    except (OSError, subprocess.TimeoutExpired):
        cli_version = ''
    # The embed suite grades with the installed CLI; record it so a skew shows (§3.11).
    print(f'cardo={rev} release={args.release.resolve()} protocol=3', flush=True)
    print(f'cardo-cli={cli or "missing"} version={cli_version or "unknown"}', flush=True)
    failed = False
    if args.suite in ('wire', 'both'):
        try:
            args.socket = profile.start()
            args.sockets = [args.socket]
            failed |= suite.grade(args, profile, args.workdir) != 0
        except Exception:
            traceback.print_exc()
            failed = True
        finally:
            profile.stop()
    if args.suite in ('embed', 'both'):
        scratch = None
        evidence = Path(args.artifact_dir) / 'embed'
        try:
            from embed_suite import grade
            from embed_profile import make_profile
            # Keep sockets short regardless of the caller's scratch path.
            scratch = Path(tempfile.mkdtemp(prefix='aspd-embed.', dir='/tmp'))
            results = grade(make_profile(args.release.resolve(), scratch, evidence), evidence)
            print(results, flush=True)
            failed |= any(result['status'] == 'fail' for result in results.values())
        except Exception:
            traceback.print_exc()
            failed = True
        finally:
            if scratch is not None:
                kernel_log = scratch / 'var/logs/aspd/conformance.log'
                if kernel_log.is_file():
                    shutil.copyfile(kernel_log, evidence / 'kernel.log')
                shutil.rmtree(scratch, ignore_errors=True)
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
