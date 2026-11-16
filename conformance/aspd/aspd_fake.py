#!/usr/bin/env python3
"""A fake Bun aspd for the aspd target (agent-spaces T-11835): the upstream a
suite-served raspd forwards to. Stdlib only.

It speaks aspc's NDJSON JSON-RPC on a Unix socket and answers three methods:
`aspc.hello`, `aspc.resolveRuntimeDeclaration` and
`aspc.compileHarnessInvocation`. A compile answers a plan whose compileId is
the request's compileRequest.identity.runtimeId, so the suite names the compile
rows raspd's kernel projects. Anything else answers -32601, as Bun does.
stop() and start() take the socket away and back, for raspd's upstream-health
transition.
"""

import json
import os
import socket
import threading


def _hello():
    return {"facadeInfo": {"name": "aspc-facade", "version": "fake"}, "protocolVersion": "aspc/0.1",
            "capabilities": {"compileHarnessInvocation": True, "resolveRuntimeDeclaration": True,
                             "transports": ["unix-jsonrpc-ndjson"]},
            "release": {"releaseId": "asp-fake", "sourceCommit": "0" * 40, "builtAt": "2026-10-26T00:00:00.000Z"}}


def _compile(params):
    identity = ((params or {}).get("compileRequest") or {}).get("identity") or {}
    compile_id = identity.get("runtimeId", "unnamed")
    return {"schemaVersion": "agent-runtime-compile-response/v2", "ok": True, "diagnostics": [],
            "plan": {"compileId": compile_id, "planHash": f"sha256:{compile_id}",
                     "execution": {"recipeId": "fake-recipe"}}}


class FakeAspd:
    def __init__(self, path):
        self.path = path
        self.server = None
        self.connections = []
        self.lock = threading.Lock()

    def start(self):
        if os.path.exists(self.path):
            os.unlink(self.path)
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.server.listen(64)
        threading.Thread(target=self._accept, args=(self.server,), daemon=True).start()
        return self

    def stop(self):
        """Close the listener and every connection; the socket node goes."""
        server, self.server = self.server, None
        if server is not None:
            server.close()
        with self.lock:
            connections, self.connections = self.connections, []
        for conn in connections:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()
        if os.path.exists(self.path):
            os.unlink(self.path)

    def _accept(self, server):
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            with self.lock:
                self.connections.append(conn)
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        buffer = b""
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    reply = self._answer(json.loads(line))
                    if reply is not None:
                        conn.sendall((json.dumps(reply, separators=(",", ":")) + "\n").encode())
        except (OSError, ValueError):
            return
        finally:
            conn.close()

    def _answer(self, request):
        if "id" not in request:
            return None
        method, params = request.get("method"), request.get("params")
        base = {"jsonrpc": "2.0", "id": request["id"]}
        if method == "aspc.hello":
            return dict(base, result=_hello())
        if method == "aspc.resolveRuntimeDeclaration":
            return dict(base, result={"ok": True})
        if method == "aspc.compileHarnessInvocation":
            return dict(base, result=_compile(params))
        return dict(base, error={"code": -32601, "message": f"Method not found: {method}"})
