#!/usr/bin/env python3
"""A minimal agents-io harness in Python (stdlib only).

Speaks the JSONL harness protocol on stdin/stdout (the `bridge` harness kind,
`@agents-io/harness-jsonl-bridge`): answers `probe` with its caps and static
declarations, opens sessions, and answers each turn with the text it was given.
`/compact` as a turn's one input (the command it declares) is answered as done.
stdout is the protocol channel; diagnostics go to stderr.
"""
import json
import sys
import time

V = 1
CAPS = {
    "steer": "none",
    "interrupt": True,
    "approvals": False,
    "questions": False,
    "tokenDeltas": False,
    "cancelQueued": False,
    "injectWithoutTurn": False,
    "resume": True,
    "switchModelMidSession": True,
    "switchProfileMidSession": True,
}
DECLARES = {"displayName": "Echo (Python)", "compact": {"command": "/compact"}}

sessions = {}  # sessionKey -> generation


def out(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def result(req_id, value=None, error=None):
    frame = {"v": V, "type": "result", "id": req_id, "ok": error is None}
    if error is None:
        frame["value"] = value
    else:
        frame["error"] = error
    out(frame)


def event(session_key, turn_id, body, audience="status"):
    out({
        "v": V,
        "type": "event",
        "sessionKey": session_key,
        "generation": sessions[session_key],
        "event": {
            "ts": int(time.time() * 1000),
            "turnId": turn_id,
            "level": "primary",
            "audience": audience,
            "durability": "durable",
            "body": body,
        },
    })


def text_of(inputs):
    return " ".join(c.get("text", "") for i in inputs for c in i["content"] if c["type"] == "text")


def on_start_turn(f):
    key, turn_id = f["sessionKey"], f["turnId"]
    if key not in sessions:
        return result(f["id"], error={"code": "unknown_session", "message": f"no open session {key}"})
    result(f["id"], None)
    ids = [i["inputId"] for i in f["inputs"]]
    route = f["inputs"][0].get("replyRoute") if f["inputs"] else None
    started = {"t": "turn.started", "turnId": turn_id, "inputIds": ids, "replyRoute": route}
    if "run" in f:
        started["run"] = f["run"]
    event(key, turn_id, started)
    text = text_of(f["inputs"])
    answer = "compacted" if text == DECLARES["compact"]["command"] else f"echo: {text}"
    event(key, turn_id, {"t": "text.snapshot", "text": answer, "final": True}, audience="answer")
    event(key, turn_id, {"t": "input.consumed", "inputIds": ids, "turnId": turn_id})
    event(key, turn_id, {"t": "turn.completed", "turnId": turn_id, "status": "completed"})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            f = json.loads(line)
        except ValueError:
            print(f"bad line from host: {line[:80]}", file=sys.stderr)
            continue
        t = f.get("type")
        if t == "probe":
            result(f["id"], {"version": "echo-py-1", "caps": CAPS, "declares": DECLARES, "methods": []})
        elif t == "open":
            sessions[f["sessionKey"]] = f["generation"]
            native = f.get("resume") or f"py-{f['sessionKey']}"
            result(f["id"], {"nativeId": native})
        elif t == "startTurn":
            on_start_turn(f)
        elif t == "steer":
            result(f["id"], "unsupported")
        elif t in ("interrupt", "respond"):
            result(f["id"], None)
        elif t == "close":
            sessions.pop(f["sessionKey"], None)
            result(f["id"], None)
        elif t == "shutdown":
            return
        elif "id" in f and t != "result":
            # Unknown requests are refused; unknown frames without an id are ignored.
            result(f["id"], error={"code": "unsupported", "message": f"echo harness has no {t}"})


if __name__ == "__main__":
    main()
