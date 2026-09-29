"""Meaningful offline checks of the agent handoff and its failure modes."""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


CLI = Path(__file__).resolve().parents[1] / "src" / "p17_agent.py"
sys.path.insert(0, str(CLI.parent))
from p17_agent import verify_handoff, verify_handoff_file


class AgentHandoffTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "intent.p17").write_text(
            "Given two integers, return their sum.\n", encoding="utf-8"
        )
        (self.root / "app.py").write_text("def add(a, b):\n    return a + b\n")
        (self.root / "test_app.py").write_text(
            "from app import add\nassert add(1, 2) == 3\n"
        )
        self.manifest = {
            "schema_version": 1,
            "intent": "intent.p17",
            "artifacts": [{"path": "app.py", "target": "python"}],
            "checks": [{"name": "add behavior", "argv": ["@python", "test_app.py"], "expect_exit": 0}],
        }

    def run_check(self):
        (self.root / "handoff.json").write_text(json.dumps(self.manifest))
        env = {k: v for k, v in os.environ.items() if not k.startswith("P17_")}
        run = subprocess.run(
            [sys.executable, str(CLI), str(self.root / "handoff.json")],
            capture_output=True, text=True, env=env,
        )
        return run.returncode, json.loads(run.stdout)

    def test_multiple_files_and_repeated_deterministic_evidence(self):
        (self.root / "helper.py").write_text("ANSWER = 3\n")
        self.manifest["artifacts"].append({"path": "helper.py", "target": "python"})
        first = self.run_check()
        second = self.run_check()
        self.assertEqual(first, second)
        self.assertEqual(first[0], 0)
        self.assertEqual(first[1]["status"], "PASS")
        self.assertEqual(first[1]["fidelity"], "unverified")
        self.assertEqual(first[1]["intent_sha256"], hashlib.sha256(
            (self.root / "intent.p17").read_bytes()).hexdigest())

    def test_python_api_and_cli_share_one_contract(self):
        code, cli_evidence = self.run_check()
        report = verify_handoff(self.manifest, workspace=self.root)
        file_report = verify_handoff_file(self.root / "handoff.json")
        self.assertEqual(report.status, "PASS")
        self.assertEqual(report.exit_code, code)
        self.assertEqual(report.to_dict(), cli_evidence)
        self.assertEqual(file_report.to_dict(), cli_evidence)

    def test_python_api_rejects_bad_schema(self):
        report = verify_handoff({"schema_version": 2}, workspace=self.root)
        self.assertEqual(report.status, "UNAVAILABLE")
        self.assertEqual(report.exit_code, 2)
        self.assertEqual(report.to_dict()["fidelity"], "unverified")

    def test_wrong_behavior_fails_even_when_syntax_passes(self):
        (self.root / "app.py").write_text("def add(a, b):\n    return a - b\n")
        code, result = self.run_check()
        self.assertEqual(code, 1)
        self.assertEqual(result["artifacts"][0]["status"], "PASS")
        self.assertEqual(result["checks"][0]["status"], "FAILED")

    def test_syntax_failure_stops_before_running_behavior_check(self):
        (self.root / "app.py").write_text("def add(:\n")
        code, result = self.run_check()
        self.assertEqual(code, 1)
        self.assertEqual(result["artifacts"][0]["status"], "FAILED")
        self.assertEqual(result["checks"], [])

    def test_missing_check_or_intent_is_unavailable(self):
        self.manifest["checks"] = []
        code, result = self.run_check()
        self.assertEqual(code, 2)
        self.assertEqual(result["status"], "UNAVAILABLE")
        self.manifest["checks"] = [{"name": "test", "argv": ["@python", "test_app.py"], "expect_exit": 0}]
        (self.root / "intent.p17").write_text("")
        self.assertEqual(self.run_check()[0], 2)

    def test_missing_command_is_unavailable(self):
        self.manifest["checks"][0]["argv"] = ["nonexistent-p17-test-command"]
        code, result = self.run_check()
        self.assertEqual(code, 2)
        self.assertEqual(result["checks"][0]["status"], "UNAVAILABLE")

    def test_artifact_escape_is_rejected(self):
        self.manifest["artifacts"][0]["path"] = "../outside.py"
        code, result = self.run_check()
        self.assertEqual(code, 2)
        self.assertEqual(result["status"], "UNAVAILABLE")

    def test_invalid_later_check_does_not_run_earlier_command(self):
        self.manifest["checks"] = [
            {"name": "write marker", "argv": ["@python", "-c", "open('ran', 'w').write('yes')"], "expect_exit": 0},
            {"name": "invalid", "argv": "not an argument array", "expect_exit": 0},
        ]
        code, result = self.run_check()
        self.assertEqual(code, 2)
        self.assertFalse((self.root / "ran").exists())
        self.assertEqual(result["checks"], [])

    def _write_requirements(self):
        (self.root / "requirements.md").write_text(
            "# Original requirement\n\nReturn the exact sum.\n",
            encoding="utf-8",
        )

    def test_legacy_manifest_without_requirements_remains_compatible(self):
        self.assertNotIn("requirements", self.manifest)
        code, result = self.run_check()
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["coverage"]["linkage"], "not_declared")
        self.assertEqual(result["coverage"]["items"], [])

    def test_valid_requirement_linkage_reports_hashed_source(self):
        self._write_requirements()
        self.manifest["requirements"] = {
            "sources": ["requirements.md"],
            "items": [{"id": "req-sum", "checks": ["add behavior"]}],
        }
        code, result = self.run_check()
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["coverage"]["linkage"], "complete")
        self.assertEqual(result["coverage"]["items"][0]["id"], "req-sum")
        self.assertEqual(
            result["coverage"]["sources"][0]["sha256"],
            hashlib.sha256((self.root / "requirements.md").read_bytes()).hexdigest(),
        )

    def test_requirement_without_check_is_failed_not_pass(self):
        self._write_requirements()
        self.manifest["requirements"] = {
            "sources": ["requirements.md"],
            "items": [{"id": "req-sum", "checks": []}],
        }
        code, result = self.run_check()
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["coverage"]["linkage"], "incomplete")
        self.assertTrue(any("has no associated check" in gap for gap in result["coverage"]["gaps"]))

    def test_requirement_referencing_unknown_check_is_failed(self):
        self._write_requirements()
        self.manifest["requirements"] = {
            "sources": ["requirements.md"],
            "items": [{"id": "req-sum", "checks": ["does-not-exist"]}],
        }
        code, result = self.run_check()
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["coverage"]["linkage"], "incomplete")
        self.assertTrue(any("references unknown check" in gap for gap in result["coverage"]["gaps"]))

    def test_behavior_failure_with_valid_coverage_still_fails(self):
        self._write_requirements()
        self.manifest["requirements"] = {
            "sources": ["requirements.md"],
            "items": [{"id": "req-sum", "checks": ["add behavior"]}],
        }
        (self.root / "app.py").write_text("def add(a, b):\n    return a - b\n")
        code, result = self.run_check()
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["coverage"]["linkage"], "complete")
        self.assertEqual(result["checks"][0]["status"], "FAILED")

    def test_acceptance_script_hash_is_recorded_and_changes(self):
        self.manifest["checks"][0]["file"] = "test_app.py"
        code, result = self.run_check()
        self.assertEqual(code, 0)
        first_hash = result["checks"][0]["file_sha256"]
        self.assertEqual(result["checks"][0]["file"], "test_app.py")
        self.assertEqual(
            first_hash,
            hashlib.sha256((self.root / "test_app.py").read_bytes()).hexdigest(),
        )
        (self.root / "test_app.py").write_text(
            "from app import add\nassert add(1, 2) == 3\n# acceptance script changed\n",
            encoding="utf-8",
        )
        code, result = self.run_check()
        self.assertEqual(code, 0)
        self.assertNotEqual(first_hash, result["checks"][0]["file_sha256"])

    def test_declared_input_hash_is_recorded_and_changes(self):
        (self.root / "data.txt").write_text("fixture-v1\n", encoding="utf-8")
        self.manifest["inputs"] = [{"path": "data.txt"}]
        code, result = self.run_check()
        self.assertEqual(code, 0)
        first_hash = result["inputs"][0]["sha256"]
        self.assertEqual(result["inputs"][0]["path"], "data.txt")
        self.assertEqual(
            first_hash,
            hashlib.sha256((self.root / "data.txt").read_bytes()).hexdigest(),
        )
        (self.root / "data.txt").write_text("fixture-v2\n", encoding="utf-8")
        code, result = self.run_check()
        self.assertEqual(code, 0)
        self.assertNotEqual(first_hash, result["inputs"][0]["sha256"])


if __name__ == "__main__":
    unittest.main()
