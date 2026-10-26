# Writing an Adapter

A ExecGate provider adapter is approximately 30 lines of pure translation. This walkthrough builds one end-to-end and shows how to test it against the conformance kit.

For the design rule behind adapters, see ADR-0006. For the full `ProviderAdapter` protocol, see `docs/ai-integration.md` §4.

---

## 1. What an adapter is

An adapter translates between:

- **Out:** `ToolSpec` (from `logix.tools.describe()`) → the provider's tool-definition shape.
- **In:** The provider's response → a neutral plan dictionary (`{"call": ..., "with": ...}`).

Two methods:

```python
class ProviderAdapter(Protocol):
    name: str

    def format_tools(self, specs: list[ToolSpec]) -> Any: ...
    def parse_proposal(self, raw: Any) -> dict[str, Any]: ...
```

That is the entire contract. An adapter cannot call `verify`, cannot construct a `VerifiedPlan`, and cannot touch the registry. Its job is translation.

---

## 2. The 30-line adapter

Suppose your provider sends tools like this:

```json
{
  "functions": [
    {
      "fn_name": "get_order",
      "fn_desc": "Retrieve an order.",
      "args": {}
    }
  ]
}
```

And responds like this:

```json
{
  "picked": {
    "fn_name": "get_order",
    "fn_args": {
      "order_id": 502
    }
  }
}
```

Create `src/execgate_ai/providers/example.py`:

```python
"""Example adapter for a fictional provider."""

from __future__ import annotations

from typing import Any

from execgate_ai.base import AdapterError, ToolSpec


class ExampleAdapter:
    """Adapter for a fictional provider."""

    name = "example"

    def format_tools(self, specs: list[ToolSpec]) -> list[dict[str, Any]]:
        return [
            {
                "fn_name": spec.name,
                "fn_desc": spec.description,
                "args": spec.input_schema,
            }
            for spec in specs
        ]

    def parse_proposal(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or "picked" not in raw:
            raise AdapterError("expected a dict with a 'picked' key")

        picked = raw["picked"]
        if not isinstance(picked, dict):
            raise AdapterError("'picked' must be an object")

        name = picked.get("fn_name")
        args = picked.get("fn_args", {})

        if not isinstance(name, str) or not name:
            raise AdapterError("'picked.fn_name' must be a non-empty string")

        if not isinstance(args, dict):
            raise AdapterError("'picked.fn_args' must be an object")

        return {"call": name, "with": args}
```

That's a complete adapter. It handles:

- Empty catalogs (returns `[]`).
- Non-list specs (not expected; iteration over `specs` is otherwise total).
- Missing `picked` → `AdapterError`.
- Non-dictionary `picked` → `AdapterError`.
- Missing or empty `fn_name` → `AdapterError`.
- Non-dictionary `fn_args` → `AdapterError`; absent `fn_args` defaults to an empty dictionary.

Every failure mode raises `AdapterError`, which the application translates to `INVALID_PLAN` or drops. It never returns a malformed plan.

---

## 3. Register it

Add an entry to `src/execgate_ai/registry.py::_PROVIDERS`:

```python
_PROVIDERS: dict[str, tuple[str, str]] = {
    "openai": ("execgate_ai.providers.openai", "OpenAIAdapter"),
    "anthropic": ("execgate_ai.providers.anthropic", "AnthropicAdapter"),
    "gemini": ("execgate_ai.providers.gemini", "GeminiAdapter"),
    "local": ("execgate_ai.providers.local", "LocalAdapter"),
    "example": ("execgate_ai.providers.example", "ExampleAdapter"),  # New
}
```

Now `logix.tools.format("example")` resolves to your adapter. Unknown providers still fall back to the neutral format — the entry is additive.

---

## 4. Write the conformance test

Create `tests/adapters/test_example.py`:

```python
from execgate_ai.providers.example import ExampleAdapter
from tests.adapters.contract import AdapterContractMixin


class TestExampleAdapter(AdapterContractMixin):
    def make_adapter(self):
        return ExampleAdapter()

    def sample_proposal(self):
        return {
            "picked": {
                "fn_name": "get_order",
                "fn_args": {"order_id": 502},
            }
        }
```

That's it. The mixin in `tests/adapters/contract.py` inherits approximately 10 tests that enforce the adapter's contract:

- `format_tools([])` does not raise.
- `format_tools(SAMPLE_SPECS)` names every capability.
- `format_tools(SAMPLE_SPECS)` includes every argument name.
- `format_tools(SAMPLE_SPECS)` is JSON-serializable.
- `parse_proposal(sample)` returns a plain dictionary equal to the expected plan.
- `parse_proposal([1, 2, 3])` raises `AdapterError`.
- `parse_proposal(None)` raises `AdapterError`.
- `parse_proposal(42)` raises `AdapterError`.
- A smuggled `"verified": true` cannot reach `plans.parse`.
- The adapter exposes no trust-boundary attributes.

Run:

```bash
pytest tests/adapters/test_example.py -v
```

If any test fails, the adapter is rejected — even if it works against a live provider today.

---

## 5. What the mixin does not check

The mixin verifies the contract. It does not verify the provider's wire format. That's your test's job.

Add provider-specific tests for:

- The exact shape of a real response, based on the provider's documentation.
- A response with no tool call, which must raise `AdapterError` rather than return a malformed plan.
- Edge cases: empty arguments, arguments as a string versus a dictionary, and error responses with no usable data.

These tests document the provider's actual behavior. The mixin ensures you don't forget the invariants; your tests ensure the format is correct.

---

## 6. Common mistakes

### Forgetting to raise `AdapterError`

```python
def parse_proposal(self, raw):
    if "picked" not in raw:
        return {}  # BAD
    ...
```

An empty dictionary flows through `logix.run({})`, which returns:

`INVALID_PLAN: plan must have either 'call' or 'steps'.`

That works, but the error is confusing — it describes the plan shape, not the adapter. Raise `AdapterError` with a message that explains what was wrong.

### Returning a plan with extra fields

```python
return {"call": name, "with": args, "verified": True}  # BAD
```

`plans.parse` rejects the `verified` field as unknown, so the plan never runs. But the bug is in the adapter, and the error message will be:

`INVALID_PLAN: unknown top-level fields: ['verified']`

It won't say "your adapter is broken." Don't inject fields.

### Mutating the sample in tests

The mixin's `test_parse_proposal_does_not_strip_unknown_top_level_fields` injects `"verified": True` into a copy of `sample_proposal()`. If your `sample_proposal()` returns a shared mutable object, the test can mutate it for subsequent tests.

**Rule:** `sample_proposal()` must return a fresh dictionary (or a `dict(...)` copy) on every call.

```python
def sample_proposal(self):
    return {
        "picked": {
            "fn_name": "get_order",
            "fn_args": {"order_id": 502},
        }
    }
```

This constructs a new dictionary each time. Do not return a module-level constant.

### Reading provider SDK types in the adapter

```python
from openai.types.chat import ChatCompletionToolMessageParam  # BAD
```

The adapter must accept any JSON-shaped response. If you type-hint against an SDK type, you couple the adapter to the SDK version. Accept `Any` and validate structurally.

### Doing HTTP or other I/O

The adapter is pure data shaping. The application owns the model call.

If your adapter makes network calls, it's not an adapter — it's a client library, and it belongs in the application, not in `execgate_ai`.

### Importing from the trust boundary

```python
from execgate.verifier import verify_plan  # BAD — ADR-0006
```

The conformance kit's `test_adapter_has_no_trust_boundary_attributes` catches attribute access at the object level. It does not catch a module-level import; that requires the adapter package's own `test_leaf_node_boundary.py`-style AST scan.

The safest approach is to import only from:

- `execgate.tools`
- `execgate.results`
- `execgate.errors`
- `execgate.context`

Anything else is a design smell.

---

## 7. Streaming and multi-call responses

Adapters in version 0.1.0 assume a single, complete response. There are two cases to consider.

**Streaming:** The provider streams deltas. The application collects the full response, then calls `parse_proposal` on the assembled object.

**Multi-call:** The provider returns multiple tool calls in one response. The adapter's `parse_proposal` returns the first call; the application loops to handle the others, parsing each separately or feeding the whole set through `RepairLoop`.

Future adapter versions may support streaming directly. Version 0.1.0 does not.

---

## 8. Testing against a live provider (optional)

The conformance kit does not make network calls. To test against the real provider, add a `@pytest.mark.integration` test that requires credentials:

```python
import os

import pytest


@pytest.mark.integration
def test_example_adapter_live():
    """Requires EXAMPLE_API_KEY. Skipped by default."""
    if not os.environ.get("EXAMPLE_API_KEY"):
        pytest.skip("EXAMPLE_API_KEY not set")

    # Make a real call, get a real response, and verify parse_proposal works.
    ...
```

Integration tests are not part of the default suite. The default `pytest` run excludes them; CI runs them in a separate step.

They catch provider-format drift but do not gate conformance.

---

## 9. Checklist before submitting an adapter

- [ ] `src/execgate_ai/providers/<name>.py` exists and implements `ProviderAdapter` (both methods, plus `name`).
- [ ] Zero SDK imports at module level. Zero HTTP calls.
- [ ] `registry.py::_PROVIDERS` has a `"<name>"` entry.
- [ ] `tests/adapters/test_<name>.py` subclasses `AdapterContractMixin` and implements `make_adapter()` and `sample_proposal()`.
- [ ] `sample_proposal()` returns a fresh dictionary on each call.
- [ ] Provider-specific tests cover a real response, a no-tool-call response, and edge cases.
- [ ] `pytest tests/adapters/test_<name>.py -v` passes.
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]`.
- [ ] If the adapter needs a new `logiq.*` import, ADR-0006's allowlist is updated in the same commit.

An adapter that passes the conformance kit is accepted. One that doesn't is not — regardless of whether it works against a particular provider today.