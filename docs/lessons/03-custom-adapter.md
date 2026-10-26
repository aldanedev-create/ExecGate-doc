# Lesson 03 — Custom Adapter

Write a provider adapter for a fictional AI SDK, register it, and pass the conformance tests. By the end, you'll have a working adapter that plugs into `logix.tools.format("hub")` and produces plans that run through ExecGate.

**Time:** 30 minutes  
**You will build:** Approximately 50 lines of adapter code and 40 lines of conformance tests  
**You will understand:** The `ProviderAdapter` protocol, the conformance kit, and the leaf-node rule

---

## What you're building

A fictional AI provider called **Hub**. It has its own API shape.

**Request format** — what `format_tools()` produces:

```json
{
  "capabilities": [
    {
      "call_name": "get_order",
      "summary": "Retrieve an order.",
      "params": {
        "type": "object"
      }
    }
  ]
}
```

**Response format** — what `parse_proposal()` consumes:

```json
{
  "action": {
    "call_name": "get_order",
    "payload": {
      "order_id": 502
    }
  }
}
```

Your adapter translates between this provider-specific shape and ExecGate's neutral shape.

The critical properties are:

- `format_tools(specs)` produces a shape the fictional provider's SDK would accept.
- `parse_proposal(response)` produces a neutral plan dictionary.
- The adapter passes the conformance tests that every adapter must satisfy.
- The adapter is a **leaf node**: it does not import from `execgate.verifier`, `execgate.executor`, or `execgate.ir`.

## Setup

Create the lesson directory:

```bash
mkdir -p logiq-lessons/03-custom-adapter
cd logiq-lessons/03-custom-adapter
touch hub_adapter.py test_hub_adapter.py
```

You'll also need `execgate_ai` installed:

```bash
pip install "execgate[ai]"
```

The `execgate_ai` package provides the `ProviderAdapter` protocol, the conformance kit's base class, and the mechanism for registering adapters. Your adapter plugs into that ecosystem.

## Step 1 — Understand the protocol

Open `docs/ai-integration.md`, section 4, or inspect the protocol directly:

```python
from execgate_ai import ProviderAdapter

help(ProviderAdapter)
```

The protocol is:

```python
class ProviderAdapter(Protocol):
    name: str

    def format_tools(self, specs: list[ToolSpec]) -> Any: ...

    def parse_proposal(self, raw: Any) -> dict[str, Any]: ...
```

There are two methods:

- `format_tools()` shapes the capability catalog.
- `parse_proposal()` extracts a plan from a provider response.

That's the contract. An adapter should not have access to the verifier, executor, or registry.

## Step 2 — Write the adapter

Add the following to `hub_adapter.py`:

```python
"""Adapter for the fictional 'hub' AI provider."""

from __future__ import annotations

from typing import Any

from execgate_ai.base import AdapterError, ToolSpec


class HubAdapter:
    """Adapter for the fictional 'hub' provider."""

    name = "hub"

    def format_tools(self, specs: list[ToolSpec]) -> dict[str, Any]:
        """Convert the neutral catalog into Hub's tools shape."""
        return {
            "capabilities": [
                {
                    "call_name": spec.name,
                    "summary": spec.description,
                    "params": spec.input_schema,
                }
                for spec in specs
            ]
        }

    def parse_proposal(self, raw: Any) -> dict[str, Any]:
        """Convert a Hub response into a neutral plan dictionary."""
        if not isinstance(raw, dict):
            raise AdapterError(
                f"hub response must be a dict, got {type(raw).__name__}"
            )

        action = raw.get("action")
        if not isinstance(action, dict):
            raise AdapterError("hub response has no 'action' object")

        call_name = action.get("call_name")
        payload = action.get("payload", {})

        if not isinstance(call_name, str) or not call_name:
            raise AdapterError("hub action has no valid 'call_name'")

        if not isinstance(payload, dict):
            raise AdapterError("hub action 'payload' must be an object")

        return {"call": call_name, "with": payload}
```

Two things to notice:

1. `format_tools()` returns a dictionary, not a list. The protocol allows `Any` as its return type. Hub's SDK expects a `{"capabilities": [...]}` structure, so that's what the adapter produces.
2. `parse_proposal()` raises `AdapterError` when the response has an invalid shape. A missing or invalid action, an invalid `call_name`, or a non-dictionary payload produces an error rather than a malformed plan.

The provider-specific format can differ from the neutral catalog format. The adapter handles that translation.

### Try it manually

Create a small catalog:

```python
from hub_adapter import HubAdapter
from execgate.tools import ToolSpec

adapter = HubAdapter()

specs = [
    ToolSpec(
        name="get_order",
        description="Retrieve an order.",
        input_schema={
            "type": "object",
            "properties": {
                "order_id": {"type": "integer}
            },
            "required": ["order_id"],
            "additionalProperties": False,
        },
    ),
]

catalog = adapter.format_tools(specs)
print(catalog)
```

Expected output, formatted for readability:

```python
{
    "capabilities": [
        {
            "call_name": "get_order",
            "summary": "Retrieve an order.",
            "params": {
                "type": "object",
                "properties": {
                    "order_id": {"type": "integer"}
                },
                "required": ["order_id"],
                "additionalProperties": False,
            },
        }
    ]
}
```

The result matches the shape expected by the fictional Hub SDK.

Now parse a response:

```python
response = {
    "action": {
        "call_name": "get_order",
        "payload": {"order_id": 502},
    }
}

plan = adapter.parse_proposal(response)
print(plan)
```

Expected output:

```python
{"call": "get_order", "with": {"order_id": 502}}
```

This is a neutral plan dictionary that you can pass to `logix.run()`.

## Step 3 — Register it with `execgate_ai`

`execgate_ai` has a registry mapping provider names to adapters. The lesson assumes built-in providers such as `openai`, `anthropic`, `gemini`, and `local` are registered by default.

To make `logix.tools.format("hub")` resolve your adapter, it must be registered.

### Option A — Modify the registry

One possible approach is to add an entry to the provider registry:

```python
from execgate_ai import registry

registry._PROVIDERS["hub"] = (
    "hub_adapter",
    "HubAdapter",
)
```

This uses the private `_PROVIDERS` registry and is not the preferred approach for application code. Its structure and behavior are implementation details that may change.

### Option B — Use the adapter directly

If you don't want to register your adapter with `execgate_ai`, for example because it is specific to your application, use the adapter instance directly:

```python
adapter = HubAdapter()

catalog = adapter.format_tools(logix.tools.describe())

# Send the catalog to Hub's SDK.
plan = adapter.parse_proposal(hub_response)

result = logix.run(plan)
```

This is the recommended approach for the lesson. It demonstrates how the adapter works with the pipeline without requiring changes to `execgate_ai`'s registry.

For the remaining steps, we'll use Option B.

## Step 4 — Use it end-to-end

Add the following example to the bottom of `hub_adapter.py`:

```python
if __name__ == "__main__":
    from execgate import Logix

    logix = Logix()

    @logix.capability
    def add(a: int, b: int) -> int:
        """Add two integers."""
        return a + b

    adapter = HubAdapter()

    # 1. Format the catalog for Hub's SDK.
    catalog = adapter.format_tools(logix.tools.describe())
    print("Catalog:", catalog)

    # 2. Simulate Hub's response.
    # In a real application, this would come from the SDK.
    hub_response = {
        "action": {
            "call_name": "add",
            "payload": {"a": 2, "b": 3},
        }
    }

    # 3. Parse the response into a neutral plan.
    plan = adapter.parse_proposal(hub_response)
    print("Plan:", plan)

    # 4. Run the plan through ExecGate.
    result = logix.run(plan)
    print("Result:", result.value)
```

Run the example:

```bash
python hub_adapter.py
```

Expected output, with catalog formatting shortened for readability:

```text
Catalog: {'capabilities': [{'call_name': 'add', 'summary': 'Add two integers.', 'params': {...}}]}
Plan: {'call': 'add', 'with': {'a': 2, 'b': 3}}
Result: 5
```

The adapter translates Hub's response into ExecGate's neutral plan format. ExecGate then processes the plan through its normal pipeline.

## Step 5 — Write the conformance tests

The conformance kit is located at `tests/adapters/contract.py`. This lesson uses a standalone test class with representative contract checks, rather than importing `AdapterContractMixin` from the ExecGate repository's test directory.

Add the following to `test_hub_adapter.py`:

```python
"""Conformance tests for the Hub adapter."""

from hub_adapter import HubAdapter


class TestHubAdapter:
    """Test the Hub adapter against representative contract checks."""

    def make_adapter(self):
        return HubAdapter()

    def sample_proposal(self):
        return {
            "action": {
                "call_name": "get_order",
                "payload": {"order_id": 502},
            }
        }

    # --- Shape ---

    def test_name(self):
        assert self.make_adapter().name == "hub"

    def test_format_tools_empty(self):
        adapter = self.make_adapter()
        assert adapter.format_tools([]) == {"capabilities": []}

    def test_format_tools_includes_every_capability(self):
        from execgate.tools import ToolSpec

        adapter = self.make_adapter()
        specs = [
            ToolSpec(
                name="a",
                description="A",
                input_schema={"type": "object"},
            ),
            ToolSpec(
                name="b",
                description="B",
                input_schema={"type": "object"},
            ),
        ]

        result = adapter.format_tools(specs)
        names = [capability["call_name"] for capability in result["capabilities"]]

        assert names == ["a", "b"]

    def test_parse_proposal_roundtrip(self):
        adapter = self.make_adapter()
        plan = adapter.parse_proposal(self.sample_proposal())

        assert plan == {
            "call": "get_order",
            "with": {"order_id": 502},
        }

    def test_parse_proposal_returns_plain_dict(self):
        adapter = self.make_adapter()
        plan = adapter.parse_proposal(self.sample_proposal())

        assert type(plan) is dict

    # --- Error handling ---

    def test_parse_rejects_non_dict(self):
        import pytest

        from execgate_ai.base import AdapterError

        adapter = self.make_adapter()

        with pytest.raises(AdapterError):
            adapter.parse_proposal("not a dict")

    def test_parse_rejects_no_action(self):
        import pytest

        from execgate_ai.base import AdapterError

        adapter = self.make_adapter()

        with pytest.raises(AdapterError):
            adapter.parse_proposal({"unexpected": "shape"})

    def test_parse_rejects_bad_call_name(self):
        import pytest

        from execgate_ai.base import AdapterError

        adapter = self.make_adapter()

        with pytest.raises(AdapterError):
            adapter.parse_proposal(
                {
                    "action": {
                        "call_name": "",
                        "payload": {},
                    }
                }
            )

    def test_parse_rejects_bad_payload(self):
        import pytest

        from execgate_ai.base import AdapterError

        adapter = self.make_adapter()

        with pytest.raises(AdapterError):
            adapter.parse_proposal(
                {
                    "action": {
                        "call_name": "x",
                        "payload": "not a dict",
                    }
                }
            )

    # --- Trust-boundary isolation ---

    def test_adapter_has_no_trust_boundary_attributes(self):
        adapter = self.make_adapter()
        forbidden = (
            "verify",
            "execute",
            "registry",
            "logix",
            "run",
            "policy",
        )

        for name in forbidden:
            assert not hasattr(adapter, name), (
                f"adapter exposes forbidden attribute {name!r}"
            )

    def test_parse_cannot_smuggle_verified(self):
        from execgate.plans import parse_plan

        adapter = self.make_adapter()

        # The adapter constructs a fresh dictionary with only "call"
        # and "with", so an unrelated top-level field is not forwarded.
        plan = adapter.parse_proposal(self.sample_proposal())
        assert "verified" not in plan

        # The plan parser should reject a forged "verified" field.
        result = parse_plan(
            {
                "call": "add",
                "with": {},
                "verified": True,
            }
        )

        assert isinstance(result, list)
```

Run the tests:

```bash
pytest test_hub_adapter.py -v
```

The expected result is **10 passing tests**, provided the imports and APIs match the installed ExecGate and `execgate_ai` versions.

### What each test proves

- `test_name` — the adapter has a name.
- `test_format_tools_empty` — an empty catalog produces an empty result.
- `test_format_tools_includes_every_capability` — each supplied capability appears in the formatted catalog.
- `test_parse_proposal_roundtrip` — a valid response becomes a neutral plan.
- `test_parse_proposal_returns_plain_dict` — the result is a plain dictionary.
- Four error tests — malformed response shapes raise `AdapterError`.
- `test_adapter_has_no_trust_boundary_attributes` — the adapter does not expose the listed trust-boundary attributes.
- `test_parse_cannot_smuggle_verified` — the adapter does not forward an arbitrary `verified` field, and the example checks that `parse_plan()` rejects a forged field.

These are representative contract checks. **They do not, by themselves, prove that the adapter passes the repository's actual conformance kit.** To establish that, run the real `AdapterContractMixin` tests against `HubAdapter` in the ExecGate repository.

## Step 6 — The complete files

The complete `hub_adapter.py` file is the adapter from Step 2, followed by the end-to-end example from Step 4.

The complete `test_hub_adapter.py` file is the test class from Step 5.

Keep these as two separate files in your lesson directory:

```text
03-custom-adapter/
├── hub_adapter.py
└── test_hub_adapter.py
```

## What you built

You built an adapter for a fictional AI SDK. It:

- Formats the capability catalog in the provider's shape.
- Parses provider responses into neutral plan dictionaries.
- Raises `AdapterError` for malformed responses.
- Includes 10 representative contract tests.
- Avoids implementing verification or execution inside the adapter.

You can use `HubAdapter` directly in the same way as other provider adapters:

```python
adapter = HubAdapter()

catalog = adapter.format_tools(logix.tools.describe())

# Send the catalog to Hub's SDK.
plan = adapter.parse_proposal(hub_response)

result = logix.run(plan)
```

The adapter handles translation. ExecGate remains responsible for processing the resulting plan through its own pipeline.

## What to try next

1. **Register the adapter with `execgate_ai`.** If the package supports a public registration API, prefer that API. The private `_PROVIDERS` example above is implementation-dependent. If you add the entry to `execgate_ai/registry.py`, verify that `logix.tools.format("hub")` resolves it.

2. **Handle multi-tool responses.** Hub currently returns one action per response. If the SDK returns a list of actions, decide whether to support multiple actions or reject them explicitly. Add tests for your chosen behavior.

3. **Handle streaming.** Hub's SDK has a streaming API, but the adapter protocol shown here does not stream. The application can collect the response and call `parse_proposal()` once it has the complete payload.

4. **Add provider-specific error handling.** If Hub returns an error object instead of an action, decide how `parse_proposal()` should handle it. Raising `AdapterError` is clearer than converting an error response into a plan that fails later with an unrelated error.

## Where to read more

- `docs/ai-integration.md`, section 4 — the `ProviderAdapter` protocol and the conformance kit's design.
- `docs/writing-an-adapter.md` — the adapter walkthrough and the actual conformance-kit source.
- `docs/architecture.md`, section “Adapters are leaf nodes” — why the leaf-node rule exists.
- `docs/adr/0006-adapters-never-touch-trust-boundary.md` — the decision record.
- `tests/adapters/contract.py` — the repository's conformance kit.

## Next lesson

You've built a provider adapter. Lesson 04 covers MCP proxy mode: wrapping an untrusted upstream MCP server and verifying every call before forwarding it.

→ [04-mcp-proxy.md](04-mcp-proxy.md)
