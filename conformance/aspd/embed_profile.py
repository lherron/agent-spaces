"""aspd's embed-policy profile (cardo conformance/embed_suite.py).

The suite owns lifecycle and assertions. The profile owns complete argv and
private paths. The failure hook leaves the daemon alive with an unbindable
kernel socket, so the record can truthfully say failed while aspc still serves.
"""
import os
from pathlib import Path
import shutil
import subprocess


def make_profile(release, scratch, evidence, binary=None):
    from embed_suite import Profile

    release, scratch, evidence = map(Path, (release, scratch, evidence))
    root = scratch / 'var'
    kernel_socket = scratch / 'kernel.sock'
    evidence.mkdir(parents=True, exist_ok=True)
    argv = [str(binary or release / 'raspd'), 'serve', '--release-root', str(release),
            '--socket', str(scratch / 'aspd.sock'),
            '--kernel-socket', str(kernel_socket), '--kernel-root', str(root),
            '--kernel-instance', 'conformance', '--log', str(evidence / 'raspd.log')]
    env = dict(os.environ, ASP_USAGE_METRICS_VAR_ROOT=str(root))

    def launch(fail=False):
        if kernel_socket.is_dir():
            kernel_socket.rmdir()
        if fail:
            kernel_socket.mkdir()
        with (evidence / 'host.log').open('a') as log:
            return subprocess.Popen(argv, stdout=log, stderr=log, env=env)

    return Profile(
        start=launch,
        stop=lambda process: process.terminate(),
        fail_start=lambda: launch(fail=True),
        root=root,
        mount='aspd:conformance',
        socket=kernel_socket,
        log=root / 'logs/aspd/conformance.log',
        directory=None,
        stop_supported=False,
        cli=[shutil.which('cardo') or 'cardo'],
        timeout=30,
    )
