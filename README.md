# Protocol 17

An experimental AI-constrained programming protocol.

```
P17 source  →  provider adapter  →  user-selected model  →  C17 / Python 3 / Rust  →  target verification  →  PASS / FAILED
```

---

## Example

**Write** (`examples/001-add.p17`):

```c
int a,b
input(a,b)
输出(a+b)
```

**Get** (C17):

```c
#include <stdio.h>

int main(void) {
    int a, b;
    scanf("%d %d", &a, &b);
    printf("%d\n", a + b);
    return 0;
}
```

**Or** (Python 3):

```python
a = int(input())
b = int(input())
print(a + b)
```

**Run:**

```bash
python src/p17.py examples/001-add.p17 --input "1 1"
# → 2
```

---

## Core idea

Protocol 17 sits between human intent and traditional programming languages.
You express what you want through a mix of:

- natural language (Chinese / English)
- mathematical notation: `f(x) = x^(1/2)`
- familiar programming symbols: `int`, `float`, `{}`, `()`
- code-like structures: `if (cond) { ... }`, `for (i from 1 to N) { ... }`
- native target-language snippets

The central ownership rule:

| User writes | AI may fill |
|---|---|
| Explicit constraints | Unspecified details |

> **AI can fill the blanks.**
> **AI cannot take the pen.**

User-specified details are authoritative and must be preserved exactly.
What the user leaves unspecified is implementation freedom for the AI.

Protocol 17 is **not**:

- merely natural-language-to-code
- "Chinese C"
- a claim that LLM generation is reliable
- a finished programming language
- a replacement for compilers

---

## Pipeline

```
                             ┌──────────────────────┐
 .p17 source ──────────────▶ │   provider adapter    │
                             │ (openai-compatible /  │
                             │  anthropic / gemini)  │
                             └──────────┬───────────┘
                                        │
                         ┌──────────────┼──────────────┐
                         ▼              ▼              ▼
                       C17          Python 3         Rust
                         │              │              │
                         └──────────────┼──────────────┘
                                        ▼
                             ┌──────────────────────┐
                             │  Target verification  │
                             │  (deterministic)      │
                             └──────────┬───────────┘
                                        │
                              ┌─────────┴─────────┐
                              ▼                   ▼
                           PASS               FAILED
```

### Forward translation

| Source | Targets |
|---|---|
| `.p17` | C17 (compile + run), Python 3 (translate + verify), Rust (translate + verify) |

### Reverse translation

Read source code and produce an English + mathematical notation description
of its behaviour. Core principle: **free representation, fixed semantics**.

---

## Generated ≠ Verified

A model can return code. Protocol 17 does not treat invalid target code as
verified.

**Real example from development.** A local Qwen 4B model produced this Rust:

```rust
let mut n: i32 = 0;
std::io::stdin().read_line(&mut n).unwrap();  // ❌ read_line needs &mut String
n = n.trim().parse::<i32>().unwrap();          // ❌ .trim() on i32
```

This is invalid Rust — `read_line` requires `&mut String`, and `.trim()` is
not defined on `i32`.

The deterministic verification layer catches this using `rustc` and surfaces
the diagnostics, rather than silently accepting or repairing broken output.

### Target verification (implemented)

```
Is the target code valid?
```

| Target | Method |
|---|---|
| C17 | `gcc -std=c17 -fsyntax-only` |
| Python 3 | `compile(..., 'exec')` — no execution |
| Rust | `rustc --emit=metadata` — full type + borrow checking |

If a toolchain is unavailable, the verifier reports it clearly rather than
pretending verification passed.

### Fidelity verification (not yet implemented)

```
Is the target code faithful to the user's constraints?
```

Target verification checks whether generated code compiles.
It does **not** check whether the generated program preserves the user's
explicit constraints.

**Example.** A `.p17` source writes:

```c
for i in 1..n
```

If the user intended borrowed Rust range semantics, a model might produce:

```rust
for i in 1..=n   // changed semantics but compiles fine
```

Target verification would accept this — the Rust is valid.
Only a fidelity verifier could detect that the loop bound changed.

**Another example:**

```c
s[i] = p;
cnt[s[i]]++;
```

A model might silently rewrite this as:

```c
s[i] = p;
cnt[p]++;       // bypasses the explicit intermediate read
```

Again, compiles fine. Again, not faithful.

Fidelity verification is a future layer that checks whether generated code
respects the user's explicit constraints — not just whether it type-checks.

---

## Bring Your Own Model

Protocol 17 is not tied to any specific model, provider, or vendor.
You choose your provider, model, API endpoint, and credentials.

The provider adapter translates between Protocol 17's internal interface and
the provider-specific API. Provider formats never leak into fidelity rules,
verification, or compiler logic.

| Adapter | `P17_PROVIDER` | SDK |
|---|---|---|
| OpenAI-compatible | `openai-compatible` (default) | `openai` |
| Anthropic (Claude) | `anthropic` | `anthropic` |
| Google Gemini | `gemini` | `google-genai` |

The `openai-compatible` adapter works with OpenAI, Ollama, LM Studio,
DeepSeek, OpenRouter, and any endpoint that speaks the OpenAI chat
completions API.

---

## Installation

### Prerequisites

- Python 3.10+
- gcc (for C17 compile + run)
- rustc (optional, for Rust target verification)

### 1. Clone and install dependencies

```bash
git clone https://github.com/epsilon-lain/Protocol-17.git && cd Protocol-17
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure a provider

Protocol 17 is provider-agnostic — you bring your own model and credentials.

```bash
cp .p17.env.example .p17.env
```

**Supported providers:**

| Provider | Config |
|---|---|
| `openai-compatible` (default) | `P17_API_URL` + `P17_API_KEY` + `P17_MODEL` |
| `anthropic` | `P17_API_KEY` + `P17_MODEL` |
| `gemini` | `P17_API_KEY` + `P17_MODEL` |

The `openai-compatible` provider works with any OpenAI-compatible endpoint:
OpenAI, Ollama, LM Studio, DeepSeek, OpenRouter, local servers.

**Example — local Ollama:**

```bash
P17_PROVIDER=openai-compatible
P17_API_URL=http://localhost:11434/v1
P17_API_KEY=ollama
P17_MODEL=qwen3:4b-instruct
```

**Example — Anthropic:**

```bash
P17_PROVIDER=anthropic
P17_API_KEY=sk-ant-...
P17_MODEL=claude-sonnet-5-20251001
```

`P17_PROVIDER` defaults to `openai-compatible` when not set, for backward
compatibility.

`.p17.env` is git-ignored by default and should not be committed.

Precedence: `.p17.env` values override shell environment variables, because
they are explicit for this workspace.

### 3. Quick start

```bash
# Translate, compile, and run (C17)
python src/p17.py examples/001-add.p17 --input "1 1"

# Translate only (Python 3)
python src/p17.py examples/001-add.p17 --target python --translate-only

# Translate only (Rust)
python src/p17.py examples/001-add.p17 --target rust --translate-only

# Verify already-generated code
python src/p17.py --verify-file generated.rs --target rust

# Reverse: describe code in English + math
python src/p17.py examples/reverse/001-sum.c --reverse
```

### 4. VS Code extension (optional)

```bash
cd vscode-extension
npx @vscode/vsce package
```

Then in VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...` →
select `protocol-17-0.1.0.vsix`.

Features:

- Syntax highlighting for `.p17` files
- **Translate** — AI translation to the selected target language
- **Explain** — reverse-translate code to English + math
- **Run** — compile and execute (C17 only)
- **Target selector** — status-bar toggle: C17 / Python 3 / Rust
- **Target verification** — runs automatically after Translate
- **Configure Model** — guided setup via Command Palette (no manual `.p17.env` editing)
- **Test Model Connection** — verify provider/model responds before translating
- **Protocol 17 Output Channel** — errors, diagnostics, verification results

The extension never silently saves or mutates your source document.

#### VS Code Model Configuration

Run **Protocol 17: Configure Model** from the Command Palette
(`Ctrl+Shift+P`). The command guides you through:

1. **Provider** — select OpenAI-compatible, Anthropic, or Gemini
2. **Model** — enter the model name/ID
3. **API URL** — (OpenAI-compatible only) the API base URL
4. **API Key** — password-masked input, stored securely

**API keys are stored with VS Code SecretStorage** — they are never
written to `settings.json`, never written to `.p17.env`, never logged to
the Output Channel, and never included in error messages.

SecretStorage itself is global to the extension (not per-workspace), so
Protocol 17 explicitly namespaces secrets per workspace using a stable
hash derived from the workspace URI. A key configured in one workspace
will never accidentally override `.p17.env` in another workspace.

After configuration, a status bar item shows your current model
(`P17: qwen3:4b-instruct`). Click it to reconfigure.

Optionally run **Protocol 17: Test Model Connection** to verify the
configured provider and model can respond before translating.

#### Configuration precedence

| Priority | Source | What |
|---|---|---|
| 1 (highest) | SecretStorage | `P17_API_KEY` (when configured via VS Code) |
| 2 | VS Code workspace state | `P17_PROVIDER`, `P17_MODEL`, `P17_API_URL` |
| 3 | `.p17.env` | All `P17_*` variables |
| 4 (lowest) | Extension Host `process.env` | Shell environment |

VS Code configured values override `.p17.env` values for the same keys.
The SecretStorage API key overrides `P17_API_KEY` from `.p17.env` only
when you have explicitly configured a key through the extension UI.

If no VS Code configuration exists, `.p17.env` behaviour is unchanged.

#### `.p17.env` backward compatibility

`.p17.env` is still fully supported for CLI usage and for users who
prefer file-based configuration. If you already have a working
`.p17.env`, the extension will use those values unless you explicitly
override them through **Configure Model**.

Example existing setup continues to work:

```bash
P17_PROVIDER=openai-compatible
P17_API_URL=http://localhost:11434/v1
P17_API_KEY=ollama
P17_MODEL=qwen3:4b-instruct
```

---

## CLI reference

```
python src/p17.py [--target {c,python,rust}] [file] [options]
```

| Flag | Description |
|---|---|
| `file` | Path to a `.p17` source file |
| `--target {c,python,rust}` | Target language (default: `c`) |
| `--input`, `-i` | Stdin data for the compiled program |
| `--no-run` | Compile only, do not execute |
| `--translate-only` | Print generated code, skip compile/run |
| `--reverse` | Reverse mode: code → English + math |
| `--build-dir` | Output directory (default: `build/`) |
| `--verify-file` | Verify already-generated code without calling the model |
| `--verify-file` + `--target` | Select target for verification |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success / verified |
| 1 | Translation failure / ambiguity / verification failed |
| 2 | Verifier or toolchain unavailable |

---

## Project layout

```
src/p17.py              CLI tool — translate, verify, compile, run
examples/               .p17 example sources (and reverse examples)
build/                  generated code and binaries (git-ignored)
tests/                  Python test suite
vscode-extension/       VS Code extension
.p17.env.example        environment template (safe to commit)
.p17.env                your credentials (git-ignored)
```

---

## Current invariants

Protocol 17 translation obeys these constraints (enforced via system prompts):

| Invariant | What it means |
|---|---|
| **Silent input** | Reading input produces no prompts, labels, or debug output |
| **Operation preservation** | Every explicit user operation is preserved; no silent omission |
| **Identifier preservation** | User identifiers are never renamed for style or convention |
| **Data-flow preservation** | Explicit intermediate reads/writes are not bypassed |
| **User code is authoritative** | What the user wrote explicitly is not rewritten |
| **Borrowed syntax semantics** | Borrowed syntax retains its original semantics |

The Rust target additionally requires:

| Rule | What it means |
|---|---|
| Type correctness | Generated Rust must satisfy the type system |
| Valid stdin | `read_line` requires `&mut String`, not `&mut i32` |
| usize indexing | Array/slice indexing must use `usize`-compatible indices |
| No unsafe | `unsafe` must not be used to avoid type issues |

---

## Experimental status

Protocol 17 is an **experimental alpha**. Expect rough edges.

**Implemented:**

- Forward translation: P17 → C17 / Python 3 / Rust
- Reverse translation: code → English + mathematical notation
- Deterministic target verification (C17, Python 3, Rust)
- C17 compile + run
- Python 3 and Rust translate + verify
- VS Code dual-pane prototype with syntax highlighting
- Local and cloud OpenAI-compatible model support
- Source document is never silently rewritten

**Not yet implemented:**

- Formal syntax specification
- Parser / AST / IR
- Protocol 17 fidelity verification (target code may compile but not be faithful)
- Python/Rust execution
- Multi-file projects
- Incremental translation
- Language Server Protocol (LSP)
- Source maps
- AI autocomplete

Syntax, behaviour, and protocol rules **may change** between versions without
notice.

---

## License

MIT
