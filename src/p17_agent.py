#!/usr/bin/env python3
"""Offline agent handoff check for Protocol 17.

The manifest records a .p17 intent, implementation files and executable
acceptance checks. PASS means only that the listed deterministic checks pass;
it does not prove equivalence between prose intent and implementation.
"""

import argparse
import hashlib
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from p17 import verify_target


class ManifestError(Exception):
    """An input cannot be checked confidently."""


@dataclass(frozen=True)
class HandoffResult:
    """Stable Python API result. `evidence` uses the CLI's JSON schema."""

    evidence: dict[str, Any]
    exit_code: int

    @property
    def status(self) -> str:
        return self.evidence["status"]

    def to_dict(self) -> dict[str, Any]:
        """Return the machine-readable evidence for storage or handoff."""
        return self.evidence


def _file(root: Path, value: object, suffix: str | None = None) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        raise ManifestError("paths must be nonempty relative strings")
    path = (root / value).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ManifestError(f"file missing or outside manifest directory: {value}")
    if suffix and path.suffix != suffix:
        raise ManifestError(f"expected a {suffix} intent file: {value}")
    return path


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _nonempty_str(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{field} must be a nonempty string")
    return value


def _check_manifest(manifest: object, root: Path) -> tuple[dict, int]:
    """Run the normalized check; 0 pass, 1 failure, 2 unavailable."""
    result: dict = {
        "schema_version": 1, "status": "UNAVAILABLE", "intent_sha256": None,
        "artifacts": [], "checks": [], "fidelity": "unverified",
        "diagnostics": [],
    }
    try:
        if (not isinstance(manifest, dict) or
                type(manifest.get("schema_version")) is not int or
                manifest["schema_version"] != 1):
            raise ManifestError("schema_version must be 1")
        intent = _file(root, manifest.get("intent"), ".p17")
        if not intent.read_text(encoding="utf-8").strip():
            raise ManifestError("intent file is empty")
        result["intent_sha256"] = _digest(intent)

        artifacts = manifest.get("artifacts")
        checks = manifest.get("checks")
        if not isinstance(artifacts, list) or not artifacts:
            raise ManifestError("artifacts must be a nonempty list")
        if not isinstance(checks, list) or not checks:
            raise ManifestError("checks must be a nonempty list; syntax alone is insufficient")

        # Validate the whole handoff before running even its first command.
        resolved_artifacts = []
        for item in artifacts:
            if not isinstance(item, dict) or item.get("target") not in ("c", "python", "rust"):
                raise ManifestError("each artifact needs a path and target (c/python/rust)")
            path = _file(root, item.get("path"))
            resolved_artifacts.append((item, path))

        commands = []
        for item in checks:
            if not isinstance(item, dict):
                raise ManifestError("each check must be an object")
            name = _nonempty_str(item.get("name"), "check name")
            argv = item.get("argv")
            expected = item.get("expect_exit")
            timeout = item.get("timeout_seconds", 30)
            if (not isinstance(argv, list) or not argv or
                    not all(isinstance(arg, str) and arg for arg in argv)):
                raise ManifestError(f"{name}: argv must be a nonempty string list")
            if type(expected) is not int:
                raise ManifestError(f"{name}: expect_exit must be an integer")
            if type(timeout) is not int or not 1 <= timeout <= 300:
                raise ManifestError(f"{name}: timeout_seconds must be 1..300")
            stdout_expected = item.get("expect_stdout")
            if stdout_expected is not None and not isinstance(stdout_expected, str):
                raise ManifestError(f"{name}: expect_stdout must be a string")
            commands.append((name, argv, expected, timeout, stdout_expected))

        for item, path in resolved_artifacts:
            passed, diagnostic, available = verify_target(str(path), item["target"])
            record = {
                "path": item["path"], "target": item["target"],
                "sha256": _digest(path),
                "status": "PASS" if passed else "FAILED" if available else "UNAVAILABLE",
                "diagnostic": diagnostic,
            }
            result["artifacts"].append(record)
            if not passed:
                result["status"] = record["status"]
                return result, 1 if available else 2

        for name, argv, expected, timeout, stdout_expected in commands:
            command = [sys.executable if arg == "@python" else arg for arg in argv]
            try:
                run = subprocess.run(
                    command, cwd=root, capture_output=True, text=True,
                    timeout=timeout, check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                result["checks"].append({"name": name, "status": "UNAVAILABLE", "diagnostic": str(exc)})
                result["status"] = "UNAVAILABLE"
                return result, 2
            passed = run.returncode == expected and (
                stdout_expected is None or run.stdout == stdout_expected
            )
            result["checks"].append({
                "name": name, "status": "PASS" if passed else "FAILED",
                "exit_code": run.returncode, "stdout": run.stdout,
                "stderr": run.stderr,
            })
            if not passed:
                result["status"] = "FAILED"
                return result, 1
        result["status"] = "PASS"
        return result, 0
    except (OSError, UnicodeError, ValueError, ManifestError) as exc:
        result["diagnostics"].append(str(exc))
        return result, 2


def verify_handoff(manifest: object, *, workspace: str | Path) -> HandoffResult:
    """Check an agent's manifest in a project directory, offline.

    The manifest is a JSON-compatible object with schema_version=1, intent,
    artifacts and checks. The result has PASS/FAILED/UNAVAILABLE status and
    exit codes 0/1/2. PASS does not establish prose-to-code fidelity.
    Check commands execute locally; only pass trusted, reviewed manifests.
    """
    root = Path(workspace).resolve()
    evidence, exit_code = _check_manifest(manifest, root)
    return HandoffResult(evidence, exit_code)


def verify_handoff_file(manifest_path: str | Path) -> HandoffResult:
    """Load a JSON handoff and run the same checks as `verify_handoff`."""
    path = Path(manifest_path)
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        report, _ = _check_manifest({}, path.resolve().parent)
        report["diagnostics"] = [str(exc)]
        return HandoffResult(report, 2)
    return verify_handoff(manifest, workspace=path.resolve().parent)


def main() -> None:
    parser = argparse.ArgumentParser(description="Check a P17 agent handoff without a model")
    parser.add_argument("manifest", type=Path, help="Path to a P17 agent manifest JSON")
    args = parser.parse_args()
    report = verify_handoff_file(args.manifest)
    print(json.dumps(report.to_dict(), ensure_ascii=False, sort_keys=True))
    sys.exit(report.exit_code)


if __name__ == "__main__":
    main()
