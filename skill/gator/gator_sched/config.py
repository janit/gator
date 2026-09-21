"""Resource configuration: backends, classes, and the role-to-class mapping.

Parsed here rather than in Bash because the keys are dotted. A shell
`grep -E "^backend.local-5090.endpoint"` treats every dot as "any character",
so a neighbouring key can answer for the one that was asked for. Bash still
decides *which* files may be read at all; that is the half carrying the trust
boundary, and it stays where the rest of the trust logic already lives.
"""
import re

# The eligibility sets that hold when no file says otherwise. `heavy` is the
# load-bearing one: the whole point of the scheduler is that this stays a
# single-element list unless an operator deliberately changes it (I1).
DEFAULT_CLASSES = {
    "standard": ["local-4090", "local-5090"],
    "heavy": ["local-5090"],
    "remote": ["fleet"],
}
DEFAULT_CLASS = "standard"

# A backend id and an endpoint are both substituted into a command string, so
# each is a name and not an expression — the rule check_model applies to a
# model reference, applied to the two values that join it in that string.
NAME_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
ENDPOINT_RE = re.compile(r"^[A-Za-z0-9._:/?=&%@~+-]*$")


class ConfigError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Backend:
    __slots__ = ("id", "endpoint", "capacity", "weight",
                 "interactive_reservation", "kind", "health_cmd")

    def __init__(self, ident):
        self.id = ident
        self.endpoint = ""
        self.capacity = 1
        self.weight = 1.0
        self.interactive_reservation = False
        self.kind = "local"
        self.health_cmd = ""


CLASSIFIER_FIELDS = ("endpoint", "model", "threshold", "timeout")


class ClassifierConfig:
    """Where to ask how hard a task is. Absent entirely means: do not ask."""

    __slots__ = ("endpoint", "model", "threshold", "timeout")

    def __init__(self):
        self.endpoint = ""
        self.model = ""
        # Demote to standard only when at least this sure. Above one half by
        # construction: at one half or below, demotion would be the default.
        self.threshold = 0.75
        self.timeout = 5


class ResourceConfig:
    def __init__(self):
        self.backends = {}
        self.classes = dict((name, list(ids)) for name, ids in DEFAULT_CLASSES.items())
        self.role_map = {}
        self.default_class = DEFAULT_CLASS
        # An operator who wrote `role.default` has made a statement, and a
        # classifier must never override one. The built-in default is not a
        # statement, so the two have to be distinguishable.
        self.default_explicit = False
        self.classifier_keys = {}
        self.classifier = None


def parse(text):
    """`key = value`, `#` comments, one layer of matching quotes — as roles."""
    pairs = {}
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            pairs[key] = value
    return pairs


def _truth(value):
    return value.strip().lower() in ("1", "true", "yes", "on")


def _backend(config, ident):
    if not NAME_RE.match(ident):
        raise ConfigError("bad_backend_id", "backend id is not a name: %r" % (ident,))
    if ident not in config.backends:
        config.backends[ident] = Backend(ident)
    return config.backends[ident]


def _apply_backend(config, ident, field, value):
    backend = _backend(config, ident)
    if field == "endpoint":
        if not ENDPOINT_RE.match(value):
            raise ConfigError("bad_endpoint", "endpoint is not a plain URL: %r" % (value,))
        backend.endpoint = value
    elif field == "capacity":
        backend.capacity = max(0, _int(value, field))
    elif field == "weight":
        backend.weight = _float(value, field)
    elif field == "interactive_reservation":
        backend.interactive_reservation = _truth(value)
    elif field == "kind":
        backend.kind = value
    elif field == "health_cmd":
        backend.health_cmd = value


def _int(value, field):
    try:
        return int(value)
    except ValueError:
        raise ConfigError("bad_number", "%s is not a number: %r" % (field, value))


def _float(value, field):
    try:
        return float(value)
    except ValueError:
        raise ConfigError("bad_number", "%s is not a number: %r" % (field, value))


def _apply(config, pairs, seen):
    """Apply one file's pairs. `seen` holds keys an earlier file already won."""
    for key, value in pairs.items():
        if key in seen:
            continue
        seen.add(key)
        parts = key.split(".")
        if parts[0] == "backend" and len(parts) >= 3:
            # The id may itself contain dots, so it is everything between the
            # literal "backend" and the final field name.
            _apply_backend(config, ".".join(parts[1:-1]), parts[-1], value)
        elif parts[0] == "class" and len(parts) == 3 and parts[2] == "eligible":
            config.classes[parts[1]] = [
                item.strip() for item in value.split(",") if item.strip()
            ]
        elif parts[0] == "role" and len(parts) == 2:
            if parts[1] == "default":
                config.default_class = value
                config.default_explicit = True
            else:
                config.role_map[parts[1]] = value
        elif parts[0] == "classifier" and len(parts) == 2:
            config.classifier_keys[parts[1]] = value
    return config


def _classifier(keys):
    """Validate the classifier keys as one unit, or return None when absent.

    Stricter than the rest of this file on purpose. A misspelt `threshold`
    silently falling back to a default, or an endpoint without a model silently
    disabling classification, would each change where work runs without saying
    so.
    """
    if not keys:
        return None
    unknown = sorted(set(keys) - set(CLASSIFIER_FIELDS))
    if unknown:
        raise ConfigError("bad_classifier", "unknown classifier key(s): %s" % ", ".join(unknown))
    if not keys.get("endpoint") or not keys.get("model"):
        raise ConfigError(
            "bad_classifier",
            "classifier.endpoint and classifier.model must both be set, or neither",
        )
    endpoint = keys["endpoint"]
    if not ENDPOINT_RE.match(endpoint) or not endpoint.startswith(("http://", "https://")):
        raise ConfigError("bad_endpoint", "classifier endpoint is not a plain URL: %r" % (endpoint,))
    if not NAME_RE.match(keys["model"]):
        raise ConfigError("bad_classifier", "classifier model is not a name: %r" % (keys["model"],))

    out = ClassifierConfig()
    out.endpoint = endpoint.rstrip("/")
    out.model = keys["model"]
    if "threshold" in keys:
        threshold = _float(keys["threshold"], "classifier.threshold")
        # Written as a positive range check so NaN, which fails every
        # comparison, is refused rather than accepted.
        if not 0.5 < threshold <= 1:
            raise ConfigError(
                "bad_threshold",
                "classifier.threshold must be above 0.5 and at most 1, got %r" % (threshold,),
            )
        out.threshold = threshold
    if "timeout" in keys:
        timeout = _int(keys["timeout"], "classifier.timeout")
        if not 1 <= timeout <= 60:
            raise ConfigError("bad_timeout", "classifier.timeout must be 1..60 seconds")
        out.timeout = timeout
    return out


def resolution_inputs(config):
    """What a recommended class depends on, for binding a plan to it.

    Backends and eligibility sets are deliberately absent: dispatch checks
    those live, so a plan does not need to go stale when they change.
    """
    out = {"role_map": dict(sorted(config.role_map.items()))}
    if config.default_explicit:
        out["default_class"] = config.default_class
    if config.classifier is not None:
        out["classifier"] = {
            "endpoint": config.classifier.endpoint,
            "model": config.classifier.model,
            "threshold": config.classifier.threshold,
        }
    return out


def load(paths):
    """Merge resource files, highest precedence first. Earlier wins per key.

    A file that cannot be read is skipped rather than fatal: the caller passes a
    fixed search path, and most of it will not exist on most machines.
    """
    config = ResourceConfig()
    seen = set()
    for path in paths:
        try:
            with open(path) as handle:
                text = handle.read()
        except OSError:
            continue
        _apply(config, parse(text), seen)
    # Every named backend exists as an object, so policy never has to ask
    # whether a backend it was told about is missing.
    for name in config.classes:
        for ident in config.classes[name]:
            _backend(config, ident)
    config.classifier = _classifier(config.classifier_keys)
    return config
