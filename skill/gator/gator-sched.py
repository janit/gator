#!/usr/bin/env python3
"""gator-sched — decide where a unit may run, and hold the slot while it runs.

Every value arrives as an argument, as in gator-record.py. Nothing here is ever
built by interpolating a shell variable into source, so a repository path, a
backend id and an endpoint are all data and never code.

Exit codes follow the house contract:

    0   a backend was granted (dispatch) or the read succeeded
    2   invalid input, unreadable state, or a policy refusal
    3   nothing runnable right now — the caller should queue

Three is the interesting one. It is not an error: a heavy unit arriving while
the 5090 is busy is the system working correctly, and the caller's job is to
wait rather than to look elsewhere.
"""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

from gator_sched import SCHEMA_VERSION  # noqa: E402
from gator_sched import leases  # noqa: E402
from gator_sched import classify  # noqa: E402
from gator_sched.config import ConfigError, load  # noqa: E402
from gator_sched.health import DEFAULT_TIMEOUT, expired, probe, state_of  # noqa: E402
from gator_sched.policy import choose, eligible, resolve, resolve_class  # noqa: E402


def parse_args(argv):
    """A flat --flag value parser. Repeated --config accumulates, in order."""
    verb = argv[0] if argv else ""
    opts = {"config": [], "field": []}
    rest = argv[1:]
    index = 0
    while index < len(rest):
        token = rest[index]
        if not token.startswith("--"):
            raise ValueError("unexpected argument: %s" % token)
        name = token[2:]
        if name in ("on", "off", "probe", "task-stdin", "queued"):
            opts[name] = True
            index += 1
            continue
        if index + 1 >= len(rest):
            raise ValueError("--%s needs a value" % name)
        value = rest[index + 1]
        if name in ("config", "field"):
            opts[name].append(value)
        else:
            opts[name] = value
        index += 2
    return verb, opts


def need(opts, name):
    if name not in opts:
        raise ValueError("--%s is required" % name)
    return opts[name]


def emit(pairs):
    for key, value in pairs:
        print("%s=%s" % (key, value))


def cmd_resolve(opts):
    """Decide the class once, before anything is created or locked.

    The task arrives on stdin, not in argv: Linux caps a single argument at
    128 KB, and a task fed from a file can be longer than that. It is read
    first, before anything that can fail, so the feeding shell never meets a
    closed pipe.
    """
    task = ""
    if opts.get("task-stdin"):
        task = sys.stdin.buffer.read().decode("utf-8", "replace")
    config = load(opts["config"])
    title = opts.get("title", "")
    scope = opts.get("scope", "")

    def ask():
        return classify.classify(config.classifier, title, scope, task)

    verdict = resolve(config, need(opts, "role"), opts.get("override"), ask=ask)
    resource = verdict["class"]
    emit([
        ("resource", resource),
        ("eligible", ",".join(eligible(config, resource))),
        ("source", verdict["source"]),
        ("classifier", classify.describe(verdict) if verdict["source"] == "classifier" else ""),
    ])
    return 0


# A backend in one of these states is not merely busy: nothing it is running will
# ever finish and hand the slot on. A unit waiting on it past the availability
# timeout is told so, rather than left looking like an ordinary queue.
ABSENT = ("unhealthy", "disabled")


def availability_timeout():
    raw = os.environ.get("GATOR_BACKEND_TIMEOUT", "")
    if not raw:
        return DEFAULT_TIMEOUT
    try:
        return int(raw)
    except ValueError:
        raise ValueError("GATOR_BACKEND_TIMEOUT is not a whole number of seconds: %r" % raw)


def _note_absence(store, slug, state, reason):
    """Track how long a queued unit's required backend has been absent.

    Returns the reason to report, and whether it changed. Called under the lease
    lock, and only for a unit that has no lease: a unit another drain has just
    dispatched must not have its queue entry written back into existence.
    Reporting is all this does. A blocked unit stays queued for the same backend.
    """
    path = _queue_path(store, slug)
    try:
        with open(path) as handle:
            entry = json.load(handle)
    except (OSError, ValueError):
        return reason, False
    before = entry.get("reason", "")
    now = time.time()
    if state in ABSENT:
        since = float(entry.get("absent_since") or now)
        entry["absent_since"] = since
        if expired(since, now, availability_timeout()):
            reason = "blocked_backend"
    else:
        entry.pop("absent_since", None)
    entry["reason"] = reason
    entry["required_state"] = state
    _write_entry(path, entry)
    return reason, reason != before


def cmd_dispatch(opts):
    store = need(opts, "store")
    slug = need(opts, "slug")
    config = load(opts["config"])
    resource = resolve_class(config, need(opts, "role"), opts.get("override"))
    allowed = eligible(config, resource)
    tokens = int(opts.get("tokens", 0) or 0)
    want_probe = bool(opts.get("probe"))

    # One lock covers the decision and the lease it grants. Choosing outside the
    # lock and acquiring inside it would let two units agree on the same free
    # backend and then both take it.
    outcome = {}

    def attempt(doc):
        states = leases.backend_states(store, config, probe_health=want_probe, doc=doc)
        backend, reason = choose(config, resource, states, work_tokens=tokens)
        outcome["reason"] = reason
        outcome["backend"] = backend
        if backend is None:
            if len(allowed) == 1 and allowed[0] in config.backends:
                state = state_of(config, allowed[0], doc,
                                 healthy=states[allowed[0]].healthy)
                outcome["required_state"] = state
                if opts.get("queued") and slug not in doc["leases"]:
                    outcome["reason"], outcome["changed"] = _note_absence(
                        store, slug, state, reason)
            return False
        if slug in doc["leases"]:
            outcome["reason"] = "already_leased"
            return False
        capacity = config.backends[backend].capacity
        if leases.active_counts(doc).get(backend, 0) >= capacity:
            outcome["reason"] = "no_eligible_backend"
            outcome["backend"] = None
            return False
        doc["leases"][slug] = {
            "slug": slug,
            "backend": backend,
            "pid": int(opts.get("pid", 0) or 0),
            "pgid": int(opts.get("pid", 0) or 0),
            "started": time.time(),
            "resource": resource,
        }
        return True

    granted = leases.with_lock(store, attempt)
    if not granted:
        pairs = [("reason", outcome.get("reason", "no_eligible_backend"))]
        if len(allowed) == 1:
            pairs.append(("required_backend", allowed[0]))
        if "required_state" in outcome:
            pairs.append(("required_state", outcome["required_state"]))
        if outcome.get("changed"):
            pairs.append(("changed", "1"))
        emit(pairs)
        return 3

    backend = outcome["backend"]
    emit([
        ("backend", backend),
        ("endpoint", config.backends[backend].endpoint),
        ("resource", resource),
        ("eligible", ",".join(allowed)),
        ("reason", outcome["reason"]),
    ])
    return 0


def _queue_path(store, slug):
    return os.path.join(store, "%s.queued.json" % slug)


def cmd_enqueue(opts):
    """Record everything a later dispatch needs to launch this unit.

    A queued unit already owns its worktree — it was created at feed time, so
    the unit still chews the tree its feeder saw. Only the launch is deferred.
    """
    store = need(opts, "store")
    slug = need(opts, "slug")
    entry = {"slug": slug, "queued_at": time.time()}
    for pair in opts.get("field", []):
        key, _, value = pair.partition("=")
        entry[key] = value
    # A backend already absent at feed time has been absent at least since now.
    if entry.get("required_state") in ABSENT:
        entry["absent_since"] = entry["queued_at"]
    _write_entry(_queue_path(store, slug), entry)
    return 0


def _write_entry(path, entry):
    fd, temp = tempfile.mkstemp(dir=os.path.dirname(path) or ".")
    with os.fdopen(fd, "w") as handle:
        json.dump(entry, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def cmd_queue(opts):
    """Print queued slugs in dispatch order, one per line.

    Section 10's ordering: a unit whose class has exactly one eligible backend
    goes first, because it is the one that can be starved — every other class
    has somewhere else to land. Within a group, oldest first.
    """
    store = need(opts, "store")
    config = load(opts["config"])
    entries = []
    for name in sorted(os.listdir(store)) if os.path.isdir(store) else []:
        if not name.endswith(".queued.json"):
            continue
        try:
            with open(os.path.join(store, name)) as handle:
                entry = json.load(handle)
        except (OSError, ValueError):
            continue
        resource = entry.get("resource") or config.default_class
        strict = 0 if len(eligible(config, resource)) <= 1 else 1
        entries.append((strict, float(entry.get("queued_at", 0)), entry.get("slug", "")))
    for _strict, _when, slug in sorted(entries):
        if slug:
            print(slug)
    return 0


def cmd_adopt(opts):
    leases.adopt(need(opts, "store"), need(opts, "slug"), int(need(opts, "pid")))
    return 0


def cmd_release(opts):
    leases.release(need(opts, "store"), need(opts, "slug"))
    return 0


def cmd_reserve(opts):
    if opts.get("on") and opts.get("off"):
        raise ValueError("--on and --off are exclusive")
    leases.set_reservation(
        need(opts, "store"),
        need(opts, "backend"),
        bool(opts.get("on")),
        opts.get("source", "cli"),
    )
    return 0


def cmd_disable(opts):
    leases.set_disabled(need(opts, "store"), need(opts, "backend"), bool(opts.get("on")))
    return 0


def cmd_status(opts):
    store = need(opts, "store")
    config = load(opts["config"])
    doc = leases.read(store)
    want_probe = bool(opts.get("probe"))
    counts = leases.active_counts(doc)
    backends = {}
    for ident, backend in sorted(config.backends.items()):
        healthy = probe(backend) if want_probe else True
        backends[ident] = {
            "state": state_of(config, ident, doc, healthy=healthy),
            "active": counts.get(ident, 0),
            "capacity": backend.capacity,
            "weight": backend.weight,
            "endpoint": backend.endpoint,
            "reserved": ident in doc.get("reservation", {}),
            "disabled": ident in set(doc.get("disabled", [])),
        }
    json.dump({
        "schema_version": SCHEMA_VERSION,
        "backends": backends,
        "classes": config.classes,
        "leases": doc["leases"],
        "availability_timeout": availability_timeout(),
    }, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


VERBS = {
    "resolve": cmd_resolve,
    "enqueue": cmd_enqueue,
    "queue": cmd_queue,
    "dispatch": cmd_dispatch,
    "adopt": cmd_adopt,
    "release": cmd_release,
    "reserve": cmd_reserve,
    "disable": cmd_disable,
    "status": cmd_status,
}


def main(argv):
    try:
        verb, opts = parse_args(argv)
    except ValueError as exc:
        print("refused: %s" % exc, file=sys.stderr)
        return 2
    handler = VERBS.get(verb)
    if handler is None:
        print("usage: gator-sched %s ..." % "|".join(sorted(VERBS)), file=sys.stderr)
        return 2
    try:
        return handler(opts)
    except (ConfigError, leases.StateError) as exc:
        print("refused: %s: %s" % (exc.code, exc), file=sys.stderr)
        return 2
    except ValueError as exc:
        print("refused: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
