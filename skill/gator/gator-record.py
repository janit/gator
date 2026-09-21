#!/usr/bin/env python3
"""gator-record — compose and read one unit's structured record.

Every value arrives as an argument. Nothing here is ever built by interpolating
shell variables into source, so a repository path is data and not code.
"""
import glob
import json
import os
import sys
import tempfile

SCHEMA_VERSION = 1


def outcome(rec):
    """The single authoritative outcome, by the precedence in spec section 7.

    The order is the contract: a failure cause outranks the absence of output,
    so a worker that died without committing is reported as having died, not as
    having produced nothing. That was the reproduced finding in section 2.
    """
    w = rec.get("worker", {})
    v = rec.get("verify", {})
    r = rec.get("result", {})
    if w.get("launch_error"):
        return "launch_error"
    if w.get("rc") == 124:
        return "timeout"
    if w.get("rc", 0) != 0:
        return "failed"
    if rec.get("scope", {}).get("violations"):
        return "out_of_scope"
    if v.get("configured") and v.get("rc", 0) != 0:
        return "unverified"
    if not r.get("committed") or not r.get("ahead", 0):
        return "empty"
    return "ready"


# Types are declared, never guessed. A verifier whose command is literally
# "true" must stay the string "true", and a title of "0" must stay a string.
BOOL_KEYS = frozenset({
    "worker.launch_error",
    "result.committed",
    "verify.configured",
    "baseline.checked",
})
INT_KEYS = frozenset({
    "worker.rc",
    "worker.elapsed",
    "result.ahead",
    "verify.rc",
    "verify.elapsed",
    "launched_at",
    "baseline.rc",
})


def coerce(key, text):
    if key in BOOL_KEYS:
        return text == "true"
    if key in INT_KEYS:
        try:
            return int(text)
        except ValueError:
            return -1
    return text


def assign(rec, dotted, value):
    parts = dotted.split(".")
    node = rec
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value


def load(path):
    with open(path) as handle:
        return json.load(handle)


def atomic_write(path, rec):
    directory = os.path.dirname(path) or "."
    fd, temp = tempfile.mkstemp(dir=directory)
    with os.fdopen(fd, "w") as handle:
        json.dump(rec, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temp, path)


def main(argv):
    if not argv:
        print("usage: gator-record write|merge|get|outcome|collect ...", file=sys.stderr)
        return 2
    verb, args = argv[0], argv[1:]

    if verb == "write":
        path, pairs = args[0], args[1:]
        # Create or merge. `gator` writes launch intent before spawning and
        # `gator-unit` writes the completion facts into the same record.
        try:
            rec = load(path)
        except Exception:
            rec = {}
        rec["schema_version"] = SCHEMA_VERSION
        for pair in pairs:
            key, _, value = pair.partition("=")
            assign(rec, key, coerce(key, value))
        rec["outcome"] = outcome(rec)
        atomic_write(path, rec)
        return 0

    if verb == "merge":
        path, key, blob = args[0], args[1], args[2]
        try:
            rec = load(path)
        except Exception:
            rec = {}
        rec["schema_version"] = SCHEMA_VERSION
        try:
            rec[key] = json.loads(blob)
        except ValueError:
            rec[key] = {"checked": False, "violations": []}
        rec["outcome"] = outcome(rec)
        atomic_write(path, rec)
        return 0

    if verb == "get":
        path, dotted, default = args[0], args[1], args[2]
        try:
            node = load(path)
            for part in dotted.split("."):
                node = node[part]
        except Exception:
            print(default)
            return 0
        # Booleans print as JSON's true/false, not Python's True/False: shell
        # callers compare against the lowercase forms. Strings stay unquoted.
        if isinstance(node, bool):
            print("true" if node else "false")
        elif isinstance(node, (dict, list)):
            print(json.dumps(node))
        else:
            print(node)
        return 0

    if verb == "outcome":
        try:
            print(outcome(load(args[0])))
        except Exception:
            print("launch_error")
        return 0

    if verb == "collect":
        store = args[0]
        units = []
        for path in sorted(glob.glob(os.path.join(store, "*.record.json"))):
            try:
                rec = load(path)
            except Exception:
                continue
            rec["outcome"] = outcome(rec)
            units.append(rec)
        json.dump({"schema_version": SCHEMA_VERSION, "units": units}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    print(f"unknown verb: {verb}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
