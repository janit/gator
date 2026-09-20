#!/usr/bin/env python3
"""gator auto — recommendation-only task selection.

`plan` reads one committed source, asks a tool-less planner to propose bounded
candidates, validates and ranks them in code, and writes an immutable manifest
bound to this repository, its HEAD, the source blob and the policy. It never
starts a worker. Execution (`run`, `accept`) is a later step and refuses here.

Exit codes, spec section 4:
  0  success, including a valid no-candidate plan
  2  invalid input or policy refusal
  3  a terminal unsuccessful run
  4  a wait deadline while work is still active
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

from gator_auto import SCHEMA_VERSION  # noqa: E402
from gator_auto.repo import Refusal  # noqa: E402

# Verbs the specification defines but this step does not implement. Naming them
# explicitly beats an "unknown verb" message that reads like a typo.
DEFERRED = {
    "run": "auto run lands with execution hardening (spec section 10, step 3)",
    "wait": "auto wait lands with execution hardening (spec section 10, step 3)",
    "status": "auto status lands with execution hardening (spec section 10, step 3)",
    "resume": "auto resume lands with execution hardening (spec section 10, step 3)",
    "accept": "auto accept lands with exact-candidate acceptance (spec section 10, step 4)",
}

USAGE = """gator auto — recommendation-only task selection

  gator auto plan  --from <committed file> [--json] [--no-baseline]
  gator auto show  --plan <plan-id> [--json]
  gator auto plans [--json]

`plan` costs one bounded planner call and writes local plan metadata. It is not
a free dry run, and it never starts a worker."""


def fail(code, message, as_json):
    if as_json:
        json.dump(
            {"schema_version": SCHEMA_VERSION, "error": {"code": code, "message": message}},
            sys.stdout,
            indent=2,
        )
        sys.stdout.write("\n")
    else:
        print(f"refused: {message}  [{code}]", file=sys.stderr)
    return 2


def parse(argv):
    opts = {"repo": None, "store": None, "verb": None, "from": None, "plan": None,
            "json": False, "no_baseline": False}
    rest = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--repo":
            opts["repo"] = argv[i + 1]; i += 2
        elif a == "--store":
            opts["store"] = argv[i + 1]; i += 2
        elif a == "--from":
            opts["from"] = argv[i + 1]; i += 2
        elif a == "--plan":
            opts["plan"] = argv[i + 1]; i += 2
        elif a == "--json":
            opts["json"] = True; i += 1
        elif a == "--no-baseline":
            opts["no_baseline"] = True; i += 1
        elif a.startswith("-"):
            rest.append(a); i += 1
        else:
            if opts["verb"] is None:
                opts["verb"] = a
            else:
                rest.append(a)
            i += 1
    return opts, rest


def main(argv):
    opts, unknown = parse(argv)
    as_json = opts["json"]

    if unknown:
        return fail("unknown_argument", f"unknown argument: {unknown[0]}", as_json)
    if opts["verb"] is None:
        print(USAGE)
        return 0
    if opts["verb"] in DEFERRED:
        return fail("verb_unavailable", DEFERRED[opts["verb"]], as_json)

    try:
        from gator_auto import commands
        if opts["verb"] == "plan":
            return commands.plan(opts)
        if opts["verb"] == "show":
            return commands.show(opts)
        if opts["verb"] == "plans":
            return commands.plans(opts)
    except Refusal as r:
        return fail(r.code, r.message, as_json)

    return fail("unknown_verb", f"unknown verb: {opts['verb']}", as_json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
