"""Rate limiting, budget and single-flight for `auto plan`.

`feed` has enforced a session budget, a cooldown and a concurrency ceiling
since the beginning; planning shipped with none, so an agent retrying on a
refusal could spend unbounded planner calls and unbounded CPU — the baseline
check runs the project's whole test suite. Planning is not a free dry run
(spec section 4), so it gets the same three limits.
"""
import json
import os
import tempfile
import time

from .repo import Refusal


def _state_path(store):
    return os.path.join(store, "auto", "state.json")


def _read(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except Exception:
        return {"plans": 0, "last": 0}


def _write(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, "w") as handle:
        json.dump(state, handle)
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def _limits(env):
    def number(name, default):
        try:
            return int(env.get(name, default))
        except ValueError:
            return int(default)

    return {
        "cooldown": number("GATOR_PLAN_COOLDOWN", 60),
        "max_plans": number("GATOR_MAX_PLANS", 20),
    }


class SingleFlight:
    """One planning run per repository at a time.

    Two concurrent invocations would otherwise each pay for a planner call and
    each run the baseline suite. O_EXCL is the whole mechanism; a stale lock is
    reclaimed after ten minutes rather than wedging the command forever.
    """

    STALE_AFTER = 600

    def __init__(self, store):
        self.path = os.path.join(store, "auto", "plan.lock")

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            age = time.time() - os.path.getmtime(self.path)
            if age < self.STALE_AFTER:
                raise Refusal(
                    "plan_in_flight",
                    f"another plan is already running here ({int(age)}s ago). "
                    "Wait for it rather than starting a second planner call.",
                )
            os.unlink(self.path)
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return self

    def __exit__(self, *exc):
        try:
            os.unlink(self.path)
        except OSError:
            pass
        return False


def check(store, env):
    """Refuse before the planner is called, never after paying for it."""
    limits = _limits(env)
    state = _read(_state_path(store))

    if state.get("plans", 0) >= limits["max_plans"]:
        raise Refusal(
            "plan_budget_spent",
            f"planning budget spent ({state['plans']}/{limits['max_plans']}). "
            "Raise GATOR_MAX_PLANS deliberately, or act on a plan you have.",
        )

    since = time.time() - state.get("last", 0)
    if state.get("last") and since < limits["cooldown"]:
        raise Refusal(
            "plan_cooldown",
            f"still {int(limits['cooldown'] - since)}s of cooldown left. "
            "Planning costs a model call and a full verifier run; it is not a "
            "free dry run.",
        )


def record(store, env):
    path = _state_path(store)
    state = _read(path)
    state["plans"] = state.get("plans", 0) + 1
    state["last"] = int(time.time())
    _write(path, state)


# ------------------------------------------------------------ baseline cache

def _baseline_path(store):
    return os.path.join(store, "auto", "baseline.json")


def cached_baseline(store, base_sha, command_sha256):
    """A green baseline for this exact commit and verifier need not be re-run."""
    try:
        with open(_baseline_path(store)) as handle:
            entry = json.load(handle)
    except Exception:
        return None
    if entry.get("base_sha") == base_sha and entry.get("command_sha256") == command_sha256:
        # Exactly the shape a fresh check returns. Whether this invocation
        # reused a cache is an implementation detail; if it leaked into the
        # plan body, two identical plans would hash differently and the
        # immutability contract in spec section 9.5 would break.
        return {"checked": True, "rc": entry.get("rc", 0)}
    return None


def remember_baseline(store, base_sha, command_sha256, result):
    _write(
        _baseline_path(store),
        {
            "base_sha": base_sha,
            "command_sha256": command_sha256,
            "rc": result.get("rc", 0),
            "at": int(time.time()),
        },
    )
