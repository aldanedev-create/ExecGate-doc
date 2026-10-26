# Lesson 04 — MCP Proxy

Build a verified proxy in front of an untrusted MCP server. Every call goes through ExecGate before being forwarded. By the end, you'll have a working `LogixMCPProxy` that rejects invented tools, malformed arguments, and policy violations.

**Time:** 35 minutes  
**You will build:** Approximately 40 lines of application code, 80 lines of tests, and one `FakeMCPClient`  
**You will understand:** `LogixMCPProxy`, `startup()`, upstream wrapping, and invariants on wrapped tools

---

## What you're building

An MCP proxy in front of a third-party MCP server. The upstream server is untrusted: it exposes tools and handles calls, but it might be compromised. The proxy verifies every call before forwarding it.

The critical properties are:

1. **Unknown tools are rejected.** The proxy's registry must contain the requested tool.
2. **Invalid arguments are rejected.** The wrapped capability's schema is enforced.
3. **Policy violations are rejected.** Invariants attached to wrapped tools run.
4. **Valid calls are forwarded.** The upstream receives the arguments that passed verification.

For this lesson, the upstream is a `FakeMCPClient`—a test stub that implements the MCP client surface used by the proxy. This lets you explore the proxy without a live upstream server. In production, the upstream would be real.

---

## Setup

Create the lesson directory and files:

```bash
mkdir -p logiq-lessons/04-mcp-proxy
cd logiq-lessons/04-mcp-proxy
touch proxy_demo.py test_proxy_demo.py
```

Install the MCP integration:

```bash
pip install "execgate[mcp]"
```

You'll also need `pytest-asyncio` for the asynchronous tests:

```bash
pip install pytest-asyncio
```

## Step 1 — Build the upstream stub

The `FakeMCPClient` in `tests/mcp/conftest.py` is a useful reference. We'll inline a minimal version here to keep the lesson self-contained.

Add the following to `proxy_demo.py`:

```python
"""A minimal MCP client stub for the lesson."""

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class FakeMCPTool:
    name: str
    description: str
    inputSchema: dict[str, Any]


@dataclass
class FakeTextContent:
    text: str


@dataclass
class FakeCallToolResult:
    content: list[FakeTextContent] = field(default_factory=list)
    isError: bool = False


class FakeMCPClient:
    """Stub that implements the MCP client surface used by execgate_mcp."""

    def __init__(self, tools: list[FakeMCPTool]):
        self._tools = tools
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.entered = False
        self.exited = False

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, *args):
        self.exited = True

    async def list_tools(self):
        return list(self._tools)

    async def call_tool(self, name: str, arguments: dict[str, Any]):
        self.calls.append((name, dict(arguments)))

        return FakeCallToolResult(
            content=[
                FakeTextContent(
                    text=json.dumps({"called": name, "args": arguments})
                )
            ]
        )
```

The stub implements:

- `__aenter__()` and `__aexit__()` — asynchronous context-manager methods.
- `list_tools()` — returns the upstream's available tools.
- `call_tool(name, arguments)` — records a call and returns a result.

This is the client surface the lesson expects `LogixMCPProxy` to use. The stub lets us test the proxy without a network connection.

### Try the stub directly

Run this example in a Python session after defining the stub:

```python
import asyncio


async def test_stub():
    tools = [
        FakeMCPTool(
            name="upstream_echo",
            description="Echo the input.",
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {"type": "string}
                },
                "required": ["message"],
                "additionalProperties": False,
            },
        ),
    ]

    client = FakeMCPClient(tools)

    async with client:
        tools_list = await client.list_tools()
        print("Tools:", [tool.name for tool in tools_list])

        result = await client.call_tool(
            "upstream_echo",
            {"message": "hi"},
        )

        print("Result:", result.content[0].text)
        print("Calls recorded:", client.calls)


asyncio.run(test_stub())
```

Expected output:

```text
Tools: ['upstream_echo']
Result: {"called": "upstream_echo", "args": {"message": "hi"}}
Calls recorded: [('upstream_echo', {'message': 'hi'})]
```

## Step 2 — Wrap the upstream with `LogixMCPProxy`

The proxy registers upstream tools as native ExecGate capabilities. Calls can then go through ExecGate's normal verification and execution pipeline.

Add the following imports and example to `proxy_demo.py`, after the stub:

```python
import asyncio

from execgate import Logix, Deny
from execgate_mcp import LogixMCPProxy


async def main():
    logix = Logix()

    tools = [
        FakeMCPTool(
            name="upstream_echo",
            description="Echo the input.",
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {"type": "string"}
                },
                "required": ["message"],
                "additionalProperties": False,
            },
        ),
        FakeMCPTool(
            name="upstream_delete",
            description="Dangerous operation.",
            inputSchema={
                "type": "object",
                "properties": {
                    "id": {"type": "integer}
                },
                "required": ["id"],
                "additionalProperties": False,
            },
        ),
    ]

    client = FakeMCPClient(tools)
    proxy = LogixMCPProxy(logix, client)

    await proxy.startup()
    print("Registered capabilities:", logix.registry.names())

    # Try a valid call.
    plan = {
        "call": "upstream_echo",
        "with": {"message": "hello"},
    }

    result = await asyncio.to_thread(logix.run, plan)
    print("Valid call:", result.ok, result.value)
    print("Upstream calls so far:", client.calls)

    # Try an unknown tool.
    plan = {"call": "unknown_tool", "with": {}}
    result = await asyncio.to_thread(logix.run, plan)
    print("Unknown tool:", result.ok, result.errors[0].code)

    # Try invalid arguments.
    plan = {
        "call": "upstream_echo",
        "with": {"message": 123},
    }

    result = await asyncio.to_thread(logix.run, plan)
    print("Bad arguments:", result.ok, result.errors[0].code)

    await proxy.shutdown()
    print("Client closed:", client.exited)


if __name__ == "__main__":
    asyncio.run(main())
```

Run the application:

```bash
python proxy_demo.py
```

Expected output:

```text
Registered capabilities: ['upstream_echo', 'upstream_delete']
Valid call: True {"called": "upstream_echo", "args": {"message": "hello"}}
Upstream calls so far: [('upstream_echo', {'message': 'hello'})]
Unknown tool: False UNKNOWN_CAPABILITY
Bad arguments: False SCHEMA_VALIDATION_FAILED
Client closed: True
```

Four things happened:

1. `startup()` fetched the upstream tools and registered them as native ExecGate capabilities.
2. A valid plan was forwarded to the upstream, which recorded the call.
3. An unknown tool was rejected before reaching the upstream.
4. Invalid arguments were rejected before reaching the upstream.

The `client.calls` list provides evidence of which calls reached the stub. After these examples, it should contain only the valid call.

## Step 3 — Attach a policy to a wrapped tool

The `upstream_delete` tool is dangerous. Attach an authorization check after `startup()`:

```python
def delete_policy(args, ctx):
    if ctx.principal != "admin":
        return Deny("NOT_ADMIN", "only admins can delete")

    return None  # Allow


logix.authorize("upstream_delete", check=delete_policy)
```

A non-admin attempting to call `upstream_delete` should receive `POLICY_REJECTED`.

Try it:

```python
plan = {
    "call": "upstream_delete",
    "with": {"id": 42},
}

# Non-admin.
non_admin = logix.context(principal="alice")

result = await asyncio.to_thread(
    logix.run,
    plan,
    context=non_admin,
)

print(
    "Non-admin:",
    result.errors[0].code,
    result.errors[0].message,
)

# Admin.
admin = logix.context(principal="admin")

result = await asyncio.to_thread(
    logix.run,
    plan,
    context=admin,
)

print("Admin:", result.ok, client.calls[-1])
```

Expected output:

```text
Non-admin: POLICY_REJECTED only admins can delete
Admin: True ('upstream_delete', {'id': 42})
```

The non-admin call should not reach the upstream, but the admin call should.

This is the key property: registering a tool makes it available, while its policy determines whether a particular call can proceed. The invariant runs before the handler forwards the request.

## Step 4 — Attach a grounding rule to a wrapped tool

What if `upstream_delete` can be called with an arbitrary ID? A model could invent an argument such as `{"id": 9999}`. Grounding can require the ID to come from a prior step.

Configure the rule:

```python
logix.grounding(require_ref_for=["upstream_delete.id"])
```

Now a literal ID should be rejected with `GROUNDING_REQUIRED`. The plan must reference a prior step's output using `$ref`.

Try a literal ID:

```python
plan = {
    "call": "upstream_delete",
    "with": {"id": 42},
}

result = await asyncio.to_thread(
    logix.run,
    plan,
    context=admin,
)

print("Literal:", result.errors[0].code)
```

Expected output:

```text
Literal: GROUNDING_REQUIRED
```

### Understanding the limitation

A fully grounded example needs a read-like upstream tool whose output contains the ID to be used by the delete operation.

The upstream's output in this lesson is serialized as JSON text. If ExecGate treats that result as opaque text rather than a structured dictionary, a `$ref` cannot traverse into its JSON contents as though they were a typed object.

The lesson's intended point is that grounding rules for wrapped tools follow the same policy model as those for native capabilities, but the usefulness of `$ref` depends on the actual shape of the upstream result.

For sensitive operations, consider either:

1. Wrapping the fetch-and-delete workflow in a composite capability that performs the necessary lookup and validation internally.
2. Using a native capability for the sensitive part of the workflow, where the output and input schemas can be controlled directly.

Keep the grounding configuration in the demo to show the rejection:

```python
logix.grounding(require_ref_for=["upstream_delete.id"])

plan = {
    "call": "upstream_delete",
    "with": {"id": 42},
}

result = await asyncio.to_thread(
    logix.run,
    plan,
    context=admin,
)

print("Literal with grounding:", result.errors[0].code)
```

Expected output:

```text
Literal with grounding: GROUNDING_REQUIRED
```

## Step 5 — Handle startup failures

If an upstream tool uses a schema keyword that `execgate_mcp` cannot faithfully convert, `startup()` should raise an error rather than silently weaken validation.

Try an unsupported schema:

```python
bad_tools = [
    FakeMCPTool(
        name="weird_tool",
        description="Uses a schema ExecGate cannot convert.",
        inputSchema={
            "type": "object",
            "properties": {
                "x": {"$ref": "#/$defs/X"},
            },
        },
    ),
]

bad_client = FakeMCPClient(bad_tools)
bad_logix = Logix()
bad_proxy = LogixMCPProxy(bad_logix, bad_client)

try:
    await bad_proxy.startup()
except ValueError as exc:
    print("Startup failed:", exc)
    print("Client cleaned up:", bad_client.exited)
```

Expected output:

```text
Startup failed: MCP inputSchema uses unsupported keyword '$ref' at $.x
Client cleaned up: True
```

The proxy should refuse to start when it cannot faithfully verify the upstream's schema. The client should also be cleaned up if startup fails, so resources are not leaked.

The lesson's example schema converter supports these keywords:

- `type`
- `properties`
- `required`
- `additionalProperties`
- `items`
- `enum`
- `anyOf`

Other keywords, such as `$ref`, `oneOf`, `allOf`, `minimum`, and `pattern`, are rejected in the example.

If an upstream needs an unsupported keyword, extend `mcp_schema_to_logix` in `execgate_mcp/adapter.py` and add tests. Do not weaken validation silently.

## Step 6 — The complete application

Use this as the complete `proxy_demo.py` file:

```python
"""Lesson 04: MCP proxy mode."""

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

from execgate import Deny, Logix
from execgate_mcp import LogixMCPProxy


# --- Upstream stub ---

@dataclass
class FakeMCPTool:
    name: str
    description: str
    inputSchema: dict[str, Any]


@dataclass
class FakeTextContent:
    text: str


@dataclass
class FakeCallToolResult:
    content: list[FakeTextContent] = field(default_factory=list)
    isError: bool = False


class FakeMCPClient:
    """Stub that implements the client surface used by the proxy."""

    def __init__(self, tools: list[FakeMCPTool]):
        self._tools = tools
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.entered = False
        self.exited = False

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, *args):
        self.exited = True

    async def list_tools(self):
        return list(self._tools)

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
    ):
        self.calls.append((name, dict(arguments)))

        return FakeCallToolResult(
            content=[
                FakeTextContent(
                    text=json.dumps(
                        {"called": name, "args": arguments}
                    )
                )
            ]
        )


# --- Application ---

async def main():
    logix = Logix()

    tools = [
        FakeMCPTool(
            name="upstream_echo",
            description="Echo the input.",
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {"type": "string}
                },
                "required": ["message"],
                "additionalProperties": False,
            },
        ),
        FakeMCPTool(
            name="upstream_delete",
            description="Dangerous operation.",
            inputSchema={
                "type": "object",
                "properties": {
                    "id": {"type": "integer}
                },
                "required": ["id"],
                "additionalProperties": False,
            },
        ),
    ]

    client = FakeMCPClient(tools)
    proxy = LogixMCPProxy(logix, client)

    await proxy.startup()
    print("Registered:", logix.registry.names())

    # Attach a policy to the dangerous tool.
    def delete_policy(args, ctx):
        if ctx.principal != "admin":
            return Deny("NOT_ADMIN", "only admins can delete")
        return None

    logix.authorize("upstream_delete", check=delete_policy)

    admin = logix.context(principal="admin")
    alice = logix.context(principal="alice")

    # Valid call.
    result = await asyncio.to_thread(
        logix.run,
        {
            "call": "upstream_echo",
            "with": {"message": "hi"},
        },
        context=admin,
    )
    print("Echo:", result.ok)

    # Unknown tool.
    result = await asyncio.to_thread(
        logix.run,
        {"call": "nonexistent", "with": {}},
        context=admin,
    )
    print("Unknown:", result.errors[0].code)

    # Invalid arguments.
    result = await asyncio.to_thread(
        logix.run,
        {
            "call": "upstream_echo",
            "with": {"message": 123},
        },
        context=admin,
    )
    print("Bad arguments:", result.errors[0].code)

    # Denied by policy.
    result = await asyncio.to_thread(
        logix.run,
        {
            "call": "upstream_delete",
            "with": {"id": 42},
        },
        context=alice,
    )
    print("Denied:", result.errors[0].code, result.errors[0].message)

    # Allowed.
    result = await asyncio.to_thread(
        logix.run,
        {
            "call": "upstream_delete",
            "with": {"id": 42},
        },
        context=admin,
    )
    print("Allowed:", result.ok)

    print("Upstream calls:", client.calls)

    await proxy.shutdown()
    print("Client closed:", client.exited)


if __name__ == "__main__":
    asyncio.run(main())
```

Run it:

```bash
python proxy_demo.py
```

Expected output:

```text
Registered: ['upstream_echo', 'upstream_delete']
Echo: True
Unknown: UNKNOWN_CAPABILITY
Bad arguments: SCHEMA_VALIDATION_FAILED
Denied: POLICY_REJECTED only admins can delete
Allowed: True
Upstream calls: [('upstream_echo', {'message': 'hi'}), ('upstream_delete', {'id': 42})]
Client closed: True
```

The upstream received exactly two calls: the valid echo and the authorized delete. The unknown tool, invalid arguments, and denied delete were rejected before forwarding.

## Step 7 — Write the tests

Add the following to `test_proxy_demo.py`:

```python
"""Tests for Lesson 04."""

import asyncio

import pytest

from execgate import Deny, Logix
from execgate_mcp import LogixMCPProxy

from proxy_demo import FakeMCPClient, FakeMCPTool


@pytest.fixture
def upstream():
    return FakeMCPClient(
        [
            FakeMCPTool(
                name="upstream_echo",
                description="Echo.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "message": {"type": "string}
                    },
                    "required": ["message"],
                    "additionalProperties": False,
                },
            ),
            FakeMCPTool(
                name="upstream_delete",
                description="Delete.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer}
                    },
                    "required": ["id"],
                    "additionalProperties": False,
                },
            ),
        ]
    )


@pytest.mark.asyncio
async def test_unknown_tool_rejected(upstream):
    logix = Logix()
    proxy = LogixMCPProxy(logix, upstream)

    await proxy.startup()

    try:
        result = await asyncio.to_thread(
            logix.run,
            {"call": "nonexistent", "with": {}},
        )

        assert not result.ok
        assert result.errors[0].code == "UNKNOWN_CAPABILITY"
        assert upstream.calls == []
    finally:
        await proxy.shutdown()


@pytest.mark.asyncio
async def test_invalid_args_rejected(upstream):
    logix = Logix()
    proxy = LogixMCPProxy(logix, upstream)

    await proxy.startup()

    try:
        result = await asyncio.to_thread(
            logix.run,
            {
                "call": "upstream_echo",
                "with": {"message": 123},
            },
        )

        assert not result.ok
        assert result.errors[0].code == "SCHEMA_VALIDATION_FAILED"
        assert upstream.calls == []
    finally:
        await proxy.shutdown()


@pytest.mark.asyncio
async def test_valid_call_forwarded(upstream):
    logix = Logix()
    proxy = LogixMCPProxy(logix, upstream)

    await proxy.startup()

    try:
        result = await asyncio.to_thread(
            logix.run,
            {
                "call": "upstream_echo",
                "with": {"message": "hi"},
            },
        )

        assert result.ok
        assert upstream.calls == [
            ("upstream_echo", {"message": "hi"})
        ]
    finally:
        await proxy.shutdown()


@pytest.mark.asyncio
async def test_policy_denies_before_forwarding(upstream):
    logix = Logix()
    proxy = LogixMCPProxy(logix, upstream)

    await proxy.startup()

    try:
        logix.authorize(
            "upstream_delete",
            check=lambda args, ctx: Deny("NO", "no"),
        )

        result = await asyncio.to_thread(
            logix.run,
            {
                "call": "upstream_delete",
                "with": {"id": 42},
            },
        )

        assert not result.ok
        assert result.errors[0].code == "POLICY_REJECTED"
        assert upstream.calls == []
    finally:
        await proxy.shutdown()


@pytest.mark.asyncio
async def test_unsupported_schema_fails_startup():
    bad_client = FakeMCPClient(
        [
            FakeMCPTool(
                name="weird",
                description="",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "x": {"$ref": "#/$defs/X}
                    },
                },
            ),
        ]
    )

    proxy = LogixMCPProxy(Logix(), bad_client)

    with pytest.raises(ValueError, match=r"\$ref|unsupported"):
        await proxy.startup()

    assert bad_client.exited
```

Run the tests:

```bash
pytest test_proxy_demo.py -v
```

Expected result: **5 tests pass**, provided the installed package APIs and cleanup behavior match the examples.

### What the tests prove

- Unknown tools are rejected before forwarding.
- Invalid arguments are rejected before forwarding.
- Valid calls reach the upstream.
- Policies can reject a call before forwarding.
- Unsupported schemas cause startup to fail.

## What you built

You built an MCP proxy that:

- Wraps upstream tools as native ExecGate capabilities.
- Rejects unknown tools before forwarding.
- Rejects invalid arguments before forwarding.
- Runs policies on wrapped tools before forwarding.
- Fails safely when it encounters unsupported upstream schemas.
- Records forwarded calls in the test client's `calls` list.

The five tests exercise these behaviors.

## What to try next

1. **Add an approval requirement to `upstream_delete`.** After startup, try:

   ```python
   logix.require_approval("upstream_delete")
   ```

   A call without a valid approval token should be rejected. Check the approval API documentation for how to issue a token and execute an approved plan using `logix.approval.issue(...)` and `logix.execute(...)`.

2. **Test the asynchronous bridge.** Make `FakeMCPClient.call_tool()` wait for 100 milliseconds. Measure a `logix.run()` call. The `asyncio.to_thread()` bridge keeps the calling event loop from blocking while the synchronous pipeline runs. Actual concurrency depends on the executor and client implementation.

3. **Replace the stub with a live upstream.** If you have an MCP client library installed, replace `FakeMCPClient` with the appropriate client for your upstream. The exact constructor and lifecycle may differ, so follow that library's documentation.

4. **Understand why a generic plan tool is dangerous.** Why shouldn't the proxy expose a `logix_plan` tool that accepts an arbitrary plan dictionary? Doing so could let an MCP caller submit plans outside the intended exposed-tool catalog and undermine the proxy's boundary.

## Where to read more

- `docs/mcp.md`, section 4 — proxy mode reference.
- `docs/mcp.md`, section 3 — known limitations of MCP server mode.
- `docs/adr/0007-mcp-leaf-node-boundary.md` — why `execgate_mcp` is a leaf node.
- `tests/mcp/` — the full MCP test suite.
- `docs/security.md`, section “What ExecGate does not protect against” — limitations of MCP proxy mode.

## Next lesson

You've built an MCP proxy. Lesson 05 covers Pydantic models: reusing existing domain models as capability schemas.

→ [05-pydantic-models.md](05-pydantic-models.md)
