"""Durable admission state, shared by processes that never meet.

A gator unit is detached: the shell that admitted it has usually exited before
the worker has written its first token. So "is this backend free?" cannot be a
variable in one process — it has to be state on disk that concurrent, unrelated
invocations contend for correctly.

The contention primitive is `fcntl.flock` on a dedicated lock file, held across
a read-modify-write of one small JSON document. The document itself is replaced
atomically, so a crash mid-write leaves the previous version rather than a
truncated one. That is the same shape `gator`'s budget state and
`gator-record.py` already use; this adds the mutual exclusion they do not need
and a lease cannot do without.

Two failure modes get explicit handling:

  * a worker that dies without releasing — reaped by process liveness, so a
    crashed unit cannot strand a GPU forever;
  * a document that will not parse — raised, never rounded down to "no leases
    held", because guessing there means two workers on one GPU.
"""
import errno
import fcntl
import json
import os
import tempfile
import time

from . import SCHEMA_VERSION
from .policy import BackendState

# A lease is written before the worker exists, because the slot has to be
# reserved before anything is spawned into it. Until `adopt` records the real
# pid such a lease has none, and is protected by age alone. The window is the
# time between `gator`'s dispatch and `gator-unit`'s first line.
LAUNCH_GRACE = 120


class StateError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def store_dir(store):
    """`<store>/sched`, created private. Other users' units are not our business."""
    path = os.path.join(store, "sched")
    os.makedirs(path, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    return path


def _doc_path(store):
    return os.path.join(store_dir(store), "leases.json")


def _lock_path(store):
    return os.path.join(store_dir(store), "lock")


def _empty():
    return {
        "schema_version": SCHEMA_VERSION,
        "leases": {},
        "reservation": {},
        "disabled": [],
    }


def _load(store):
    try:
        with open(_doc_path(store)) as handle:
            doc = json.load(handle)
    except FileNotFoundError:
        return _empty()
    except (OSError, ValueError) as exc:
        # Fail closed. "I cannot read the leases" must never be treated as
        # "there are no leases" — that is how two workers land on one GPU.
        raise StateError("corrupt_state", "scheduler state is unreadable: %s" % (exc,))
    if not isinstance(doc, dict):
        raise StateError("corrupt_state", "scheduler state is not an object")
    version = doc.get("schema_version")
    if version != SCHEMA_VERSION:
        raise StateError(
            "schema_mismatch",
            "scheduler state has schema_version %r, this gator speaks %d"
            % (version, SCHEMA_VERSION),
        )
    for key, default in (("leases", {}), ("reservation", {}), ("disabled", [])):
        doc.setdefault(key, default)
    return doc


def _save(store, doc):
    path = _doc_path(store)
    directory = os.path.dirname(path)
    fd, temp = tempfile.mkstemp(dir=directory)
    with os.fdopen(fd, "w") as handle:
        json.dump(doc, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def _alive(pid):
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Someone else's process with that pid. It is not our unit, but it is
        # alive, and killing the lease would be the more dangerous guess.
        return True
    except OSError as exc:
        return exc.errno != errno.ESRCH
    return True


def reap(doc, now=None):
    """Drop leases whose worker is gone. Returns the slugs dropped."""
    now = time.time() if now is None else now
    dropped = []
    for slug in list(doc["leases"]):
        lease = doc["leases"][slug]
        pid = int(lease.get("pid", 0))
        if pid > 0:
            if not _alive(pid):
                dropped.append(slug)
            continue
        # Not yet adopted: the launch is either in flight or never happened.
        if now - float(lease.get("started", 0)) > LAUNCH_GRACE:
            dropped.append(slug)
    for slug in dropped:
        doc["leases"].pop(slug, None)
    return dropped


def with_lock(store, fn):
    """Run `fn(doc)` under an exclusive lock; write back if it returns True."""
    store_dir(store)
    with open(_lock_path(store), "a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            doc = _load(store)
            changed = reap(doc)
            result = fn(doc)
            if result is True or changed:
                _save(store, doc)
            return result
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def read(store):
    """The current document, stale leases already reaped."""
    holder = {}

    def capture(doc):
        holder["doc"] = doc
        return None

    with_lock(store, capture)
    return holder["doc"]


def active_counts(doc):
    counts = {}
    for lease in doc["leases"].values():
        backend = lease.get("backend")
        counts[backend] = counts.get(backend, 0) + 1
    return counts


def acquire(store, slug, backend, pid, meta=None, capacity=1):
    """Take a slot on `backend` for `slug`, if one is free. Atomic."""

    def attempt(doc):
        if slug in doc["leases"]:
            return False
        if active_counts(doc).get(backend, 0) >= capacity:
            return False
        lease = {
            "slug": slug,
            "backend": backend,
            "pid": int(pid),
            "pgid": int(pid),
            "started": time.time(),
        }
        lease.update(meta or {})
        doc["leases"][slug] = lease
        return True

    return with_lock(store, attempt)


def adopt(store, slug, pid):
    """Record the worker's real pid, once it exists, so liveness can be checked."""

    def attempt(doc):
        lease = doc["leases"].get(slug)
        if lease is None:
            return False
        lease["pid"] = int(pid)
        try:
            lease["pgid"] = os.getpgid(int(pid))
        except OSError:
            lease["pgid"] = int(pid)
        return True

    return with_lock(store, attempt)


def release(store, slug):
    def attempt(doc):
        return doc["leases"].pop(slug, None) is not None

    return with_lock(store, attempt)


def set_reservation(store, backend, active, source="unknown"):
    """Withhold a backend from Gator while something else is using it.

    The signal is explicit state, written by whoever knows — a chat router, or
    an operator running `gator sched reserve`. It is deliberately not inferred
    from instantaneous GPU utilisation, which cannot tell a busy interactive
    session from a busy Gator unit.
    """

    def attempt(doc):
        if active:
            doc["reservation"][backend] = {"source": source, "since": time.time()}
        else:
            doc["reservation"].pop(backend, None)
        return True

    return with_lock(store, attempt)


def set_disabled(store, backend, disabled):
    def attempt(doc):
        current = set(doc["disabled"])
        if disabled:
            current.add(backend)
        else:
            current.discard(backend)
        doc["disabled"] = sorted(current)
        return True

    return with_lock(store, attempt)


def backend_states(store, config, probe_health=False, doc=None):
    """Turn durable state into the per-backend view `policy` consumes."""
    from .health import probe

    doc = read(store) if doc is None else doc
    counts = active_counts(doc)
    disabled = set(doc["disabled"])
    reserved = set(doc["reservation"])
    states = {}
    for ident, backend in config.backends.items():
        states[ident] = BackendState(
            active=counts.get(ident, 0),
            healthy=(probe(backend) if probe_health else True),
            disabled=ident in disabled,
            reserved=ident in reserved,
        )
    return states
