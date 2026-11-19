#!/usr/bin/env python3
"""Drive the installed Tabularasagem seat through HRC and preserve each gate's evidence.

Run on max3 from a live prae caller after validating and publishing the profile:
  python3 scripts/antigravity-hrcpty-live-e2e.py --out /absolute/evidence/path --reply-to <caller-seat>
Use --gate N with the same --out to run a single gate on that seat.
The successful successor remains live for the operator to archive.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
from uuid import uuid4


GATES = ("starts", "turn", "steer-mail", "interrupt", "resume")
SLOW = "Run exactly one shell command now: sleep 4; printf READY. Wait synchronously for it."
TERMINALS = {"turn.completed", "turn.failed", "turn.interrupted"}
PTY_LOGS = Path.home() / "praesidium/var/logs/hrc-runtime/hrcpty"


class Acceptance:
    def __init__(self, out, reply_to):
        self.out = out
        self.reply_to = reply_to
        self.state_path = out / "seat.json"
        self.seat = self.state = None

    @staticmethod
    def write(path, data):
        path.write_text(json.dumps(data, indent=2) + "\n")

    def prae(self, name, *args):
        argv = ("prae", *args, "--json")
        result = subprocess.run(argv, capture_output=True, text=True, timeout=45)
        try:
            envelope = json.loads(result.stdout)
        except ValueError as error:
            raise RuntimeError(f"{argv} failed: {result.stderr}") from error
        self.write(self.gate_dir / f"{name}.json", envelope)
        assert result.returncode == 0 and envelope["ok"], (argv, envelope)
        return envelope["result"]

    def events(self, after=0):
        return self.prae("broker-events", "seat", "history", self.seat, "--kinds",
                         "broker-events", "--runtime-id", self.state["runtime"], "--since",
                         str(after), "--limit", "200")

    def wait_event(self, after, label, predicate):
        deadline = time.monotonic() + 80
        while time.monotonic() < deadline:
            for row in self.events(after):
                if predicate(row):
                    return row
            time.sleep(0.2)
        raise AssertionError(f"Timed out waiting for {label} after sequence {after}")

    def event(self, after, kind, matches=lambda _row: True):
        return self.wait_event(after, kind, lambda row: row["type"] == kind and matches(row))

    def send(self, name, message):
        return self.prae(name, "seat", "send", self.seat, "--message", message)["submissionId"]

    @staticmethod
    def turn_id(row):
        return row.get("turnId") or row["payload"].get("turnId")

    def terminal(self, started):
        return self.wait_event(started["seq"], "terminal of " + self.turn_id(started),
                               lambda row: row["type"] in TERMINALS
                               and self.turn_id(row) == self.turn_id(started))

    def start_turn(self, name, prompt):
        after = max((row["seq"] for row in self.events()), default=0)
        submission = self.send(name, prompt)
        return self.event(after, "turn.started", lambda row: row["payload"].get("inputId") == submission)

    def transcript(self, key):
        path = (Path(self.state["home"]) / "antigravity-cli/brain" / key
                / ".system_generated/logs/transcript_full.jsonl")
        with path.open() as contents:
            rows = [json.loads(line) for line in contents if line.endswith("\n")]
        return str(path), rows

    def starts(self):
        # Exercise the macOS /tmp alias as well as the physical workspace trust path.
        directory = Path(tempfile.mkdtemp(prefix="agy-acceptance-", dir="/tmp"))
        subprocess.run(["git", "init", "-q", directory], check=True)
        lane = "agy-gate-" + uuid4().hex[:10]
        self.seat = f"tabularasagem@agent-spaces:{lane}"
        self.state = {"seat": self.seat, "directory": str(directory)}
        self.write(self.state_path, self.state)
        summon = self.prae("summon", "seat", "summon", self.seat, "--no-viewer",
                           "--cwd", str(directory), "--project-root", str(directory))
        assert summon["transport"] == "hrcpty"
        self.state["runtime"] = summon["runtimeId"]
        self.write(self.state_path, self.state)
        ready = self.event(0, "invocation.ready")
        started = self.event(0, "invocation.started")
        home = next(arg.split("=", 1)[1] for arg in started["payload"]["args"]
                    if arg.startswith("--gemini_dir="))
        assert Path(home).parent.name == "antigravity-homes"
        assert (Path.home() / "praesidium/var").resolve() in Path(home).resolve().parents
        self.state["home"] = home
        self.write(self.state_path, self.state)
        screen = self.prae("screen", "runtime", "get", self.state["runtime"], "--screen")["screen"]
        assert "Antigravity CLI" in screen["text"] and screen["cursor"]["x"] == 2, screen
        assert any(line.startswith("> ") for line in screen["text"].splitlines()), screen
        assert "trust this workspace" not in screen["text"].lower(), screen
        log_path = PTY_LOGS / f"{self.state['runtime']}.log"
        log = log_path.read_text()
        clients = log.count("event client.attached")
        assert "spawned child pid" in log and clients == 0
        (self.gate_dir / "hrc-pty.log").write_text(log)
        return dict(ready=ready, home=home, screen=screen, runtime=self.state["runtime"],
                    hrcPtyLog=str(log_path), clientAttachCount=clients)

    def turn(self):
        marker = "ORBIT-" + uuid4().hex[:10].upper()
        filename = "antigravity-turn-proof.txt"
        prompt = f"Run exactly this shell command: printf %s {marker} > {filename}. Then answer exactly {marker}."
        model_turn = self.start_turn("send", prompt)
        done = self.terminal(model_turn)
        assert done["type"] == "turn.completed" and done["payload"]["finalOutput"] == marker, done
        rows = [model_turn, *self.events(model_turn["seq"])]
        expected = {"user.message", "turn.started", "tool.call.started", "tool.call.completed",
                    "assistant.message.completed", "usage.updated", "turn.completed"}
        evidence = {row["type"]: row for row in rows
                    if row["type"] in expected and self.turn_id(row) == self.turn_id(model_turn)}
        assert evidence.keys() == expected, sorted(evidence)
        assert evidence["user.message"]["payload"]["content"] == prompt
        call = evidence["tool.call.started"]["payload"]
        assert evidence["tool.call.completed"]["payload"]["toolCallId"] == call["toolCallId"]
        assert filename in call["input"]["CommandLine"]
        assert evidence["assistant.message.completed"]["payload"]["content"] == [
            {"type": "text", "text": marker}]
        path = Path(self.state["directory"]) / filename
        assert path.read_text() == marker
        hrc = self.prae("hrc-events", "seat", "history", self.seat, "--kinds", "events",
                        "--limit", "80")["events"]
        projected = next(row for row in hrc if row["eventKind"] == "turn.message"
                         and row["payload"]["message"] == {"content": marker, "role": "assistant"})
        self.state["marker"] = marker
        self.write(self.state_path, self.state)
        transcript, rows = self.transcript(model_turn["payload"]["sessionId"])
        source = [row for row in rows if marker in (row.get("content") or "")]
        assert any(row["type"] == "USER_INPUT" and row["source"] == "USER_EXPLICIT" for row in source)
        assert any(row["type"] == "PLANNER_RESPONSE" and row["content"] == marker for row in source)
        return dict(events=evidence, hrc=projected, file=str(path), content=marker,
                    transcript=transcript, transcriptRows=source)

    def steer_mail(self):
        started = self.start_turn("steer-base", SLOW + " Then answer BASE unless a later input requests another answer.")
        tool = self.event(started["seq"], "tool.call.started")
        marker = "STEER-" + uuid4().hex[:10].upper()
        submission = self.send("steer", f"After the tool finishes, answer exactly {marker}.")
        absorbed = self.event(tool["seq"], "submission.absorbed",
                              lambda row: row["payload"]["submissionId"] == submission)
        done = self.terminal(started)
        assert done["type"] == "turn.completed" and done["payload"]["finalOutput"] == marker, done
        assert self.turn_id(absorbed) == self.turn_id(started)
        tool_done = self.event(tool["seq"], "tool.call.completed",
                               lambda row: row["payload"]["toolCallId"] == tool["payload"]["toolCallId"])
        admitted = self.event(tool["seq"], "admission.admitted",
                              lambda row: row["payload"]["submissionId"] == submission)
        assert tool["seq"] < admitted["seq"] < tool_done["seq"]
        key = started["payload"]["sessionId"]
        transcript, rows = self.transcript(key)
        landing = next(row for row in rows if marker in (row.get("content") or "")
                       and row["type"] in {"USER_INPUT", "SYSTEM_MESSAGE"})

        mail_marker = "MAIL-STOP-" + uuid4().hex[:10].upper()
        mail_turn = self.start_turn("mail-base", SLOW + " Then answer MAIL-BASE.")
        self.event(mail_turn["seq"], "tool.call.started")
        send = self.prae("mail-send", "room", "say", self.seat, "--message",
            f"Acceptance probe {mail_marker}. First finish your answer with exactly MAIL-BASE and "
            "attempt to stop. Leave this envelope unanswered until a Stop hook says 'Turn finish paused'. "
            f"Once you see that system message, find this envelope with prae room mail find --to me, "
            f"reply with prae room say <its id> --to {self.reply_to} --note -m {mail_marker}, "
            f"and then answer exactly {mail_marker}.")
        envelope = send["envelopes"][0]["id"]
        completed = self.terminal(mail_turn)
        transcript, rows = self.transcript(key)
        stop = [row for row in rows if row["type"] == "SYSTEM_MESSAGE"
                and "Stop hook blocked termination: Turn finish paused:" in (row.get("content") or "")
                and mail_marker in row["content"]]
        mail = self.prae("mail-readback", "room", "mail", "get", envelope)
        self.write(self.gate_dir / "mail-evidence.json",
                   dict(stopRows=stop, terminal=completed, envelope=mail))
        assert stop, "the transcript did not record a mail Stop continuation"
        assert completed["type"] == "turn.completed" and completed["payload"]["finalOutput"] == mail_marker, completed
        assert mail["state"] == "acked" and mail["dischargedBy"], mail
        return dict(tool=tool, steerAdmitted=admitted, toolCompleted=tool_done, absorbed=absorbed,
                    steerTerminal=done, transcript=transcript, steerTranscriptRow=landing,
                    mailEnvelope=envelope, mailReply=mail["dischargedBy"], mailTerminal=completed,
                    stopTranscriptRows=stop)

    def interrupt(self):
        started = self.start_turn("send", "Run shell command sleep 20 now. Set the tool wait timeout to 30000 milliseconds.")
        tool = self.event(started["seq"], "tool.call.started")
        self.prae("interrupt", "seat", "interrupt", self.seat)
        interrupted = self.terminal(started)
        assert interrupted["type"] == "turn.interrupted", interrupted
        marker = "INTERRUPT-RECOVERED"
        resumed = self.start_turn("recovery-send", f"Do not use tools. Answer exactly {marker}.")
        completed = self.terminal(resumed)
        assert completed["type"] == "turn.completed" and completed["payload"]["finalOutput"] == marker, completed
        assert completed["invocationId"] == interrupted["invocationId"]
        return dict(tool=tool, interrupted=interrupted, nextTurn=completed)

    def resume(self):
        runtime = self.state["runtime"]
        continuation = self.event(0, "continuation.updated")["payload"]
        assert continuation["kind"] == "conversation" and continuation["provider"] == "google"
        key = continuation["key"]
        processes = {}
        for line in subprocess.check_output(["ps", "-axww", "-o", "pid=,ppid=,command="],
                                            text=True).splitlines():
            pid, parent, command = line.split(maxsplit=2)
            processes[int(pid)] = (int(parent), command.split())
        supervisors = {pid for pid, (_, argv) in processes.items()
                       if Path(argv[0]).name == "hrc-pty" and "--runtime-id" in argv
                       and argv[argv.index("--runtime-id") + 1:][:1] == [runtime]}
        children = [pid for pid, (parent, argv) in processes.items()
                    if parent in supervisors and Path(argv[0]).name in {"agy", "antigravity"}
                    and f"--gemini_dir={self.state['home']}" in argv]
        assert len(children) == 1, (runtime, self.state["home"], children)
        child = children[0]
        self.write(self.gate_dir / "child-exit.json",
                   dict(pid=child, parentPid=processes[child][0], signal="SIGTERM", runtime=runtime))
        os.kill(child, signal.SIGTERM)
        # An idle child exit is visible first in hrc-pty. HRC's five-minute
        # aging pass then settles the dead runtime and permits a successor.
        deadline = time.monotonic() + 330
        while True:
            retired = self.prae("predecessor", "runtime", "get", runtime)["hrc"]
            if retired["status"] in {"archived", "terminated", "exited", "failed", "stale"}:
                break
            assert time.monotonic() < deadline, retired["status"]
            time.sleep(3)
        assert retired["continuation"] == continuation
        exit_log = next(line for line in (PTY_LOGS / f"{runtime}.log").read_text().splitlines()
                        if "event child.exited" in line and f'"pid":{child},' in line)
        successor = self.prae("summon-resume", "seat", "summon", self.seat, "--no-viewer",
                              "--cwd", self.state["directory"], "--project-root", self.state["directory"],
                              "--continuation", "resume")
        assert successor["continuation"] == continuation, successor
        successor_runtime = successor["runtime"]["runtimeId"]
        assert successor_runtime != runtime
        self.state["runtime"] = successor_runtime
        self.write(self.state_path, self.state)
        start = self.event(0, "invocation.started")
        args = start["payload"]["args"]
        assert Path(start["payload"]["cwd"]).resolve() == Path(self.state["directory"]).resolve(), start
        assert args[args.index("--conversation") + 1] == key
        assert f"--gemini_dir={self.state['home']}" in args
        turn = self.start_turn("send", "Recall the exact ORBIT code from our first turn. Do not use tools or read files. Reply with only that code.")
        done = self.terminal(turn)
        assert done["type"] == "turn.completed" and done["payload"]["finalOutput"] == self.state["marker"], done
        resumed = self.event(0, "continuation.updated")
        assert resumed["payload"] == continuation, resumed
        transcript, rows = self.transcript(key)
        answer = [row for row in rows if row["type"] == "PLANNER_RESPONSE"
                  and row.get("content") == self.state["marker"]][-1]
        return dict(predecessor=runtime, predecessorStatus=retired["status"], childExit=exit_log, successor=successor,
                    start=start, continuation=resumed, terminal=done, transcript=transcript, answer=answer)

    def run(self, gate):
        self.gate_dir = self.out / f"{gate:02d}-{GATES[gate - 1]}"
        self.gate_dir.mkdir(parents=True, exist_ok=True)
        if gate != 1:
            self.state = json.loads(self.state_path.read_text())
            self.seat = self.state["seat"]
        gate_action = (self.starts, self.turn, self.steer_mail, self.interrupt, self.resume)[gate - 1]
        path = self.gate_dir / "result.json"
        try:
            evidence = gate_action()
        except Exception as error:
            self.write(path, {"pass": False, "error": str(error), "seat": self.seat})
            raise
        self.write(path, {"pass": True, "seat": self.seat, **evidence})
        print(f"PASS {path}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--gate", type=int, choices=range(1, 6))
    parser.add_argument("--reply-to", required=True, help="This prae caller's exact seat handle")
    args = parser.parse_args()
    acceptance = Acceptance(args.out.resolve(), args.reply_to)
    for gate in [args.gate] if args.gate else range(1, 6):
        acceptance.run(gate)
