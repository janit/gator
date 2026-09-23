"""Backend health, and how long a required backend may be missing.

Health answers "can this backend take work right now". It never answers "may
this class run here" — that is eligibility, and an unhealthy 5090 makes a heavy
unit wait rather than making the 4090 acceptable. The distinction is the whole
point of the scheduler, so the two live in different modules and health is only
ever consulted after eligibility has already narrowed the field.
"""
import subprocess

STATES = ("healthy", "busy", "reserved", "unhealthy", "disabled")

# How long a heavy unit waits for a backend that is not merely busy but absent,
# before its status becomes an explicit block rather than a queue.
DEFAULT_TIMEOUT = 1800


def probe(backend, timeout=5):
    """True when the backend answers. A backend with no probe is assumed up.

    The command comes from a resources file that Bash has already trust-gated,
    the same gate `worker_cmd` and `verify` pass through. Nothing here widens
    that: an untrusted repository's health_cmd was never read.
    """
    command = (backend.health_cmd or "").strip()
    if not command:
        return True
    try:
        completed = subprocess.run(
            ["bash", "-c", command],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    return completed.returncode == 0


def expired(queued_at, now, timeout=DEFAULT_TIMEOUT):
    """Has a unit waited past the availability timeout for its backend?"""
    return (now - queued_at) > timeout


def state_of(config, ident, doc, healthy=True):
    """The single reported state for one backend, by the precedence in §12."""
    from .leases import active_counts

    if ident in set(doc.get("disabled", [])):
        return "disabled"
    if not healthy:
        return "unhealthy"
    backend = config.backends.get(ident)
    # A reservation binds only a backend configured to honour one, exactly as
    # policy.candidates() decides. Reporting it anywhere else would name a
    # reason that is not the reason, on a backend still taking work.
    if ident in set(doc.get("reservation", {})) and backend and backend.interactive_reservation:
        return "reserved"
    capacity = backend.capacity if backend else 0
    if active_counts(doc).get(ident, 0) >= capacity:
        return "busy"
    return "healthy"
