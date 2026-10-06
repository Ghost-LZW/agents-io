#!/usr/bin/env python3
"""A minimal agents-io channel adapter in Python (stdlib only).

Speaks the JSONL channel protocol on stdin/stdout: answers `hello`, emits one
inbound message once the host has said hello, and records every `send`.
stdout is the protocol channel; diagnostics go to stderr.

Set ECHO_RECORD=<path> to also append each recorded send to that file as JSONL.
"""
import json
import os
import sys

V = 1
CAPS = {
    "text": {"maxChars": 2000, "markdown": "none"},
    "edit": False,
    "buttons": False,
    "media": [],
    "voiceOut": "none",
    "threads": False,
    "approvals": "none",
    "defaultTier": "card",
    "evidence": ["none"],
    "declaresSender": False,
}

sent = {}  # operationId -> providerMessageId (idempotency)


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


def on_hello(frame):
    account = frame["account"]
    result(frame["id"], {"adapterId": "echo-py", "caps": CAPS, "methods": []})
    out({
        "v": V,
        "type": "inbound",
        "id": "echo-in-1",
        "envelope": {
            "v": V,
            "id": "echo-msg-1",
            "channel": "echo-py",
            "account": account,
            "conversation": {"id": "room", "kind": "dm"},
            "sender": {"channelUserId": "python-user", "evidence": "none"},
            "content": [{"type": "text", "text": "hello from python"}],
            "replyRoute": {"channel": "echo-py", "account": account, "conversationId": "room"},
        },
    })


def on_send(frame):
    op_id = frame["op"]["operationId"]
    if op_id not in sent:
        sent[op_id] = "py-%d" % (len(sent) + 1)
        record = {"providerMessageId": sent[op_id], "text": frame["msg"]["text"], "operationId": op_id}
        path = os.environ.get("ECHO_RECORD")
        if path:
            with open(path, "a") as fh:
                fh.write(json.dumps(record) + "\n")
    result(frame["id"], {"providerMessageId": sent[op_id]})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except ValueError:
            print("bad line: %s" % line[:100], file=sys.stderr)
            continue
        kind = frame.get("type")
        if kind == "hello":
            on_hello(frame)
        elif kind == "send":
            on_send(frame)
        elif kind == "result":
            print("host answered %s ok=%s" % (frame.get("id"), frame.get("ok")), file=sys.stderr)
        elif kind == "shutdown":
            return
        elif "id" in frame:
            result(frame["id"], error={"code": "unsupported", "message": "no such method: %s" % kind})
        # unknown frames without an id are ignored


if __name__ == "__main__":
    main()
