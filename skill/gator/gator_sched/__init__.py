"""gator_sched — where a unit is allowed to run.

Roles answer which model does the work. This package answers which backend may
execute it. The two are deliberately separate, because they are different kinds
of statement: a role is a preference and an eligibility set is a constraint, and
no amount of load, weighting or queue pressure may turn one into the other.
"""

SCHEMA_VERSION = 1
