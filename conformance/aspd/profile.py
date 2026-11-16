"""aspd conformance profile and projection cell, owned by agent-spaces.

Moved from cardo/conformance/wire_suite.py (2aa345c), preserving the
suite-row exception ruled in T-11835. Assertions use the pinned suite API.
"""
import json
import os
import socket
import time
import uuid
import aspd_fake
from wire_suite import (ServedProductProfile, CardoProfile, ATTRIBUTION, V,
                        Stream, check, wait_for)

class AspdProfile(ServedProductProfile):
    """raspd: aspd's Rust front door (agent-spaces crates/raspd, T-11835),
    from an ASP release, unmodified. Its embedded kernel projects raspd's own
    service state (serving release, Bun upstream health, per-op native,
    relayed and upstream_failed counts, recent compiles) into an ingest-only
    document through its aspd.observe operation.

    The suite serves its own raspd on a private root in front of aspd_fake.py,
    a fake Bun aspd. The only way to change what raspd observes is aspc
    traffic, so a write is one aspc request into raspd's aspc socket, then a
    wake of this profile's binding on the class's scratch document: one
    observation change, one commit. That carries the restart class, which
    needs commits and not particular rows. query and replay need the suite's
    own rows (named, valued, deleted), which aspc traffic cannot write; they
    are N/A here, and the aspd_projection cell grades the same reads (query,
    where, order, subscribe diffs, resume) over the rows raspd produces."""

    name = "aspd"
    format = "aspd"
    RING = CardoProfile.RING
    IDEMPOTENCY_KEY = True
    read_op = "document.inspect"  # spelled at use: V.op(p.read_op)
    write_op = "aspd.observe"
    SCRATCH = "ws-aspd."
    LOG = "raspd.log"
    CELLS = ["aspd_projection"]
    NO_SUITE_ROWS = ("aspd's rows are raspd's own observations; aspc traffic cannot write, "
                     "value or delete the suite's rows (aspd_projection grades these reads)")
    # The system aspd namespace's selected release, when the --aspd-release
    # flag names none.
    ACTIVE = os.path.expanduser("~/praesidium/var/aspd/service/active.json")

    def __init__(self, workdir, release):
        super().__init__(workdir)
        self.release = release
        # The release's launcher, an absolute path, so the host classes'
        # join(REPO, "target", "debug", host_binary) answers it unchanged.
        self.host_binary = os.path.join(release, "raspd") if release else None

    @classmethod
    def installed_release(cls):
        try:
            with open(cls.ACTIVE) as handle:
                return json.load(handle)["releasePath"]
        except (OSError, ValueError, KeyError):
            return None

    def make_fake(self, scratch):
        # raspd's usage metrics stay in the scratch, for this host and the
        # restart class's own (they inherit this environment).
        os.environ["ASP_USAGE_METRICS_VAR_ROOT"] = os.path.join(scratch, "var")
        return aspd_fake.FakeAspd(os.path.join(scratch, "bun.sock")).start()

    def host_socket(self, work):
        return os.path.join(work, "raspd-kernel.sock")

    def aspc_socket(self, kernel_socket):
        """raspd's aspc socket beside its kernel socket (under --prove-red,
        beside the break proxy, which sits in the same directory)."""
        return os.path.join(os.path.dirname(kernel_socket), "aspd.sock")

    def serve_argv(self, binary, socket_path, state):
        work = os.path.dirname(socket_path)
        return [binary, "serve", "--socket", self.aspc_socket(socket_path), "--upstream", self.fake.path,
                "--kernel-socket", socket_path, "--kernel-root", os.path.join(work, "var"),
                "--kernel-instance", "conformance", "--log", os.path.join(work, "raspd-requests.log")]

    def unavailable(self, name):
        if name in ("query", "replay"):
            return self.NO_SUITE_ROWS
        return None

    def aspc(self, kernel_socket, method, params=None):
        """One aspc request to the raspd beside `kernel_socket`; answers its reply."""
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(30)
        conn.connect(self.aspc_socket(kernel_socket))
        try:
            request = {**ATTRIBUTION, "jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
            conn.sendall((json.dumps(request) + "\n").encode())
            reply = conn.makefile("r").readline()
        finally:
            conn.close()
        check(reply, f"raspd answers {method}", None)
        return json.loads(reply)

    def settle(self, wire, claim, runs=None):
        """Our binding idle with every run settled (and at least `runs`)."""
        def behind():
            binding = self.binding(wire)
            done = (binding and binding["state"] == "idle" and binding["current_run"] is None
                    and binding["runs"]["started"] == binding["runs"]["settled"]
                    and (runs is None or binding["runs"]["settled"] >= runs))
            return None if done else {"binding": binding}
        deadline = time.time() + 30
        while behind():
            check(time.time() < deadline, f"{claim} within 30 s", behind())
            time.sleep(0.05)

    def open(self, wire, document_id):
        if self.attached:  # one scratch binding at a time
            wire.call("ingest.detach", {V.G: self.attached, "binding": self.BINDING})
        doc = CardoProfile.open(self, wire, document_id)
        wire.ok("ingest.attach", {V.G: document_id, "binding": self.BINDING, "operation": self.write_op,
                                  "config": {}, "interval_ms": 3600000})
        self.attached = document_id
        self.settle(wire, "the scratch binding bootstraps", runs=1)
        doc["revision"] = wire.ok(V.op("document.inspect"), {V.G: document_id})["result"]["revision"]
        return doc

    def write(self, run, doc, edits, args=None):
        # Read the commit from ingest.status and the document.
        check(args is None, "aspd writes only through ingest; a fenced write needs a client write op", args)
        wire = run.wire
        revision = wire.ok(V.op("document.inspect"), {V.G: doc["id"]})["result"]["revision"]
        before = self.binding(wire)
        for _ in edits:
            self.aspc(run.socket_path, "health")
        wire.ok("ingest.wake", {V.G: doc["id"], "binding": self.BINDING})
        self.settle(wire, "the binding ingests the request", runs=before["runs"]["settled"] + 1)
        after = self.binding(wire)
        last = after["last_run"] or {}
        now_at = wire.ok(V.op("document.inspect"), {V.G: doc["id"]})["result"]["revision"]
        check(after["runs"]["settled"] == before["runs"]["settled"] + 1 and last.get("result") == "committed"
              and now_at == revision + 1, "one aspc request commits exactly once",
              {"before": revision, "after": now_at, "runs": [before["runs"], after["runs"]], "last_run": last})
        return {"id": "ingest", "ok": True, "receipt": {"receipt_id": last["receipt_id"], "revision_after": now_at}}

    def new_edit(self, node_id):
        return {"aspd": "health", "node": node_id}

    def put_edit(self, node_id, node_type, value):
        return {"aspd": "health", "node": node_id}

    def remove_edit(self, node_id):
        raise NotImplementedError(self.NO_SUITE_ROWS)


def _aspd_rows(run, node_type, where=None):
    args = {V.G: "aspd", "type": node_type}
    if where:
        args["where"] = where
    return run.wire.ok(V.op("document.query"), args)["result"]["rows"]


def _aspd_op(run, op):
    rows = _aspd_rows(run, "aspd.op", {"op": op})
    return rows[0]["payload"] if rows else {"op": op, "native": 0, "relayed": 0, "upstreamFailed": 0}


def aspd_projection(run):
    """raspd's own document over the rows raspd produces, driven only by aspc
    traffic into the suite's raspd and its fake Bun: the serving release;
    native, relayed and upstream_failed counts per op; compile rows named by
    the plans Bun answered; one commit per drained batch; document.query
    where and order; a query.subscribe diff; events.subscribe resume over
    those commits; and the upstream-health transition when Bun goes away
    and comes back."""
    p, wire, kernel = run.p, run.wire, run.socket_path
    with open(os.path.join(p.release, "release.json")) as handle:
        release = json.load(handle)

    # 1. The serving release, and the raspd that answers version.
    service = wait_for(lambda: _aspd_rows(run, "aspd.service"), 10, "the aspd document carries its service row")
    service = service[0]["payload"]
    check(service["releaseId"] == release["releaseId"] and service["sourceCommit"] == release["sourceCommit"]
          and service["role"] == "front", "the service row names the serving release", service)
    front = p.aspc(kernel, "version")["result"]["frontDoor"]
    check(front["name"] == "raspd" and front["sourceCommit"] == service["raspdSourceCommit"],
          "the service row names the raspd that answers version", [front, service])

    # 2. Native vs relayed, per op.
    ops = ["aspc.hello", "health", "aspc.resolveRuntimeDeclaration", "aspc.compileHarnessInvocation"]

    # raspd's own document picks up aspc traffic on its wake poll (250 ms),
    # so a request an earlier cell sent (perf's `health`) may land after this
    # cell starts. Take the baseline only once the counts hold still for
    # longer than that poll; otherwise the delta below is off by that request.
    def settled_counts():
        first = {op: _aspd_op(run, op) for op in ops}
        time.sleep(0.4)
        second = {op: _aspd_op(run, op) for op in ops}
        return second if second == first else None
    base = wait_for(settled_counts, 10, "the aspd op counts hold still before the baseline read",
                    lambda: {op: _aspd_op(run, op) for op in ops})
    hello = {"clientInfo": {"name": "wiresuite"}, "protocolVersions": ["aspc/0.1"]}
    for _ in range(2):
        check(p.aspc(kernel, "aspc.hello", hello)["result"]["protocolVersion"] == "aspc/0.1", "hello answers", None)
    for _ in range(3):
        p.aspc(kernel, "health")
    check(p.aspc(kernel, "aspc.resolveRuntimeDeclaration")["result"] == {"ok": True}, "resolve is relayed", None)
    compiles = [f"wiresuite-{uuid.uuid4().hex[:8]}-{n}" for n in range(2)]
    for compile_id in compiles:
        reply = p.aspc(kernel, "aspc.compileHarnessInvocation", {"compileRequest": {"identity": {"runtimeId": compile_id}}})
        check(reply["result"]["plan"]["compileId"] == compile_id, "the compile is relayed", reply)
    delta = {"aspc.hello": ("native", 2), "health": ("native", 3), "aspc.resolveRuntimeDeclaration": ("relayed", 1),
             "aspc.compileHarnessInvocation": ("relayed", 2)}

    def counted():
        now = {op: _aspd_op(run, op) for op in ops}
        return now if all(now[op][field] == base[op][field] + n and now[op]["upstreamFailed"] == base[op]["upstreamFailed"]
                          for op, (field, n) in delta.items()) else None
    wait_for(counted, 10, "each op counts what raspd served natively and what Bun answered",
             lambda: {op: _aspd_op(run, op) for op in ops})

    # 3. Compile rows, named by the plans Bun answered.
    for compile_id in compiles:
        rows = _aspd_rows(run, "aspd.compile", {"compileId": compile_id})
        check(len(rows) == 1 and rows[0]["payload"]["planHash"] == f"sha256:{compile_id}"
              and rows[0]["payload"]["recipe"] == "fake-recipe" and rows[0]["payload"]["outcome"] == "ok"
              and rows[0]["payload"]["servedBy"] == "bun", "a compile row carries its plan's id, hash and recipe", rows)

    # 4. Order on a numeric path.
    ordered = wire.ok(V.op("document.query"), {V.G: "aspd", "type": "aspd.op",
                                         "order": [{"field": "native", "dir": "desc"}]})["result"]["rows"]
    natives = [row["payload"]["native"] for row in ordered]
    check(len(natives) >= len(ops) and natives == sorted(natives, reverse=True),
          "order desc on native orders numerically", natives)

    # 5. query.subscribe: a health request yields a diff upserting its row.
    stream = Stream(kernel, {V.G: "aspd", "type": "aspd.op", "where": {"op": "health"}},
                    op="query.subscribe")
    try:
        check(stream.response.get("ok") is True, "query.subscribe succeeds", stream.response)
        before = stream.response["result"]["rows"][0]["payload"]["native"]
        p.aspc(kernel, "health")
        diff = wait_for(lambda: stream.diffs() and stream.diffs()[0], 10, "a health request yields a diff",
                        lambda: stream.events)
        check([row["payload"]["native"] for row in diff.get("upsert", [])] == [before + 1] and diff.get("remove") == [],
              "the diff upserts the health row, one more native", diff)
    finally:
        stream.close()

    # 6. events.subscribe resumes the receipts after a cursor.
    cursor = wire.ok("resync")["result"]["cursor"]
    for n in range(3):
        target = _aspd_op(run, "health")["native"] + 1
        p.aspc(kernel, "health")
        wait_for(lambda: _aspd_op(run, "health")["native"] == target, 10, f"health request {n} commits")
    resumed = Stream(kernel, {"after": cursor, V.GS: ["aspd"], "kinds": ["receipt"]})
    try:
        check(resumed.response.get("ok") is True and resumed.response["result"].get("replayed", 0) >= 3,
              "events.subscribe {after} replays the receipts since", resumed.response)
        receipts = wait_for(lambda: len(resumed.of("receipt")) >= 3 and resumed.of("receipt"), 5,
                            "the replayed receipts arrive", lambda: resumed.events)
        revisions = [event["detail"]["revision_after"] for _, event in receipts]
        check(revisions == sorted(set(revisions)), "replayed receipts are in commit order", revisions)
    finally:
        resumed.close()

    # 7. A batch answered before the wake commits once.
    doc = run.doc("projection")
    before = p.binding(wire)["runs"]["settled"]
    for _ in range(4):
        p.aspc(kernel, "health")
    p.aspc(kernel, "aspc.compileHarnessInvocation", {"compileRequest": {"identity": {"runtimeId": compiles[0] + "-b"}}})
    wire.ok("ingest.wake", {V.G: doc["id"], "binding": p.BINDING})
    p.settle(wire, "the batch is ingested", runs=before + 1)
    revision = wire.ok(V.op("document.inspect"), {V.G: doc["id"]})["result"]["revision"]
    check(revision == doc["revision"] + 1 and p.binding(wire)["runs"]["settled"] == before + 1,
          "a drained batch of five requests commits exactly once", {"before": doc["revision"], "after": revision})

    # 8. Bun goes away and comes back.
    up = _aspd_rows(run, "aspd.upstream")[0]["payload"]
    failed = _aspd_op(run, "aspc.resolveRuntimeDeclaration")["upstreamFailed"]
    p.fake.stop()
    try:
        refused = p.aspc(kernel, "aspc.resolveRuntimeDeclaration")
        check(refused.get("error", {}).get("data", {}).get("reason") == "upstream_unavailable",
              "with Bun gone, a forwarded request is refused upstream_unavailable", refused)
        wait_for(lambda: (lambda u: u["state"] == "unavailable" and u["failures"] == up["failures"] + 1)(
            _aspd_rows(run, "aspd.upstream")[0]["payload"]), 10, "the upstream row turns unavailable",
            lambda: _aspd_rows(run, "aspd.upstream"))
        check(_aspd_op(run, "aspc.resolveRuntimeDeclaration")["upstreamFailed"] == failed + 1,
              "the op counts the upstream failure", _aspd_op(run, "aspc.resolveRuntimeDeclaration"))
        check(p.aspc(kernel, "health")["result"]["degraded"] == ["upstream_unavailable"],
              "health names the unavailable upstream", None)
    finally:
        p.fake.start()
    check(p.aspc(kernel, "aspc.resolveRuntimeDeclaration")["result"] == {"ok": True}, "Bun answers again", None)
    wait_for(lambda: _aspd_rows(run, "aspd.upstream")[0]["payload"]["state"] == "healthy", 10,
             "the upstream row turns healthy again", lambda: _aspd_rows(run, "aspd.upstream"))
