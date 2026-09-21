"""Policy: which backends a unit may use, and which of those it should use.

`eligible` is a constraint and `score` is a preference. They are separate
functions on purpose, and `candidates` applies them in an order that cannot be
reversed: eligibility first, so nothing downstream can re-admit a backend the
class forbids. That ordering is the whole heavy guarantee. Everything else here
— weights, penalties, tie-breaks — only ever chooses among what eligibility has
already allowed.

Nothing in this module reads a file, a clock or an environment variable. The
caller supplies the state; these functions decide.
"""

# Calibration hints, not guarantees. A weight scales a backend's assumed decode
# rate so an operator can say "the 5090 is about 1.6x the 4090" without
# measuring tokens per second. Eligibility remains authoritative above all of it.
DECODE_RATE = 1000.0
ACTIVE_PENALTY = 60.0


class BackendState:
    """What the lease store currently knows about one backend."""

    __slots__ = ("active", "healthy", "disabled", "reserved")

    def __init__(self, active=0, healthy=True, disabled=False, reserved=False):
        self.active = active
        self.healthy = healthy
        self.disabled = disabled
        self.reserved = reserved


def resolve_class(config, role, override=None):
    """Precedence: explicit override, then the role mapping, then the default."""
    if override:
        return override
    return config.role_map.get(role) or config.default_class


def resolve(config, role, override=None, ask=None):
    """Which class, and who decided it.

    Every operator statement outranks the model: an override, a role mapping,
    and an explicit `role.default`. The classifier answers only when none of
    them did, and `ask` — supplied by the caller, because this module does no
    I/O — is called at that point and nowhere else.
    """
    if override:
        return {"class": override, "source": "override"}
    mapped = config.role_map.get(role)
    if mapped:
        return {"class": mapped, "source": "role"}
    if config.default_explicit:
        return {"class": config.default_class, "source": "role_default"}
    if config.classifier is not None:
        if ask is None:
            raise ValueError("a classifier is configured but the caller cannot ask it")
        return dict(ask(), source="classifier")
    return {"class": config.default_class, "source": "default"}


def eligible(config, resource_class):
    """The hard set for a class.

    An unrecognised class is empty, never permissive. Class names reach here
    from configuration and from a `--resource` flag, so "I do not know what that
    is" must mean "nothing", not "anything".
    """
    return list(config.classes.get(resource_class, []))


def candidates(config, resource_class, state):
    """Eligible, then healthy, then free, then unreserved. The order is the contract."""
    out = []
    for ident in eligible(config, resource_class):
        backend = config.backends.get(ident)
        if backend is None:
            continue
        info = state.get(ident) or BackendState()
        if info.disabled or not info.healthy:
            continue
        if backend.capacity <= info.active:
            continue
        # A reservation withholds capacity from Gator on a backend someone else
        # is interactively using. It only ever applies to backends configured to
        # honour one, and it can never affect a class that was not eligible for
        # that backend in the first place.
        if backend.interactive_reservation and info.reserved:
            continue
        out.append(ident)
    return out


def score(config, ident, state, work_tokens=0):
    """Expected seconds until this backend finishes the unit. Lower is sooner."""
    backend = config.backends[ident]
    info = state.get(ident) or BackendState()
    rate = backend.weight * DECODE_RATE
    expected = (work_tokens / rate) if rate > 0 else float("inf")
    return expected + info.active * ACTIVE_PENALTY


def choose(config, resource_class, state, work_tokens=0):
    """Pick a backend, or explain why none is runnable right now.

    Returns `(backend_id_or_None, reason)`. The reason is what the unit's record
    and `gator status` report, so it distinguishes the two ways of being
    unrunnable: a class with one eligible backend is *waiting for that backend*,
    which is a queue; a class whose several backends are all busy is merely
    unrunnable for now.
    """
    allowed = eligible(config, resource_class)
    if not allowed:
        return None, "no_eligible_backend"

    runnable = candidates(config, resource_class, state)
    if not runnable:
        if len(allowed) == 1:
            return None, "waiting_for_required_backend"
        return None, "no_eligible_backend"

    if len(runnable) == 1:
        reason = ("required_backend_available" if len(allowed) == 1
                  else "only_eligible_backend")
        return runnable[0], reason

    # Ties break by name so the same state always produces the same dispatch.
    # A scheduler that picks differently on identical input cannot be debugged.
    best = min(runnable, key=lambda i: (score(config, i, state, work_tokens), i))
    return best, "lower_expected_completion_time"
