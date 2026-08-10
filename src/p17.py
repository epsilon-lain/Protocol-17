#!/usr/bin/env python3
"""Protocol 17 CLI — Translate .p17 source to C17, compile, and run.
Also supports reverse mode: translate source code to English + mathematical notation.

Usage:
    export P17_API_URL="https://api.openai.com/v1"
    export P17_API_KEY="sk-..."
    export P17_MODEL="gpt-4o"          # optional, defaults to gpt-4o

    python src/p17.py examples/001-add.p17
    python src/p17.py examples/001-add.p17 --input "1 1"
    python src/p17.py examples/001-add.p17 --no-run
    python src/p17.py examples/reverse/001-sum.c --reverse
"""

import argparse
import os
import subprocess
import sys
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


def reverse_translate(source_code: str) -> str:
    """Send source code to the AI model, return English + math description.

    Raises RuntimeError on API failure.
    """
    try:
        from openai import OpenAI
    except ImportError:
        sys.exit(
            "Missing dependency: openai.  Install with:\n"
            "  pip install -r requirements.txt"
        )

    api_url = os.environ.get("P17_API_URL", "")
    api_key = os.environ.get("P17_API_KEY", "")
    model = os.environ.get("P17_MODEL", "gpt-4o")

    if not api_url or not api_key:
        sys.exit(
            "Environment variables P17_API_URL and P17_API_KEY must be set.\n"
            "Example:\n"
            '  export P17_API_URL="https://api.openai.com/v1"\n'
            '  export P17_API_KEY="sk-..."'
        )

    client = OpenAI(base_url=api_url, api_key=api_key)

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": REVERSE_SYSTEM_PROMPT},
                {"role": "user", "content": source_code},
            ],
            temperature=0.1,
        )
    except Exception as exc:
        sys.exit(f"AI API call failed: {exc}")

    content = response.choices[0].message.content.strip()

    # Strip markdown fences if the model wrapped the output
    if content.startswith("```"):
        lines = content.splitlines()
        if lines[-1].strip() == "```":
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        content = "\n".join(lines).strip()

    return content


def translate(p17_source: str) -> str:
    """Send .p17 source to the AI model, return the generated C code.

    Raises RuntimeError on ambiguity or API failure.
    """
    try:
        from openai import OpenAI
    except ImportError:
        sys.exit(
            "Missing dependency: openai.  Install with:\n"
            "  pip install -r requirements.txt"
        )

    api_url = os.environ.get("P17_API_URL", "")
    api_key = os.environ.get("P17_API_KEY", "")
    model = os.environ.get("P17_MODEL", "gpt-4o")

    if not api_url or not api_key:
        sys.exit(
            "Environment variables P17_API_URL and P17_API_KEY must be set.\n"
            "Example:\n"
            '  export P17_API_URL="https://api.openai.com/v1"\n'
            '  export P17_API_KEY="sk-..."'
        )

    client = OpenAI(base_url=api_url, api_key=api_key)

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": p17_source},
            ],
            temperature=0.1,
        )
    except Exception as exc:
        sys.exit(f"AI API call failed: {exc}")

    content = response.choices[0].message.content.strip()

    # Strip markdown code fences if the model ignored our instruction
    if content.startswith("```"):
        lines = content.splitlines()
        # Remove opening fence (```c or ```) and closing fence (```)
        if lines[-1].strip() == "```":
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        content = "\n".join(lines).strip()

    return content


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
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Protocol 17 — translate .p17 to C17, compile, and run",
    )
    parser.add_argument(
        "file", help="Path to a .p17 source file",
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
    args = parser.parse_args()

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
    print(f"Translating {args.file} …")
    c_source = translate(p17_source)

    if c_source.startswith("AMBIGUITY:") or c_source.startswith("ambiguity:"):
        print(f"Protocol 17 ambiguity detected — {c_source}")
        print("No code generated. Please resolve the ambiguity in the .p17 source.")
        sys.exit(1)

    # Compile & run ------------------------------------------------------
    build_dir = Path(args.build_dir)
    exit_code = compile_and_run(
        c_source, build_dir,
        input_data=args.input, no_run=args.no_run,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
