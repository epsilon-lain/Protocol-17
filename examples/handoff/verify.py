from pathlib import Path

from app import add


failures = []
for line in Path("cases.txt").read_text(encoding="utf-8").strip().splitlines():
    a, b, expected = line.split()
    actual = add(int(a), int(b))
    if str(actual) != expected:
        failures.append(f"add({a}, {b}) == {actual}, expected {expected}")

if failures:
    print("\n".join(failures))
    raise SystemExit(1)

print("PASS")
