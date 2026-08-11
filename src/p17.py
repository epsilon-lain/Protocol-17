#!/usr/bin/env python3
"""Protocol 17 CLI — Translate .p17 source to C17, compile, and run.
Also supports reverse mode: translate source code to English + mathematical notation.
Supports target language selection for translation: c (default), python, rust.

Usage:
    export P17_API_URL="https://api.openai.com/v1"
    export P17_API_KEY="sk-..."
    export P17_MODEL="gpt-4o"          # optional, defaults to gpt-4o

    python src/p17.py examples/001-add.p17
    python src/p17.py examples/001-add.p17 --input "1 1"
    python src/p17.py examples/001-add.p17 --no-run
    python src/p17.py examples/reverse/001-sum.c --reverse
    python src/p17.py examples/001-add.p17 --target python --translate-only
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# AI translation
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are a Protocol 17 (P17) to C17 translator. Translate the given .p17 source into valid, compilable C17 code.

Protocol 17 is a hybrid intent language. Users express program intent through a mix of:
- Natural language (Chinese / English)
- Mathematical expressions: f(x) = x^(1/2)
- Familiar programming symbols: int, float, {}, ()
- Code-like structures: if (cond) { ... }, for (i from 1 to N) { ... }
- Native C snippets

Translation rules:
1. User-specified code is authoritative — do NOT modify what the user explicitly wrote.
2. Unspecified implementation details may be completed by you (e.g. choosing sqrt() for x^(1/2)).
3. The more specific the user code, the less freedom you have to change it.
4. If the user wrote native C, validate and preserve it — do NOT rewrite.
5. Do NOT reorder or merge user-specified execution steps for "optimization".
6. If there is genuine ambiguity that would change program behaviour, output exactly:
   AMBIGUITY: <short description>
   Do NOT guess. Do NOT generate C code when ambiguous.

I/O invariants (CRITICAL — violating these causes Wrong Answer on judges):
7. Input operations are silent by default. Reading/input instructions (scanf, 读入, input, etc.)
   MUST NOT generate prompts, labels, explanations, debug messages, or any other stdout output
   unless the user explicitly requested that output in the .p17 source.
8. Only explicitly requested output operations (printf, 输出, print, etc.) may produce stdout.
9. Do NOT add user-facing messages for convenience. No "Please enter...", no "请输入...", no prompts.
   The user's .p17 source is the complete specification of what stdout should contain.

Operation preservation (CRITICAL — dropping explicit operations is a fidelity violation):
10. Every explicit user operation must be preserved in the generated program.
    An explicit input/read/get operation (e.g. "get string s length 100", "读入n", "input x")
    MUST result in a concrete target-language input operation (scanf, fgets, etc.).
    Explicit operations MUST NOT be silently omitted, even if the translator thinks they are
    unnecessary or redundant.
11. Preserve dependency order: if operation B depends on data produced by operation A,
    A must occur before B in the generated code. Never read, inspect, measure, index,
    strlen, or otherwise use a value before the explicit operation that initializes or
    obtains that value. Uninitialized memory is a bug.
    Example — "get string s length 100" then "len = length of s" must become:
      (a) read/obtain s via an input function, then (b) compute strlen(s).
    It is NEVER correct to declare s[100] and call strlen(s) without first reading s.

Identifier preservation (CRITICAL — renaming user identifiers is a fidelity violation):
12. User-defined identifiers are explicit constraints. Preserve user-specified variable,
    function, type, parameter, field, and other identifier names exactly across translation
    unless the target language makes that identifier syntactically impossible.
13. Do NOT rename identifiers merely for style, readability, naming conventions,
    avoiding shadowing of built-ins, perceived clarity, or "better" target-language idioms.
14. If an identifier is legal but undesirable in the target language, preserve it anyway.
    A separate warning mechanism may exist in the future; translation must not silently rename.
15. Preserve identifier case exactly: n ≠ N, Max ≠ max, max ≠ Max.

Explicit data-flow preservation (CRITICAL — bypassing explicit intermediate state is a fidelity violation):
16. When the user explicitly specifies an intermediate assignment, subsequent read,
    or data-flow step, preserve that explicit operation and dependency.
17. Do not substitute an equivalent expression merely because the translator can
    prove or assume equivalence. Do not optimize away, merge, bypass, or rewrite
    explicit intermediate state.
18. Example: `s[i] = p; cnt[s[i]]++;` must preserve a later read from `s[i]`.
    It is NOT acceptable to silently rewrite it as `cnt[p]++;` even if s[i] equals p
    at that point.

Chinese keywords you must recognise:
  输入 / input   → scanf
  输出 / 打印     → printf
  循环           → for / while
  如果           → if
  否则           → else

Output rules:
- On success: output ONLY the C code. No markdown fences, no explanations.
- On ambiguity: output ONLY "AMBIGUITY: <reason>" on a single line.
- The C code must include necessary #include headers.
- Use C17 (not C99, not C11 extensions)."""


# ---------------------------------------------------------------------------
# Shared fidelity invariants — appended to every target-language prompt
# ---------------------------------------------------------------------------

_FIDELITY_BLOCK = """\
I/O invariants (CRITICAL — violating these causes Wrong Answer on judges):
- Input operations are silent by default. Reading/input instructions (scanf, 读入, input, etc.)
  MUST NOT generate prompts, labels, explanations, debug messages, or any other stdout output
  unless the user explicitly requested that output in the .p17 source.
- Only explicitly requested output operations (printf, 输出, print, etc.) may produce stdout.
- Do NOT add user-facing messages for convenience. No "Please enter...", no "请输入...", no prompts.
  The user's .p17 source is the complete specification of what stdout should contain.

Operation preservation (CRITICAL — dropping explicit operations is a fidelity violation):
- Every explicit user operation must be preserved in the generated program.
  An explicit input/read/get operation (e.g. "get string s length 100", "读入n", "input x")
  MUST result in a concrete target-language input operation.
  Explicit operations MUST NOT be silently omitted, even if the translator thinks they are
  unnecessary or redundant.
- Preserve dependency order: if operation B depends on data produced by operation A,
  A must occur before B in the generated code. Never read, inspect, measure, index,
  or otherwise use a value before the explicit operation that initializes or
  obtains that value. Uninitialized memory is a bug.

Chinese keywords you must recognise:
  输入 / input   → input
  输出 / 打印     → print
  循环           → for / while
  如果           → if
  否则           → else

Identifier preservation (CRITICAL — renaming user identifiers is a fidelity violation):
- User-defined identifiers are explicit constraints. Preserve user-specified variable,
  function, type, parameter, field, and other identifier names exactly across translation
  unless the target language makes that identifier syntactically impossible.
- Do NOT rename identifiers merely for style, readability, naming conventions,
  avoiding shadowing of built-ins, perceived clarity, or "better" target-language idioms.
- If an identifier is legal but undesirable in the target language, preserve it anyway.
  A separate warning mechanism may exist in the future; translation must not silently rename.
- Preserve identifier case exactly: n ≠ N, Max ≠ max, max ≠ Max.

Explicit data-flow preservation (CRITICAL — bypassing explicit intermediate state is a fidelity violation):
- When the user explicitly specifies an intermediate assignment, subsequent read,
  or data-flow step, preserve that explicit operation and dependency.
- Do not substitute an equivalent expression merely because the translator can
  prove or assume equivalence. Do not optimize away, merge, bypass, or rewrite
  explicit intermediate state.
- Example: `s[i] = p; cnt[s[i]]++;` must preserve a later read from `s[i]`.
  It is NOT acceptable to silently rewrite it as `cnt[p]++;` even if s[i] equals p
  at that point.

Translation fidelity:
- Do NOT reorder or merge user-specified execution steps for "optimization".
- Borrowed syntax must retain its original semantics.
- If there is genuine ambiguity that would change program behaviour, output exactly:
  AMBIGUITY: <short description>
  Do NOT guess. Do NOT generate code when ambiguous."""

PYTHON_SYSTEM_PROMPT = f"""\
You are a Protocol 17 (P17) to Python 3 translator. Translate the given .p17 source into valid, idiomatic Python 3 code.

Protocol 17 is a hybrid intent language. Users express program intent through a mix of:
- Natural language (Chinese / English)
- Mathematical expressions: f(x) = x^(1/2)
- Familiar programming symbols: int, float, {{}}, ()
- Code-like structures: if (cond) {{ ... }}, for (i from 1 to N) {{ ... }}
- Native code snippets

Translation rules:
1. User-specified code is authoritative — do NOT modify what the user explicitly wrote.
2. Unspecified implementation details may be completed by you.
3. The more specific the user code, the less freedom you have to change it.
4. If the user wrote native Python, validate and preserve it — do NOT rewrite.

{_FIDELITY_BLOCK}

Output rules:
- On success: output ONLY the Python 3 code. No markdown fences, no explanations.
- On ambiguity: output ONLY "AMBIGUITY: <reason>" on a single line.
- The code must include necessary imports."""

RUST_SYSTEM_PROMPT = f"""\
You are a Protocol 17 (P17) to Rust translator. Translate the given .p17 source into valid, compilable Rust code.

Protocol 17 is a hybrid intent language. Users express program intent through a mix of:
- Natural language (Chinese / English)
- Mathematical expressions: f(x) = x^(1/2)
- Familiar programming symbols: int, float, {{}}, ()
- Code-like structures: if (cond) {{ ... }}, for (i from 1 to N) {{ ... }}
- Native code snippets

Translation rules:
1. User-specified code is authoritative — do NOT modify what the user explicitly wrote.
2. Unspecified implementation details may be completed by you.
3. The more specific the user code, the less freedom you have to change it.
4. If the user wrote native Rust, validate and preserve it — do NOT rewrite.

Rust type-correctness and safety (CRITICAL — violating these produces broken code):
5. Generated Rust must be syntactically valid and type-correct. Every expression,
   function call, and assignment must satisfy Rust's type system.
6. Standard-input reading: `std::io::stdin().read_line(...)` requires `&mut String`,
   NOT `&mut i32` or any other numeric type. To read a numeric value, first read
   into a String buffer, then call `.trim().parse::<T>().unwrap()` (or equivalent
   valid Rust). Never call `.trim()` or other String methods on a numeric variable.
7. Array and slice indexing (`arr[i]`, `slice[i]`) requires an index of type `usize`
   or a type that implements `SliceIndex`. Non-usize indices (e.g. i32) must be
   explicitly converted: `arr[i as usize]`. Choose index variable types and
   conversions consistently throughout the program.
8. Choose variable types and conversions consistently. Do not declare a variable
   as i32 and later treat it as a String, or vice versa.
9. Do not use `unsafe` merely to avoid type issues. All Protocol 17 fidelity
   invariants must be preserved while making the implementation legal Rust.
10. Bounds and ownership: prefer Vec over raw arrays when sizes are dynamic.
    Stack arrays (`[T; N]`) are fine when the size is a compile-time constant.

{_FIDELITY_BLOCK}

Output rules:
- On success: output ONLY the Rust code. No markdown fences, no explanations.
- On ambiguity: output ONLY "AMBIGUITY: <reason>" on a single line.
- Generate a complete program with fn main().
- Use necessary use/import statements."""

TARGET_PROMPTS = {
    "c": SYSTEM_PROMPT,
    "python": PYTHON_SYSTEM_PROMPT,
    "rust": RUST_SYSTEM_PROMPT,
}


def _get_system_prompt(target: str) -> str:
    """Return the system prompt for a given target language."""
    prompt = TARGET_PROMPTS.get(target)
    if prompt is None:
        sys.exit(f"Unknown target language: {target}. Choose: c, python, rust")
    return prompt


# ---------------------------------------------------------------------------
# Reverse translation — source code → English + mathematical notation
# ---------------------------------------------------------------------------

REVERSE_SYSTEM_PROMPT = """\
You are a Code-to-English-and-Mathematical-Notation translator. Your task is to read source code and produce a clear, concise description of its behaviour.

Core principle: Free representation, fixed semantics.

You may freely choose English prose, mathematical notation, equations, sets, summations, logical notation, recurrence relations, etc. — whatever expresses the code most clearly and concisely.

However, you MUST describe the behaviour of the code as written. You must NOT:
- optimize the algorithm
- repair bugs
- describe what the programmer probably intended
- silently remove unusual behaviour
- invent assumptions not present in the code
- replace actual behaviour with a more conventional algorithm

Invariants:
1. Describe actual program behaviour, not intended behaviour.
2. Representation may change; semantics may not.
3. Mathematical compression is allowed only when semantically equivalent.
4. Preserve constants, initial states, conditions, boundaries, ordering, state updates, and observable I/O whenever they affect behaviour.
5. Do not silently fix bugs or suspicious logic.
6. Do not infer unstated programmer intent.
7. If the code has behaviour that cannot safely be summarised without losing semantics, use a more explicit explanation instead.

Output style:
- Explanatory prose must be in English.
- Mathematical notation is encouraged where it adds clarity.
- Identifiers and string literals from the source should be preserved as needed.
- Concise output is preferred over line-by-line paraphrasing.
- Output the description directly. No markdown fences, no preamble, no meta-commentary."""


def _strip_markdown_fences(content: str) -> str:
    """Strip ``` fences if the model wrapped its output."""
    if content.startswith("```"):
        lines = content.splitlines()
        if len(lines) >= 2 and lines[-1].strip() == "```":
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        content = "\n".join(lines).strip()
    return content


def reverse_translate(source_code: str) -> str:
    """Send source code to the AI model, return English + math description.

    Raises SystemExit on provider or API failure.
    """
    from providers import get_provider

    model = os.environ.get("P17_MODEL", "gpt-4o")

    try:
        provider = get_provider()
        content = provider.chat_completion(
            REVERSE_SYSTEM_PROMPT, source_code, model
        )
    except RuntimeError as exc:
        sys.exit(str(exc))

    return _strip_markdown_fences(content)


def translate(p17_source: str, target: str = "c") -> str:
    """Send .p17 source to the AI model, return generated target-language code.

    target is one of: c, python, rust.  Defaults to c (C17) for backward
    compatibility.

    Raises SystemExit on provider or API failure.
    """
    from providers import get_provider

    model = os.environ.get("P17_MODEL", "gpt-4o")
    system_prompt = _get_system_prompt(target)

    try:
        provider = get_provider()
        content = provider.chat_completion(system_prompt, p17_source, model)
    except RuntimeError as exc:
        sys.exit(str(exc))

    return _strip_markdown_fences(content)


# Backward-compatible alias
def translate_to_c(p17_source: str) -> str:
    """Legacy entry point — translate to C17.  Kept for compatibility."""
    return translate(p17_source, target="c")


# ---------------------------------------------------------------------------
# Compile & run
# ---------------------------------------------------------------------------

def compile_and_run(
    c_source: str,
    build_dir: Path,
    *,
    input_data: str | None = None,
    no_run: bool = False,
) -> int:
    """Write C source to build_dir, compile with gcc, and optionally run.

    Returns the process exit code.
    """
    build_dir.mkdir(parents=True, exist_ok=True)

    c_path = build_dir / "program.c"
    bin_path = build_dir / "program"

    c_path.write_text(c_source)

    # Compile -----------------------------------------------------------
    compile_result = subprocess.run(
        [
            "gcc", "-std=c17", "-Wall", "-Wextra", "-Werror=implicit-function-declaration",
            "-o", str(bin_path), str(c_path),
        ],
        capture_output=True, text=True,
    )

    if compile_result.returncode != 0:
        print("Compilation failed:")
        print(compile_result.stderr)
        print(f"\nGenerated C preserved at {c_path}")
        return compile_result.returncode

    print("Compilation succeeded.")

    if no_run:
        return 0

    # Run ----------------------------------------------------------------
    print("Running...")
    run_kwargs: dict = {"capture_output": True, "text": True}
    if input_data is not None:
        run_kwargs["input"] = input_data

    run_result = subprocess.run([str(bin_path)], **run_kwargs)  # type: ignore[arg-type]

    if run_result.stdout:
        print(run_result.stdout, end="")
    if run_result.stderr:
        print(run_result.stderr, end="", file=sys.stderr)

    return run_result.returncode


# ---------------------------------------------------------------------------
# Target verification — deterministic syntax/type checking
# ---------------------------------------------------------------------------

def verify_c(source_path: str) -> tuple[bool, str, bool]:
    """Verify C source with gcc -fsyntax-only (no code generation).

    Returns (passed, diagnostics, tool_available).
    """
    if shutil.which("gcc") is None:
        return (False, "Verification unavailable: gcc not found", False)

    result = subprocess.run(
        ["gcc", "-std=c17", "-fsyntax-only", source_path],
        capture_output=True, text=True,
    )
    passed = result.returncode == 0
    diagnostics = result.stderr.strip() if result.stderr else result.stdout.strip()
    return (passed, diagnostics, True)


def verify_rust(source_path: str) -> tuple[bool, str, bool]:
    """Verify Rust source with rustc --emit=metadata (type-checking, no binary).

    Returns (passed, diagnostics, tool_available).
    """
    if shutil.which("rustc") is None:
        return (False, "Verification unavailable: rustc not found", False)

    with tempfile.TemporaryDirectory() as tmpdir:
        out_meta = os.path.join(tmpdir, "p17_verify.rmeta")
        result = subprocess.run(
            [
                "rustc", "--edition", "2021", "--emit=metadata",
                "--crate-name", "p17_verify", "-o", out_meta,
                source_path,
            ],
            capture_output=True, text=True,
        )
    passed = result.returncode == 0
    diagnostics = result.stderr.strip() if result.stderr else result.stdout.strip()
    return (passed, diagnostics, True)


def verify_python(source_path: str) -> tuple[bool, str, bool]:
    """Verify Python source via compile() — syntax check without execution.

    Returns (passed, diagnostics, tool_available).
    Python is always available (we are running on it), so tool_available is
    always True.
    """
    try:
        source = Path(source_path).read_text()
        compile(source, source_path, "exec")
        return (True, "", True)
    except SyntaxError as exc:
        return (False, str(exc), True)


def verify_target(source_path: str, target: str) -> tuple[bool, str, bool]:
    """Dispatch to the appropriate per-target verifier.

    Returns (passed, diagnostics, tool_available).
    """
    verifiers = {
        "c": verify_c,
        "python": verify_python,
        "rust": verify_rust,
    }
    verifier = verifiers.get(target)
    if verifier is None:
        return (False, f"Verification unavailable: unknown target '{target}'", False)
    return verifier(source_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Protocol 17 — translate .p17 to C17, compile, and run",
    )
    parser.add_argument(
        "file", nargs="?", default=None,
        help="Path to a .p17 source file",
    )
    parser.add_argument(
        "--input", "-i", default=None,
        help="Input data fed to stdin of the compiled program",
    )
    parser.add_argument(
        "--no-run", action="store_true",
        help="Translate and compile, but do not execute",
    )
    parser.add_argument(
        "--build-dir", default="build",
        help="Directory for generated C and binary (default: build/)",
    )
    parser.add_argument(
        "--reverse", action="store_true",
        help="Reverse mode: translate source code to English + mathematical notation (no compile/run)",
    )
    parser.add_argument(
        "--target", default="c", choices=["c", "python", "rust"],
        help="Target language for translation (default: c). Python/Rust are translate-only.",
    )
    parser.add_argument(
        "--translate-only", action="store_true",
        help="Translate only — do not compile or execute the generated code",
    )
    parser.add_argument(
        "--verify-file", default=None,
        help="Verify an already-generated target file without translation (use with --target)",
    )
    args = parser.parse_args()

    # ------------------------------------------------------------------
    # Verification-only mode — no API key, no model, no translation
    # ------------------------------------------------------------------
    if args.verify_file:
        verify_path = Path(args.verify_file)
        if not verify_path.exists():
            print(f"Error: file not found — {args.verify_file}", file=sys.stderr)
            sys.exit(2)

        passed, diagnostics, tool_available = verify_target(
            str(verify_path), args.target
        )

        if not tool_available:
            print(diagnostics, file=sys.stderr)
            sys.exit(2)

        if diagnostics:
            print(diagnostics, file=sys.stderr)

        if passed:
            print(f"VERIFIED: {args.verify_file} ({args.target})", file=sys.stderr)
            sys.exit(0)
        else:
            print(
                f"VERIFICATION FAILED: {args.verify_file} ({args.target})",
                file=sys.stderr,
            )
            sys.exit(1)

    # Require a source file when not in verify-only mode
    if args.file is None:
        print(
            "Error: a .p17 source file is required (or use --verify-file for verification-only mode).",
            file=sys.stderr,
        )
        sys.exit(2)

    # Read .p17 source ---------------------------------------------------
    p17_path = Path(args.file)
    if not p17_path.exists():
        sys.exit(f"Error: file not found — {args.file}")

    p17_source = p17_path.read_text().strip()
    if not p17_source:
        sys.exit(f"Error: empty file — {args.file}")

    # Reverse mode -------------------------------------------------------
    if args.reverse:
        description = reverse_translate(p17_source)
        print(description)
        return

    # Translate ----------------------------------------------------------
    print(f"Translating {args.file} …", file=sys.stderr)
    c_source = translate(p17_source, target=args.target)

    if c_source.startswith("AMBIGUITY:") or c_source.startswith("ambiguity:"):
        print(f"Protocol 17 ambiguity detected — {c_source}")
        print("No code generated. Please resolve the ambiguity in the .p17 source.")
        sys.exit(1)

    # Translate-only mode: print generated code and exit -----------------
    if args.translate_only or args.target != "c":
        print(c_source)
        return

    # Compile & run ------------------------------------------------------
    build_dir = Path(args.build_dir)
    exit_code = compile_and_run(
        c_source, build_dir,
        input_data=args.input, no_run=args.no_run,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
