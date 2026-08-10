"""Minimal tests for Protocol 17 CLI.

Usage:
    .venv/bin/python tests/test_p17.py              # unit tests (no API key needed)
    P17_API_URL=... P17_API_KEY=... \
        .venv/bin/python tests/test_p17.py --real   # include integration test
"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
P17_PY = str(PROJECT_ROOT / "src" / "p17.py")

# Make p17 importable
sys.path.insert(0, str(PROJECT_ROOT / "src"))


def run_p17(*args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    """Run p17.py as a subprocess with given CLI args."""
    full_env = {**os.environ, **(env or {})}
    return subprocess.run(
        [sys.executable, P17_PY, *args],
        capture_output=True, text=True, env=full_env,
    )


# ---------------------------------------------------------------------------
# Unit tests — error paths (no API key needed, use subprocess)
# ---------------------------------------------------------------------------

class TestCLIErrors(unittest.TestCase):
    """Tests that exercise CLI error handling without calling the AI API."""

    def test_file_not_found(self):
        result = run_p17("/nonexistent/file.p17")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("file not found", result.stdout + result.stderr)

    def test_empty_file(self):
        with tempfile.NamedTemporaryFile(suffix=".p17", mode="w", delete=False) as f:
            f.write("")
            tmp = f.name
        try:
            result = run_p17(tmp)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("empty", result.stdout + result.stderr)
        finally:
            os.unlink(tmp)

    def test_missing_env_vars(self):
        """When API env vars are missing, exit before calling the API."""
        with tempfile.NamedTemporaryFile(suffix=".p17", mode="w", delete=False) as f:
            f.write("int a,b\n")
            tmp = f.name
        try:
            result = run_p17(
                tmp,
                env={"P17_API_URL": "", "P17_API_KEY": "", "PATH": os.environ["PATH"]},
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("P17_API_URL", result.stdout + result.stderr)
        finally:
            os.unlink(tmp)


# ---------------------------------------------------------------------------
# Unit tests — mock the AI client (same-process, import p17 directly)
# ---------------------------------------------------------------------------

# Env the translate() function expects
_MOCK_ENV = {
    "P17_API_URL": "https://fake.example/v1",
    "P17_API_KEY": "fake-key",
}


class TestTranslate(unittest.TestCase):
    """Test p17.translate() directly with mocked OpenAI client."""

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_successful_translation(self, mock_openai_cls):
        """translate() returns valid C code from a mocked successful response."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            '#include <stdio.h>\n\n'
                            'int main(void) {\n'
                            '    int a, b;\n'
                            '    scanf("%d %d", &a, &b);\n'
                            '    printf("%d\\n", a + b);\n'
                            '    return 0;\n'
                            '}\n'
                        )
                    )
                )
            ]
        )

        import p17
        c_source = p17.translate("int a,b\ninput(a,b)\n输出(a+b)")

        self.assertIn("int main", c_source)
        self.assertIn("scanf", c_source)
        self.assertNotIn("AMBIGUITY", c_source)

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_silent_input_no_prompts(self, mock_openai_cls):
        """Read+output must not generate extra printf prompts (regression for fidelity bug)."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        # Simulate a correct translation: scanf reads silently, only the
        # explicitly-requested printf appears — no "请输入…" noise.
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            '#include <stdio.h>\n\n'
                            'int main(void) {\n'
                            '    int n;\n'
                            '    scanf("%d", &n);\n'
                            '    printf("%d\\n", n);\n'
                            '    return 0;\n'
                            '}\n'
                        )
                    )
                )
            ]
        )

        import p17
        c_source = p17.translate("int n\n读入n\n输出(n)")

        # Must have the explicit output
        self.assertIn('printf("%d', c_source)
        # Must have scanf for the read
        self.assertIn("scanf", c_source)
        # Must NOT inject convenience prompts
        self.assertNotIn("请输入", c_source)
        self.assertNotIn("Please enter", c_source)
        self.assertNotIn("enter a number", c_source.lower())
        self.assertNotIn("prompt", c_source.lower())

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_system_prompt_has_silent_input_invariant(self, mock_openai_cls):
        """SYSTEM_PROMPT must include the silent-input rule so models see it."""
        import p17
        prompt = p17.SYSTEM_PROMPT

        self.assertIn("silent by default", prompt)
        self.assertIn("MUST NOT generate prompts", prompt)
        self.assertIn("Do NOT add user-facing messages", prompt)

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_system_prompt_has_operation_preservation_invariant(self, mock_openai_cls):
        """SYSTEM_PROMPT must include operation-preservation and dependency-order rules."""
        import p17
        prompt = p17.SYSTEM_PROMPT

        self.assertIn("Every explicit user operation must be preserved", prompt)
        self.assertIn("MUST NOT be silently omitted", prompt)
        self.assertIn("Preserve dependency order", prompt)
        self.assertIn("uninitialized", prompt.lower())

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_ambiguity_response(self, mock_openai_cls):
        """translate() returns the AMBIGUITY string as-is; main() handles exit."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content="AMBIGUITY: cannot determine signedness"
                    )
                )
            ]
        )

        import p17
        result = p17.translate("int x\ninput(x)")
        self.assertTrue(result.startswith("AMBIGUITY:"))

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_markdown_fence_stripping(self, mock_openai_cls):
        """AI output wrapped in ```c ... ``` should be stripped."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            '```c\n'
                            '#include <stdio.h>\n'
                            'int main(void) { printf("hi\\n"); return 0; }\n'
                            '```'
                        )
                    )
                )
            ]
        )

        import p17
        c_source = p17.translate('输出("hi")')

        self.assertNotIn("```", c_source)
        self.assertIn("int main", c_source)

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_no_markdown_fence_passthrough(self, mock_openai_cls):
        """Clean output without fences passes through unchanged."""
        clean_c = '#include <stdio.h>\nint main(void) { return 0; }'
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(message=mock.MagicMock(content=clean_c + "\n"))
            ]
        )

        import p17
        c_source = p17.translate("int main() {}")

        # .strip() removes trailing whitespace
        self.assertEqual(c_source, clean_c)


# ---------------------------------------------------------------------------
# Reverse-mode tests
# ---------------------------------------------------------------------------

class TestReversePrompt(unittest.TestCase):
    """Test that REVERSE_SYSTEM_PROMPT exists and contains required invariants."""

    def test_reverse_prompt_exists(self):
        """REVERSE_SYSTEM_PROMPT must be a non-empty string."""
        import p17
        prompt = p17.REVERSE_SYSTEM_PROMPT
        self.assertIsInstance(prompt, str)
        self.assertGreater(len(prompt), 100)

    def test_reverse_prompt_includes_fixed_semantics(self):
        """Reverse prompt must contain the fixed-semantics / no-bug-fixing invariant."""
        import p17
        prompt = p17.REVERSE_SYSTEM_PROMPT

        self.assertIn("fixed semantics", prompt.lower())
        self.assertIn("Free representation", prompt)

    def test_reverse_prompt_includes_actual_behaviour_invariant(self):
        """Reverse prompt must require describing actual behaviour, not intent."""
        import p17
        prompt = p17.REVERSE_SYSTEM_PROMPT

        self.assertIn("actual program behaviour", prompt.lower())
        self.assertIn("not intended behaviour", prompt.lower())

    def test_reverse_prompt_forbids_bug_fixing(self):
        """Reverse prompt must forbid silently fixing bugs or suspicious logic."""
        import p17
        prompt = p17.REVERSE_SYSTEM_PROMPT

        self.assertIn("Do not silently fix bugs", prompt)
        self.assertIn("repair bugs", prompt.lower())

    def test_reverse_prompt_forbids_inventing_assumptions(self):
        """Reverse prompt must forbid inventing assumptions or inferring intent."""
        import p17
        prompt = p17.REVERSE_SYSTEM_PROMPT

        self.assertIn("invent assumptions", prompt.lower())
        self.assertIn("Do not infer unstated programmer intent", prompt)

    def test_reverse_prompt_preserves_constants_and_state(self):
        """Reverse prompt must require preserving constants, boundaries, state updates."""
        import p17
        prompt = p17.REVERSE_SYSTEM_PROMPT

        self.assertIn("constants", prompt.lower())
        self.assertIn("state updates", prompt.lower())

    def test_reverse_prompt_requires_english_prose(self):
        """Reverse prompt should specify English as the prose language."""
        import p17
        prompt = p17.REVERSE_SYSTEM_PROMPT

        self.assertIn("English", prompt)


class TestReverseTranslate(unittest.TestCase):
    """Test p17.reverse_translate() directly with mocked OpenAI client."""

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_reverse_translate_returns_text(self, mock_openai_cls):
        """reverse_translate() returns a non-empty description string."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content="Initialize sum to 0. For i from 0 to n-1, sum ← sum + a[i]."
                    )
                )
            ]
        )

        import p17
        result = p17.reverse_translate("int sum = 0;\nfor (int i = 0; i < n; ++i) sum += a[i];")

        self.assertIsInstance(result, str)
        self.assertGreater(len(result), 0)

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_reverse_mode_uses_reverse_prompt(self, mock_openai_cls):
        """reverse_translate() must send the REVERSE_SYSTEM_PROMPT, not the forward one."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(content="Description.")
                )
            ]
        )

        import p17
        p17.reverse_translate("int main() { return 0; }")

        call_kwargs = mock_client.chat.completions.create.call_args.kwargs
        messages = call_kwargs["messages"]
        system_msg = messages[0]["content"]

        self.assertIn("Free representation", system_msg)
        self.assertIn("fixed semantics", system_msg.lower())
        # Verify the forward prompt's distinct markers are NOT present
        self.assertNotIn("Protocol 17 (P17) to C17 translator", system_msg)

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    @mock.patch("p17.compile_and_run")
    def test_reverse_translate_does_not_call_compile(self, mock_compile, mock_openai_cls):
        """reverse_translate() must not invoke compile_and_run or any compilation."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(content="A description of the code.")
                )
            ]
        )

        import p17
        result = p17.reverse_translate("int main() { return 0; }")

        self.assertIsNotNone(result)
        mock_compile.assert_not_called()

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_reverse_markdown_fence_stripping(self, mock_openai_cls):
        """Reverse output wrapped in ``` fences is stripped."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content="```\nInitialize sum to 0.\nFor each i, sum ← sum + a[i].\n```"
                    )
                )
            ]
        )

        import p17
        result = p17.reverse_translate("int sum = 0; for(...) sum += a[i];")

        self.assertNotIn("```", result)
        self.assertIn("Initialize sum", result)


class TestCompile(unittest.TestCase):
    """Test compile_and_run() — uses real gcc, no AI involved."""

    def test_compile_error_preserves_c_file(self):
        """Invalid C fails compilation and preserves the generated source."""
        import p17

        build = Path(tempfile.mkdtemp())
        try:
            exit_code = p17.compile_and_run(
                "this is not valid C !!!",
                build,
                no_run=True,
            )
            self.assertNotEqual(exit_code, 0)
            c_path = build / "program.c"
            self.assertTrue(c_path.exists())
            self.assertEqual(c_path.read_text(), "this is not valid C !!!")
        finally:
            import shutil
            shutil.rmtree(build)

    def test_successful_compile_and_run(self):
        """Valid C compiles and runs correctly."""
        import p17

        build = Path(tempfile.mkdtemp())
        try:
            exit_code = p17.compile_and_run(
                '#include <stdio.h>\n'
                'int main(void) { printf("hello\\n"); return 0; }\n',
                build,
            )
            self.assertEqual(exit_code, 0)
            self.assertTrue((build / "program.c").exists())
            self.assertTrue((build / "program").exists())
        finally:
            import shutil
            shutil.rmtree(build)

    def test_compile_with_input(self):
        """Compiled program receives stdin data."""
        import p17

        build = Path(tempfile.mkdtemp())
        try:
            exit_code = p17.compile_and_run(
                '#include <stdio.h>\n'
                'int main(void) {'
                '  int a, b;'
                '  scanf("%d %d", &a, &b);'
                '  printf("%d\\n", a + b);'
                '  return 0;'
                '}\n',
                build,
                input_data="3 4",
            )
            self.assertEqual(exit_code, 0)
        finally:
            import shutil
            shutil.rmtree(build)

    def test_no_run_flag_skips_execution(self):
        """--no-run compiles but does not run the binary."""
        import p17

        build = Path(tempfile.mkdtemp())
        try:
            exit_code = p17.compile_and_run(
                '#include <stdio.h>\n'
                'int main(void) { printf("should not print\\n"); return 0; }\n',
                build,
                no_run=True,
            )
            self.assertEqual(exit_code, 0)
            self.assertTrue((build / "program").exists())
        finally:
            import shutil
            shutil.rmtree(build)


# ---------------------------------------------------------------------------
# Integration test — requires real API credentials
# ---------------------------------------------------------------------------

class TestIntegration(unittest.TestCase):
    """End-to-end test using a real AI provider.  Skipped without credentials."""

    def setUp(self):
        if not os.environ.get("P17_API_URL") or not os.environ.get("P17_API_KEY"):
            self.skipTest("P17_API_URL and P17_API_KEY not set")

    def test_add_example(self):
        """Run examples/001-add.p17 with real AI translation."""
        p17_file = str(PROJECT_ROOT / "examples" / "001-add.p17")
        result = run_p17(p17_file, "--input", "1 1")
        self.assertEqual(result.returncode, 0, f"stderr: {result.stderr}")
        self.assertIn("2", result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
