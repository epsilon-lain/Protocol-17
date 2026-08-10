#!/usr/bin/env python3
"""Protocol 17 CLI — Translate .p17 source to C17, compile, and run.

Usage:
    export P17_API_URL="https://api.openai.com/v1"
    export P17_API_KEY="sk-..."
    export P17_MODEL="gpt-4o"          # optional, defaults to gpt-4o

    python src/p17.py examples/001-add.p17
    python src/p17.py examples/001-add.p17 --input "1 1"
    python src/p17.py examples/001-add.p17 --no-run
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
    args = parser.parse_args()

    # Read .p17 source ---------------------------------------------------
    p17_path = Path(args.file)
    if not p17_path.exists():
        sys.exit(f"Error: file not found — {args.file}")

    p17_source = p17_path.read_text().strip()
    if not p17_source:
        sys.exit(f"Error: empty file — {args.file}")

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
