# Protocol 17

**Protocol 17** is an AI-constrained protocol layer that sits between human
program intent and traditional programming languages.

Users express intent through a mix of natural language, math, familiar
programming symbols, and native code.  Protocol 17 translates this into
compilable C17.

Currently this is an **exploratory prototype** — the protocol rules are
discovered by solving small programming problems, not designed up-front.

## Quick start

### 1.  Install dependencies

```bash
pip install -r requirements.txt
```

### 2.  Set API credentials

Protocol 17 uses any OpenAI-compatible API.

```bash
export P17_API_URL="https://api.openai.com/v1"
export P17_API_KEY="sk-..."
export P17_MODEL="gpt-4o"          # optional; defaults to gpt-4o
```

### 3.  Write a .p17 source file

```c
int a,b
input(a,b)
输出(a+b)
```

### 4.  Translate, compile & run

```bash
python src/p17.py examples/001-add.p17 --input "1 1"
# → 2
```

## Options

| Flag | Description |
|---|---|
| `--input`, `-i` | Stdin data for the compiled program |
| `--no-run` | Stop after compilation (do not execute) |
| `--build-dir` | Output directory (default: `build/`) |

## Project layout

```
src/p17.py          CLI tool
examples/           .p17 example sources
build/              generated C and binaries (git-ignored)
tests/              minimal tests
```

## Current limitations (MVP)

- C17 target only.
- No parser — translation is entirely AI-driven.
- Protocol 17 rules are embedded in the AI system prompt, not in a separate
  specification engine.
- No multi-file projects.
- No incremental compilation.
- No formal grammar or IR.
