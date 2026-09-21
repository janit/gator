"""Test fixture: a stand-in classifier endpoint. Never used outside the tests.

    python3 classifier_stub.py <mode> <request-log>

Prints its port on the first line of stdout, then serves until killed. Every
request is appended to <request-log> as one JSON line, so a test can count the
calls and read what was sent.
"""
import json
import math
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE, LOG = sys.argv[1], sys.argv[2]


def scored(pairs):
    first = pairs[0]
    return {"choices": [{
        "message": {"role": "assistant", "content": first[0]},
        "logprobs": {"content": [{
            "token": first[0],
            "logprob": math.log(first[1]),
            "top_logprobs": [{"token": t, "logprob": math.log(p)} for t, p in pairs],
        }]},
    }]}


RESPONSES = {
    "standard": scored([("S", 0.90), (" S", 0.05), ("H", 0.05)]),
    "heavy": scored([("H", 0.97), ("S", 0.03)]),
    "borderline": scored([("S", 0.70), ("H", 0.30)]),
    "off_target": scored([("We", 0.90), ("S", 0.05), ("H", 0.05)]),
    "no_logprobs": {"choices": [{"message": {"role": "assistant", "content": "S"}}]},
}

# A well-formed scored response, written by hand as bytes because the huge
# integer literal below must survive round-tripping through json.loads() as an
# actual (non-float) Python int, which json.dumps(scored(...)) would not
# produce. -1 followed by 400 zeros overflows math.isfinite()'s int->float
# conversion, well within the 1 MB response cap.
BIGINT_LOGPROB = "-1" + "0" * 400
BIGINT_BODY = (
    '{"choices": [{"logprobs": {"content": [{"token": "H", "logprob": -0.1, '
    '"top_logprobs": [{"token": "H", "logprob": %s}, {"token": "S", "logprob": -0.1}]}]}}]}'
    % BIGINT_LOGPROB
).encode()

# Deeply nested but small (200 KB) JSON, well within the 1 MB cap, that blows
# Python's json module recursion limit.
NESTED_BODY = b"[" * 100000 + b"]" * 100000


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        with open(LOG, "a") as handle:
            handle.write(json.dumps({"path": self.path, "body": json.loads(raw or b"null")}) + "\n")
        if MODE == "timeout":
            time.sleep(10)
        if MODE == "garbage":
            payload = b"this is not json"
        elif MODE == "huge":
            payload = b"{" + b" " * (2 * 1024 * 1024) + b"}"
        elif MODE == "nested":
            payload = NESTED_BODY
        elif MODE == "bigint":
            payload = BIGINT_BODY
        else:
            payload = json.dumps(RESPONSES.get(MODE, RESPONSES["heavy"])).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client gave up, which is what the timeout mode is for

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
print(server.server_address[1], flush=True)
server.serve_forever()
