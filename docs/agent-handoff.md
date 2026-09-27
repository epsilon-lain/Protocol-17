# P17 agent handoff (experimental)

Use this interface when agents write an existing project instead of asking P17's
provider to translate a single `.p17` program. It uses only the Python standard
library and the installed language compiler, if the target requires one. No
provider credentials or model call are needed.

The planner writes an intent file and a manifest **inside the project directory**.
The implementer supplies implementation files and acceptance scripts. Both are
committed or passed to the reviewer, who runs the same manifest and derives
additional tests from the original requirements. For example:

`intent.p17`:

```text
Given two integers a and b, compute a+b. The result must be the exact sum.
```

`handoff.json`:

```json
{
  "schema_version": 1,
  "intent": "intent.p17",
  "artifacts": [{"path": "app.py", "target": "python"}],
  "checks": [
    {"name": "sum acceptance", "argv": ["@python", "test_app.py"], "expect_exit": 0}
  ]
}
```

From the repository root:

```sh
python src/p17_agent.py path/to/project/handoff.json > evidence.json
```

The identical check is available directly to a Python agent (add this
repository's `src/` directory to `PYTHONPATH`):

```python
from pathlib import Path
from p17_agent import verify_handoff, verify_handoff_file

report = verify_handoff_file(Path("path/to/project/handoff.json"))
# Or pass the already parsed manifest without an intermediate JSON file:
report = verify_handoff(manifest_dict, workspace=Path("path/to/project"))
print(report.status, report.exit_code, report.to_dict())
```

This is the version 1 Python API contract: `verify_handoff` accepts a
JSON-compatible manifest object and a project directory; `verify_handoff_file`
accepts a manifest path. Both return `HandoffResult` with `status`, `exit_code`
and `to_dict()`; the CLI serializes exactly that dictionary. No provider
configuration is loaded in either path.

`@python` expands to the current interpreter. `argv` is an argument array,
never a shell script. Checks run with the manifest directory as the working
directory; optional `timeout_seconds` is an integer from 1 to 300 (default
30), and optional `expect_stdout` requires exact stdout. Review commands
before running a manifest from someone else: they execute locally.

The JSON output has `status` (`PASS`, `FAILED`, or `UNAVAILABLE`), file hashes,
the intent hash, per-artifact compiler results, and per-check exit/output.
Exit codes are 0, 1, and 2 respectively. A manifest without an intent, an
artifact, or a behavior check is unavailable. Referenced files must exist
inside the manifest directory. Multiple artifacts can be listed; each is
verified independently as a C17, Python, or Rust source file.

**Evidence boundary:** `PASS` means the listed files passed target checks and
the listed commands produced their expected results. It does not prove that
the `.p17` prose was interpreted correctly or that the tests cover every
requirement. `fidelity: "unverified"` states this explicitly. A reviewer must
read the original requirement and generate independent checks. C/Rust files
that require a project-wide build cannot be verified standalone by this
version; use the real project build in a behavioral check, and treat any
standalone compiler failure as a reported failure rather than a pass.
