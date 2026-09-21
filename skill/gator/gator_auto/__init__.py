"""gator_auto — the controller behind `gator auto`.

Python rather than shell because JSON validation, hashing and durable state are
what this does, and Python is already a hard runtime dependency of `gator`.
Deno stays the test and lint harness; auto adds no runtime TypeScript.
"""

SCHEMA_VERSION = 2
