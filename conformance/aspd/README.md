# aspd kernel conformance

Build an immutable ASP release with `just build-asp-release <absolute-output-root>`
from a clean checkout. This builds an artifact; it does not install or activate it.
Then run:

```sh
just conform-aspd <release-directory> <absolute-scratch-directory> <absolute-artifact-directory>
```

`run.py` resolves cardo's exact revision from `crates/Cargo.toml` and imports the
suite from Cargo's checkout of that revision. It refuses a missing pin or release
rather than falling back to the installed daemon. The local profile starts raspd
on private sockets over `aspd_fake.py`, with its own kernel registry root and
usage metrics. `--class NAME` on `run.py` selects a class for diagnosis; the recipe
runs every applicable class of both the wire and embed suites.
`--suite wire|embed` selects one suite for diagnosis. Each must pass independently.

`profile.py` owns the aspd profile and projection cell moved from cardo's
`conformance/wire_suite.py`; `aspd_fake.py` moved from cardo's conformance directory.
The suite-row exception for query/replay is the existing T-11835 ruling: aspd
only observes its own requests, so the projection cell grades query, ordering,
subscription diffs and event replay over those rows instead of fabricated rows.
All other applicability decisions come from the suite and discovery.

`embed_profile.py` supplies the second suite with complete lifecycle hooks, the
private registry root and log destination, no directory, and the unbindable
kernel socket as its failed-start hook. Its five cells are record, standard_ops,
surface, log, and reload (n/a with no directory).

The kernel is the `aspd` app, protocol 3, with one rebuildable ingest-only `aspd`
graph. `--kernel-root` and `--kernel-instance` mirror cardo's standard arguments;
the unnamed instance at cardo's default root is the installed mount `aspd`.
`--kernel-socket` retains its existing default and launcher contract.

`kernel.stop` refuses `stop_unsupported`: aspd's lifecycle belongs to its service
supervisor. SIGTERM or SIGINT retires the kernel alongside aspc, with ordered
wire stop/join and owner shutdown under the teardown watchdog. A failed kernel
start leaves aspc serving and records the failure.

Cardo cleanup after this migration lands: remove `conformance/aspd_fake.py`, the
`AspdProfile` class, the aspd projection helpers/cell, and the aspd-specific import,
CLI branch/flags and documentation from `conformance/wire_suite.py`. Keep the
shared `ServedProductProfile`, suite classes and grading API.
