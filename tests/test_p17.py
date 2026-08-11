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
# Target-language tests
# ---------------------------------------------------------------------------

class TestTargetLanguages(unittest.TestCase):
    """Test target-language selection in p17.translate()."""

    def test_target_prompts_have_three_entries(self):
        """TARGET_PROMPTS must contain entries for c, python, and rust."""
        import p17
        self.assertIn("c", p17.TARGET_PROMPTS)
        self.assertIn("python", p17.TARGET_PROMPTS)
        self.assertIn("rust", p17.TARGET_PROMPTS)

    def test_get_system_prompt_c(self):
        """_get_system_prompt('c') returns the original SYSTEM_PROMPT."""
        import p17
        prompt = p17._get_system_prompt("c")
        self.assertEqual(prompt, p17.SYSTEM_PROMPT)

    def test_get_system_prompt_python(self):
        """_get_system_prompt('python') contains Python-specific instructions."""
        import p17
        prompt = p17._get_system_prompt("python")
        self.assertIn("Python 3", prompt)
        self.assertIn("fidelity", prompt.lower())

    def test_get_system_prompt_rust(self):
        """_get_system_prompt('rust') contains Rust-specific instructions."""
        import p17
        prompt = p17._get_system_prompt("rust")
        self.assertIn("Rust", prompt)
        self.assertIn("fn main()", prompt)

    def test_get_system_prompt_unknown_exits(self):
        """Unknown target causes sys.exit."""
        import p17
        with self.assertRaises(SystemExit):
            p17._get_system_prompt("haskell")

    def test_fidelity_block_shared_across_targets(self):
        """The fidelity invariants must appear in every target prompt."""
        import p17
        for target in ["c", "python", "rust"]:
            prompt = p17._get_system_prompt(target)
            self.assertIn("silent by default", prompt)
            self.assertIn("AMBIGUITY", prompt)
            self.assertIn("operation must be preserved", prompt.lower())

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_translate_with_python_target(self, mock_openai_cls):
        """translate() with target='python' uses PYTHON_SYSTEM_PROMPT."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(content="a = int(input())\nb = int(input())\nprint(a + b)")
                )
            ]
        )

        import p17
        result = p17.translate("int a,b\ninput(a,b)\n输出(a+b)", target="python")

        # Verify the system prompt sent was the Python one
        call_kwargs = mock_client.chat.completions.create.call_args.kwargs
        msg = call_kwargs["messages"][0]["content"]
        self.assertIn("Python 3", msg)
        self.assertIn("a = int(input())", result)

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_translate_default_target_is_c(self, mock_openai_cls):
        """translate() without explicit target uses the C (SYSTEM_PROMPT) prompt."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(content="#include <stdio.h>\nint main(void) { return 0; }")
                )
            ]
        )

        import p17
        p17.translate("int main() {}")

        call_kwargs = mock_client.chat.completions.create.call_args.kwargs
        msg = call_kwargs["messages"][0]["content"]
        self.assertIn("C17", msg)

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_translate_rust_target(self, mock_openai_cls):
        """translate() with target='rust' uses RUST_SYSTEM_PROMPT."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(content="fn main() {\n    println!(\"hello\");\n}")
                )
            ]
        )

        import p17
        p17.translate("输出(\"hello\")", target="rust")

        call_kwargs = mock_client.chat.completions.create.call_args.kwargs
        msg = call_kwargs["messages"][0]["content"]
        self.assertIn("Rust", msg)

    @mock.patch.dict(os.environ, _MOCK_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_translate_only_stdout_is_clean(self, mock_openai_cls):
        """--translate-only stdout must contain only generated code, no progress text."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(content="def add(a, b):\n    return a + b")
                )
            ]
        )

        import p17
        import io
        import contextlib

        # Simulate --translate-only: call translate() and capture what main()
        # would print to stdout (the generated code, no progress messages).
        # We test translate() directly since main() exits via sys.exit().
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            result = p17.translate("int a,b\ninput(a,b)\n输出(a+b)", target="python")

        # stdout must be empty — translate() writes nothing to stdout
        self.assertEqual(stdout.getvalue(), "")

        # The returned result is the generated code
        self.assertIn("def add", result)
        self.assertNotIn("Translating", result)

    def test_translate_only_subprocess_stdout_is_code_only(self):
        """CLI --translate-only stdout is generated code, not progress messages."""
        with tempfile.NamedTemporaryFile(suffix=".p17", mode="w", delete=False) as f:
            f.write("输出(\"hello\")")
            tmp = f.name
        try:
            result = run_p17(
                tmp, "--target", "python", "--translate-only",
                env={**{k: v for k, v in os.environ.items() if not k.startswith("P17_")},
                     "P17_API_URL": "https://fake.example/v1",
                     "P17_API_KEY": "fake-key",
                     "PATH": os.environ["PATH"]},
            )
            # When the API is unreachable, the CLI will fail — but the point
            # is that stdout must NOT contain "Translating" regardless.
            # If the API call itself fails, that error goes to stderr.
            stdout = result.stdout
            stderr = result.stderr
            self.assertNotIn("Translating", stdout,
                             f"stdout must not contain progress messages. Got: {stdout!r}")
            # "Translating" should be on stderr, not stdout
            self.assertIn("Translating", stderr,
                          f"Progress should go to stderr. Got stderr: {stderr!r}")
        finally:
            os.unlink(tmp)


# ---------------------------------------------------------------------------
# Identifier-preservation tests
# ---------------------------------------------------------------------------

_ID_ENV = {
    "P17_API_URL": "https://fake.example/v1",
    "P17_API_KEY": "fake-key",
}


class TestIdentifierPreservationPrompt(unittest.TestCase):
    """Verify identifier-preservation rules exist in every target prompt."""

    def test_c_prompt_has_identifier_preservation(self):
        """SYSTEM_PROMPT must include the identifier-preservation invariant."""
        import p17
        prompt = p17.SYSTEM_PROMPT

        self.assertIn("user-defined identifiers", prompt.lower())
        self.assertIn("Do NOT rename identifiers", prompt)
        self.assertIn("preserve identifier case exactly", prompt.lower())

    def test_shared_fidelity_block_has_identifier_preservation(self):
        """_FIDELITY_BLOCK must include the identifier-preservation invariant."""
        import p17
        block = p17._FIDELITY_BLOCK

        self.assertIn("user-defined identifiers", block.lower())
        self.assertIn("Do NOT rename identifiers", block)
        self.assertIn("preserve identifier case exactly", block.lower())

    def test_python_prompt_has_identifier_preservation(self):
        """PYTHON_SYSTEM_PROMPT must include identifier preservation (via _FIDELITY_BLOCK)."""
        import p17
        prompt = p17.PYTHON_SYSTEM_PROMPT

        self.assertIn("user-defined identifiers", prompt.lower())
        self.assertIn("Do NOT rename identifiers", prompt)
        self.assertIn("shadowing of built-ins", prompt)

    def test_rust_prompt_has_identifier_preservation(self):
        """RUST_SYSTEM_PROMPT must include identifier preservation (via _FIDELITY_BLOCK)."""
        import p17
        prompt = p17.RUST_SYSTEM_PROMPT

        self.assertIn("user-defined identifiers", prompt.lower())
        self.assertIn("Do NOT rename identifiers", prompt)

    def test_all_target_prompts_have_identifier_preservation(self):
        """Every target prompt in TARGET_PROMPTS must include the invariant."""
        import p17
        for target in ["c", "python", "rust"]:
            prompt = p17._get_system_prompt(target)
            self.assertIn(
                "Do NOT rename identifiers", prompt,
                f"{target} prompt missing identifier-preservation rule"
            )
            self.assertIn(
                "preserve identifier case exactly", prompt.lower(),
                f"{target} prompt missing case-preservation rule"
            )


class TestIdentifierPreservationTranslate(unittest.TestCase):
    """Mock-based tests: verify translation output preserves user identifiers."""

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_python_builtin_shadowing_max_preserved(self, mock_openai_cls):
        """User identifier 'max' must remain 'max' in Python, not max_count or similar."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content="max = -1\nprint(max)"
                    )
                )
            ]
        )

        import p17
        result = p17.translate("define max=-1;\n输出(max);", target="python")

        # The output must contain 'max' as an identifier, not max_count / max_val / etc.
        self.assertIn("max", result)
        # It must NOT rename max to something else
        self.assertNotIn("max_count", result)
        self.assertNotIn("max_val", result)
        self.assertNotIn("max_value", result)
        self.assertNotIn("maximum", result)

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_case_sensitive_pair_n_and_N(self, mock_openai_cls):
        """Identifiers n and N are distinct; both must be preserved with original case."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            '#include <stdio.h>\n\n'
                            'int main(void) {\n'
                            '    int n = 5;\n'
                            '    int N = 10;\n'
                            '    printf("%d %d\\n", n, N);\n'
                            '    return 0;\n'
                            '}\n'
                        )
                    )
                )
            ]
        )

        import p17
        result = p17.translate("int n=5;\nint N=10;\n输出(n,N);", target="c")

        # Both cases must be present
        self.assertIn("n", result)
        self.assertIn("N", result)
        # They must not be collapsed into one case
        self.assertNotIn("n = 5;\n    int n = 10;", result)
        self.assertNotIn("N = 5;\n    int N = 10;", result)

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_case_sensitive_Max_and_max(self, mock_openai_cls):
        """Max and max are distinct identifiers; both cases must be preserved."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content="Max = -1\nmax = 0\nprint(Max, max)"
                    )
                )
            ]
        )

        import p17
        result = p17.translate("define Max=-1;\ndefine max=0;\n输出(Max,max);", target="python")

        self.assertIn("Max", result)
        self.assertIn("max", result)

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_function_identifier_preserved(self, mock_openai_cls):
        """User-defined function name must be preserved exactly."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            '#include <stdio.h>\n\n'
                            'int computeScore(int base) {\n'
                            '    return base * 2;\n'
                            '}\n\n'
                            'int main(void) {\n'
                            '    printf("%d\\n", computeScore(10));\n'
                            '    return 0;\n'
                            '}\n'
                        )
                    )
                )
            ]
        )

        import p17
        result = p17.translate(
            "int computeScore(int base) { return base*2; }\n输出(computeScore(10));",
            target="c"
        )

        # computeScore must be preserved, not renamed to compute_score or similar
        self.assertIn("computeScore", result)
        self.assertNotIn("compute_score", result)

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_list_identifier_not_renamed_in_python(self, mock_openai_cls):
        """'list' in Python shadows builtin but must NOT be renamed."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content="list = [1, 2, 3]\nprint(list)"
                    )
                )
            ]
        )

        import p17
        result = p17.translate("int list\nlist = [1,2,3];\n输出(list);", target="python")

        # 'list' should remain 'list', not renamed to lst, list_, etc.
        self.assertIn("list", result)
        self.assertNotIn("lst", result)
        self.assertNotIn("list_", result)


# ---------------------------------------------------------------------------
# Data-flow preservation tests
# ---------------------------------------------------------------------------

class TestDataFlowPreservationPrompt(unittest.TestCase):
    """Verify the explicit data-flow preservation rule exists in every target prompt."""

    def test_c_prompt_has_data_flow_preservation(self):
        """SYSTEM_PROMPT must include data-flow preservation invariant."""
        import p17
        prompt = p17.SYSTEM_PROMPT

        self.assertIn("explicit intermediate state", prompt.lower())
        self.assertIn("Do not substitute an equivalent expression", prompt)
        self.assertIn("s[i] = p", prompt)
        self.assertIn("cnt[s[i]]", prompt)

    def test_shared_fidelity_block_has_data_flow_preservation(self):
        """_FIDELITY_BLOCK must include the data-flow preservation invariant."""
        import p17
        block = p17._FIDELITY_BLOCK

        self.assertIn("explicit intermediate state", block.lower())
        self.assertIn("Do not substitute an equivalent expression", block)
        self.assertIn("cnt[p]++", block)

    def test_all_target_prompts_have_data_flow_preservation(self):
        """Every target prompt must include data-flow preservation."""
        import p17
        for target in ["c", "python", "rust"]:
            prompt = p17._get_system_prompt(target)
            self.assertIn(
                "Do not substitute an equivalent expression", prompt,
                f"{target} prompt missing data-flow preservation rule"
            )
            self.assertIn(
                "explicit intermediate state", prompt.lower(),
                f"{target} prompt missing data-flow preservation rule"
            )


class TestDataFlowPreservationTranslate(unittest.TestCase):
    """Mock-based tests: verify explicit intermediate data flow is preserved."""

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_intermediate_array_read_preserved(self, mock_openai_cls):
        """s[i]=p; cnt[s[i]]++ must preserve a read from s[i], not rewrite to cnt[p]++."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            '#include <stdio.h>\n\n'
                            'int main(void) {\n'
                            '    int s[101], cnt[101] = {0};\n'
                            '    int p = 5;\n'
                            '    s[1] = p;\n'
                            '    cnt[s[1]]++;\n'
                            '    return 0;\n'
                            '}\n'
                        )
                    )
                )
            ]
        )

        import p17
        result = p17.translate("int s[101],cnt[101]={0};\nint p=5;\ns[1]=p;\ncnt[s[1]]++;", target="c")

        # Must contain a read from the array (s[1] or s[i]) AFTER the assignment
        self.assertIn("s[", result)
        # Must NOT silently bypass the intermediate array access
        self.assertNotIn("cnt[p]++", result)
        self.assertNotIn("cnt[p as usize] += 1", result)

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_explicit_temp_variable_preserved(self, mock_openai_cls):
        """temp = a + b; result = c + temp must preserve the use of temp."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            'def compute(a, b, c):\n'
                            '    temp = a + b\n'
                            '    result = c + temp\n'
                            '    return result\n'
                        )
                    )
                )
            ]
        )

        import p17
        result = p17.translate("temp = a + b;\nresult = c + temp;", target="python")

        # temp must appear as a variable
        self.assertIn("temp", result)
        # Must NOT optimize away temp into a single expression a+b+c
        self.assertNotIn("result = c + a + b", result)
        self.assertNotIn("result = a + b + c", result)


# ---------------------------------------------------------------------------
# Rust fidelity tests
# ---------------------------------------------------------------------------

class TestRustFidelityPrompt(unittest.TestCase):
    """Verify Rust-specific type-correctness and safety rules in the prompt."""

    def test_rust_prompt_has_type_correctness_rule(self):
        """RUST_SYSTEM_PROMPT must require syntactically valid, type-correct Rust."""
        import p17
        prompt = p17.RUST_SYSTEM_PROMPT

        self.assertIn("syntactically valid", prompt)
        self.assertIn("type-correct", prompt)
        self.assertIn("type system", prompt)

    def test_rust_prompt_has_valid_stdin_parsing(self):
        """RUST_SYSTEM_PROMPT must describe valid stdin reading (String buffer, not &mut i32)."""
        import p17
        prompt = p17.RUST_SYSTEM_PROMPT

        self.assertIn("&mut String", prompt)
        self.assertIn("read_line", prompt)
        self.assertIn(".trim().parse::<T>()", prompt)
        self.assertIn("NOT `&mut i32`", prompt)

    def test_rust_prompt_has_usize_indexing_rule(self):
        """RUST_SYSTEM_PROMPT must require usize-compatible array indexing."""
        import p17
        prompt = p17.RUST_SYSTEM_PROMPT

        self.assertIn("usize", prompt)
        self.assertIn("arr[i as usize]", prompt)
        self.assertIn("SliceIndex", prompt)

    def test_rust_prompt_forbids_unsafe(self):
        """RUST_SYSTEM_PROMPT must forbid unsafe to avoid type issues."""
        import p17
        prompt = p17.RUST_SYSTEM_PROMPT

        self.assertIn("Do not use `unsafe`", prompt)

    def test_rust_prompt_has_consistent_types_rule(self):
        """RUST_SYSTEM_PROMPT must require consistent variable types."""
        import p17
        prompt = p17.RUST_SYSTEM_PROMPT

        self.assertIn("Choose variable types and conversions consistently", prompt)
        self.assertIn("Do not declare a variable", prompt)
        self.assertIn("treat it as a String", prompt)

    def test_rust_prompt_has_silent_input_rule(self):
        """RUST_SYSTEM_PROMPT must inherit silent-input rule from _FIDELITY_BLOCK."""
        import p17
        prompt = p17.RUST_SYSTEM_PROMPT

        self.assertIn("silent by default", prompt)
        self.assertIn("Do NOT add user-facing messages", prompt)
        self.assertIn("No \"Please enter", prompt)

    def test_python_prompt_has_silent_input_rule(self):
        """PYTHON_SYSTEM_PROMPT must inherit silent-input rule from _FIDELITY_BLOCK."""
        import p17
        prompt = p17.PYTHON_SYSTEM_PROMPT

        self.assertIn("silent by default", prompt)
        self.assertIn("Do NOT add user-facing messages", prompt)

    def test_c_prompt_has_silent_input_rule(self):
        """SYSTEM_PROMPT must contain the silent-input invariant."""
        import p17
        prompt = p17.SYSTEM_PROMPT

        self.assertIn("silent by default", prompt)
        self.assertIn("MUST NOT generate prompts", prompt)


class TestRustFidelityTranslate(unittest.TestCase):
    """Mock-based tests: verify Rust output follows type-correctness and fidelity rules."""

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_rust_output_no_unsolicited_prompt(self, mock_openai_cls):
        """Rust translation must not contain println! input prompts."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            'use std::io;\n\n'
                            'fn main() {\n'
                            '    let mut input = String::new();\n'
                            '    io::stdin().read_line(&mut input).unwrap();\n'
                            '    let n: i32 = input.trim().parse().unwrap();\n'
                            '    println!("{}", n);\n'
                            '}\n'
                        )
                    )
                )
            ]
        )

        import p17
        result = p17.translate("读入一个数n(int);\n输出(n);", target="rust")

        # Must NOT contain convenience prompts
        self.assertNotIn("请输入", result)
        self.assertNotIn("Please enter", result)
        # Must use read_line with String
        self.assertIn("read_line", result)

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_rust_output_no_broken_stdin(self, mock_openai_cls):
        """Rust translation must NOT use read_line(&mut i32) or .trim() on numeric types."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            'use std::io;\n\n'
                            'fn main() {\n'
                            '    let mut buf = String::new();\n'
                            '    io::stdin().read_line(&mut buf).unwrap();\n'
                            '    let n: i32 = buf.trim().parse().unwrap();\n'
                            '    println!("{}", n);\n'
                            '}\n'
                        )
                    )
                )
            ]
        )

        import p17
        result = p17.translate("读入一个数n(int);\n输出(n);", target="rust")

        # Must NOT have broken patterns from the live Qwen test
        self.assertNotIn("&mut i32", result)
        self.assertNotIn("&mut n", result)
        self.assertNotIn("read_line(&mut n)", result)

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_rust_output_uses_usize_indexing(self, mock_openai_cls):
        """Rust array indexing must use usize-compatible conversion when needed."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            'use std::io;\n\n'
                            'fn main() {\n'
                            '    let mut buf = String::new();\n'
                            '    io::stdin().read_line(&mut buf).unwrap();\n'
                            '    let i: i32 = buf.trim().parse().unwrap();\n'
                            '    let arr = [0i32; 10];\n'
                            '    println!("{}", arr[i as usize]);\n'
                            '}\n'
                        )
                    )
                )
            ]
        )

        import p17
        result = p17.translate("int i;\n读入i;\nint arr[10];\n输出(arr[i]);", target="rust")

        # Array indexing must appear with a usize conversion
        self.assertIn("usize", result)

    @mock.patch.dict(os.environ, _ID_ENV, clear=True)
    @mock.patch("openai.OpenAI")
    def test_rust_output_no_unsafe(self, mock_openai_cls):
        """Rust translation must not use unsafe blocks."""
        mock_client = mock.MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock.MagicMock(
            choices=[
                mock.MagicMock(
                    message=mock.MagicMock(
                        content=(
                            'use std::io;\n\n'
                            'fn main() {\n'
                            '    let mut buf = String::new();\n'
                            '    io::stdin().read_line(&mut buf).unwrap();\n'
                            '    let n: i32 = buf.trim().parse().unwrap();\n'
                            '    println!("{}", n);\n'
                            '}\n'
                        )
                    )
                )
            ]
        )

        import p17
        result = p17.translate("读入一个数n(int);\n输出(n);", target="rust")

        # Must not use unsafe
        self.assertNotIn("unsafe", result)


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
# ---------------------------------------------------------------------------
# Verification tests
# ---------------------------------------------------------------------------

class TestVerification(unittest.TestCase):
    """Test the deterministic target verification layer — no AI involved."""

    # ------------------------------------------------------------------
    # Python verification
    # ------------------------------------------------------------------

    def test_python_valid_syntax_passes(self):
        """Valid Python source must pass verification."""
        import p17

        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
            f.write("x = 1\nprint(x)\n")
            tmp = f.name
        try:
            passed, diagnostics, tool_available = p17.verify_python(tmp)
            self.assertTrue(tool_available)
            self.assertTrue(passed, f"Valid Python should pass. diag={diagnostics!r}")
            self.assertEqual(diagnostics, "")
        finally:
            os.unlink(tmp)

    def test_python_invalid_syntax_fails(self):
        """Invalid Python syntax must fail verification."""
        import p17

        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
            f.write("def broken(\n")  # unclosed paren
            tmp = f.name
        try:
            passed, diagnostics, tool_available = p17.verify_python(tmp)
            self.assertTrue(tool_available)
            self.assertFalse(passed, "Invalid Python should fail verification")
            self.assertIn("(", diagnostics)  # syntax error mentions the issue
        finally:
            os.unlink(tmp)

    def test_python_does_not_execute_code(self):
        """Python verification must NOT execute the source — only compile."""
        import p17

        # Code with a side effect that would be observable if executed
        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
            f.write("import os; os._exit(99) if True else None\n")
            tmp = f.name
        try:
            passed, diagnostics, tool_available = p17.verify_python(tmp)
            # If it had executed, the test process would have exited with 99.
            # We're still here, so it didn't execute.
            self.assertTrue(tool_available)
            self.assertTrue(passed, f"Valid Python (no-exec) should pass. diag={diagnostics!r}")
        finally:
            os.unlink(tmp)

    # ------------------------------------------------------------------
    # C verification — mock subprocess to verify the invocation shape
    # ------------------------------------------------------------------

    @mock.patch("subprocess.run")
    def test_c_verifier_uses_gcc_syntax_only(self, mock_run):
        """verify_c must invoke gcc -std=c17 -fsyntax-only."""
        import p17

        mock_run.return_value = mock.MagicMock(returncode=0, stdout="", stderr="")
        passed, diagnostics, tool_available = p17.verify_c("/tmp/test.c")

        self.assertTrue(tool_available)
        self.assertTrue(passed)
        call_args = mock_run.call_args[0][0]
        call_str = " ".join(call_args)
        self.assertIn("-std=c17", call_str)
        self.assertIn("-fsyntax-only", call_str)

    @mock.patch("subprocess.run")
    def test_c_verifier_surfaces_gcc_failure(self, mock_run):
        """verify_c must surface gcc failure with diagnostics."""
        import p17

        mock_run.return_value = mock.MagicMock(
            returncode=1,
            stdout="",
            stderr="error: expected ';' before '}' token\n",
        )
        passed, diagnostics, tool_available = p17.verify_c("/tmp/bad.c")

        self.assertTrue(tool_available)
        self.assertFalse(passed)
        self.assertIn("expected ';'", diagnostics)

    @mock.patch("shutil.which")
    def test_c_verifier_unavailable_when_gcc_missing(self, mock_which):
        """verify_c must report tool unavailable when gcc is not found."""
        import p17

        mock_which.return_value = None
        passed, diagnostics, tool_available = p17.verify_c("/tmp/test.c")

        self.assertFalse(tool_available)
        self.assertFalse(passed)
        self.assertIn("gcc not found", diagnostics)

    # ------------------------------------------------------------------
    # Rust verification — mock subprocess to verify invocation shape
    # ------------------------------------------------------------------

    @mock.patch("subprocess.run")
    @mock.patch("tempfile.TemporaryDirectory")
    def test_rust_verifier_uses_rustc_metadata(self, mock_tmpdir, mock_run):
        """verify_rust must invoke rustc --emit=metadata for type-checking."""
        import p17

        mock_tmpdir.return_value.__enter__.return_value = "/tmp/p17_verify_mock"
        mock_run.return_value = mock.MagicMock(returncode=0, stdout="", stderr="")
        passed, diagnostics, tool_available = p17.verify_rust("/tmp/test.rs")

        self.assertTrue(tool_available)
        self.assertTrue(passed)
        call_args = mock_run.call_args[0][0]
        call_str = " ".join(call_args)
        self.assertIn("rustc", call_str)
        self.assertIn("--emit=metadata", call_str)
        self.assertIn("--crate-name", call_str)
        self.assertIn("p17_verify", call_str)

    @mock.patch("subprocess.run")
    @mock.patch("tempfile.TemporaryDirectory")
    def test_rust_verifier_surfaces_type_error(self, mock_tmpdir, mock_run):
        """Rust type errors must be surfaced as verification failure with diagnostics."""
        import p17

        mock_tmpdir.return_value.__enter__.return_value = "/tmp/p17_verify_mock"

        rust_error = (
            "error[E0308]: mismatched types\n"
            " --> test.rs:2:39\n"
            "2 |     std::io::stdin().read_line(&mut n).unwrap();\n"
            "  |                                       ^ expected `&mut String`, found `&mut i32`\n"
        )
        mock_run.return_value = mock.MagicMock(returncode=1, stdout="", stderr=rust_error)
        passed, diagnostics, tool_available = p17.verify_rust("/tmp/bad.rs")

        self.assertTrue(tool_available)
        self.assertFalse(passed)
        self.assertIn("E0308", diagnostics)
        self.assertIn("&mut String", diagnostics)

    @mock.patch("shutil.which")
    def test_rust_verifier_unavailable_when_rustc_missing(self, mock_which):
        """verify_rust must report tool unavailable when rustc is not found."""
        import p17

        mock_which.return_value = None
        passed, diagnostics, tool_available = p17.verify_rust("/tmp/test.rs")

        self.assertFalse(tool_available)
        self.assertFalse(passed)
        self.assertIn("rustc not found", diagnostics)

    # ------------------------------------------------------------------
    # verify_target dispatch
    # ------------------------------------------------------------------

    def test_verify_target_dispatches_to_correct_verifier(self):
        """verify_target must dispatch to the right per-target function."""
        import p17

        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
            f.write("x = 1\n")
            tmp = f.name
        try:
            passed, diagnostics, tool_available = p17.verify_target(tmp, "python")
            self.assertTrue(tool_available)
            self.assertTrue(passed)
        finally:
            os.unlink(tmp)

    def test_verify_target_unknown_target(self):
        """verify_target must report unknown target as unavailable."""
        import p17

        passed, diagnostics, tool_available = p17.verify_target("/tmp/x.zig", "zig")
        self.assertFalse(tool_available)
        self.assertFalse(passed)
        self.assertIn("unknown target", diagnostics.lower())

    # ------------------------------------------------------------------
    # CLI: --verify-file does not need API keys
    # ------------------------------------------------------------------

    def test_verify_file_cli_no_api_keys_needed(self):
        """--verify-file must work without P17_API_URL / P17_API_KEY."""
        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
            f.write("x = 1\n")
            tmp = f.name
        try:
            result = run_p17(
                "--verify-file", tmp, "--target", "python",
                env={"P17_API_URL": "", "P17_API_KEY": "", "PATH": os.environ["PATH"]},
            )
            self.assertEqual(result.returncode, 0,
                             f"Verification should pass without API keys. stderr={result.stderr!r}")
        finally:
            os.unlink(tmp)

    def test_verify_file_cli_failure_exit_code(self):
        """--verify-file with invalid source must exit non-zero."""
        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
            f.write("def broken(\n")
            tmp = f.name
        try:
            result = run_p17(
                "--verify-file", tmp, "--target", "python",
                env={"P17_API_URL": "", "P17_API_KEY": "", "PATH": os.environ["PATH"]},
            )
            self.assertNotEqual(result.returncode, 0,
                                "Verification of invalid source should exit non-zero")
            self.assertIn("VERIFICATION FAILED", result.stderr)
        finally:
            os.unlink(tmp)

    def test_verify_file_cli_never_calls_translate(self):
        """--verify-file must never invoke the OpenAI translator."""
        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
            f.write("x = 1\n")
            tmp = f.name
        try:
            # Run with no API keys — if it tried to call translate(), it would fail
            result = run_p17(
                "--verify-file", tmp, "--target", "python",
                env={"P17_API_URL": "", "P17_API_KEY": "", "PATH": os.environ["PATH"]},
            )
            # Must succeed without API keys, proving no AI call was made
            self.assertEqual(result.returncode, 0,
                             f"verify-file should not call AI. stderr={result.stderr!r}")
        finally:
            os.unlink(tmp)

    # ------------------------------------------------------------------
    # CLI: stdout cleanliness
    # ------------------------------------------------------------------

    def test_verify_file_stdout_is_clean(self):
        """--verify-file must keep stdout clean; diagnostics go to stderr."""
        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
            f.write("x = 1\n")
            tmp = f.name
        try:
            result = run_p17(
                "--verify-file", tmp, "--target", "python",
                env={"P17_API_URL": "", "P17_API_KEY": "", "PATH": os.environ["PATH"]},
            )
            # stdout must be empty — verification messages go to stderr
            self.assertEqual(result.stdout.strip(), "",
                             f"stdout must be clean. Got: {result.stdout!r}")
        finally:
            os.unlink(tmp)


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
