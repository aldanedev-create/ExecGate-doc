# 01 — Install

Install ExecGate, verify it imports, and see why the core has zero runtime dependencies.

**Time:** 2 minutes.

---

## Install the core

```bash
pip install execgate
```

That's it. The core package has **no third-party runtime dependencies** — not Pydantic, not any AI SDK, not FastMCP. Just the Python standard library.

If you want to verify:

```bash
pip show logiq
```

You'll see `Requires:` with an empty value. That's the whole dependency tree.

---

## Verify the import

```bash
python -c "from execgate import Logix; print(Logix)"
```

Expected output:

```text
<class 'execgate.engine.Logix'>
```

If you see that, you're set. If you get `ModuleNotFoundError`, check:

- The install succeeded (`pip list | grep logiq`).
- You're in a virtual environment where `logiq` is installed.

---

## Try running a plan that doesn't exist

```python
from execgate import Logix

logix = Logix()
result = logix.run({"call": "add", "with": {"a": 1, "b": 2}})

print(result.ok)
print(result.errors)
```

Expected output:

```text
False
(Error(code='UNKNOWN_CAPABILITY', message="unknown capability: 'add'",
       path=None, details={}),)
```

That's not a bug. It's the boundary working. You ran a plan that names a capability `add` — but nothing is registered yet. ExecGate rejects the plan with `UNKNOWN_CAPABILITY` **before any handler could run**. Nothing happened.

The next file registers a capability and shows the other side: a plan that names a real capability runs.

---

## Optional extras

The core is complete on its own. Three optional extras add integration layers:

```bash
pip install "execgate[pydantic]"  # Use Pydantic models as capability schemas
pip install "execgate[ai]"        # Provider-specific catalog formatting
pip install "execgate[mcp]"       # MCP server and proxy modes
```

Each is a **leaf node**. It sits outside the trust boundary, translates in and out, and never touches the verifier or executor. Installing `logiq` alone is a complete install for most use cases.

You'll install one of them later, when you reach the file that needs it. Not now.

---

## The "zero dependencies" guarantee

This is a real property, not a marketing claim. It's enforced by a test:

```bash
pytest tests/pydantic/test_core_without_pydantic.py
```

The test simulates the absence of Pydantic (and FastMCP) and asserts that:

- `import execgate` works.
- `Logix()` constructs.
- Capabilities register and run.
- Importing `execgate_pydantic` raises `ImportError` with a helpful message.

If someone ever adds a `pip install requests` to the core, this test fails and the release is blocked. The `scripts/check_imports.py` script enforces the same property by AST-scanning `src/logiq/` for non-stdlib imports.

Why does this matter? Because:

- **Deployment is simple.** No conflicting transitive dependencies.
- **Audit is simple.** The core's dependency tree is empty; nothing to scan, nothing to patch.
- **The core's design is forced to be honest.** If a feature would require a dependency, it goes in an adapter, not the core.

---

## Python version

ExecGate requires Python **3.11 or later**. It uses:

- `sys.stdlib_module_names` (3.10+).
- `typing.get_type_hints` modern behavior.
- The `X | Y` type-union syntax (3.10+).

If you're on 3.10 or lower, you'll get a clear install error. Upgrade.

---

## What's next

You've installed ExecGate and seen the boundary reject an unknown capability. The next file registers a capability and shows the other side.

→ [`02-first-capability.md`](02-first-capability.md)
