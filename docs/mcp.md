## `docs/mcp.md`

```markdown
# MCP Integration

ExecGate integrates with the Model Context Protocol (MCP) in two directions.

- **Server mode** (`LogixMCPServer`) — expose a ExecGate engine's
  capabilities as MCP tools. Any MCP client can discover and call them;
  every call runs through the full ExecGate pipeline.
- **Proxy mode** (`LogixMCPProxy`) — wrap an untrusted upstream MCP
  server. Every incoming call is verified by ExecGate before being
  forwarded. The upstream never sees a call that failed verification.

Both live in `src/execgate_mcp/`, both are optional, and both follow the
leaf-node rule (ADR-0006, ADR-0007). They translate in and out; they
never touch the verifier, executor, or IR.

For the general adapter rule, see `docs/adr/0006-adapters-never-touch-trust-boundary.md`.
For the MCP-specific rule, see `docs/adr/0007-mcp-leaf-node-boundary.md`.

---

## 1. What MCP provides, and what ExecGate adds

MCP is a **transport and discovery protocol**. It defines how a client
enumerates tools and how it calls them. It does not define:

- What arguments a tool accepts (schema is advisory).
- What happens when arguments are wrong.
- How to enforce authorization.
- How to require human approval.
- How to detect an upstream server doing something unexpected.

Those are the properties ExecGate adds. The table makes the split concrete.

| Concern | Provided by MCP | Provided by ExecGate |
|---|---|---|
| Tool discovery | ✅ `tools/list` | — |
| Argument schema declaration | ✅ `inputSchema` (advisory) | ✅ schema **enforced** at call time |
| Unknown-tool rejection | ❌ (server's job, if it has one) | ✅ `UNKNOWN_CAPABILITY` before dispatch |
| Argument type validation | ❌ | ✅ `SCHEMA_VALIDATION_FAILED` before handler |
| Live-state authorization | ❌ | ✅ `logix.authorize(...)` in recheck window |
| Human approval | ❌ | ✅ `logix.require_approval(...)` + bound token |
| Idempotency | ❌ | ✅ `idempotent=True` + args hash |
| Reference grounding | ❌ | ✅ `$ref`-only for sensitive arguments |
| Output validation | ❌ | ✅ declared output schema enforced |
| Audit trail | ❌ | ✅ `logix.audit(hook)` |
| Server mode | ✅ (MCP servers) | ✅ (`LogixMCPServer`) |
| Proxy / wrapping | ✅ (MCP proxies) | ✅ (`LogixMCPProxy` with verification) |

The two are complementary. Deploy MCP for the wire protocol; deploy
ExecGate for what happens when a call arrives.

**What neither provides:** scanning tool descriptions for prompt
injection, sanitizing tool *responses*, or guarding against a malicious
upstream inventing data. For those, compose with an MCP-security proxy
like `mcpwall`, `Aran`, `AgentGuard`, or `McpVanguard`. ExecGate protects
the *request* side; those protect the *content* side.

---

## 2. Server mode — expose ExecGate capabilities as MCP tools

### Quickstart

```python
from execgate import Logix, Deny
from execgate_mcp import LogixMCPServer

logix = Logix()

@logix.capability(effects="read")
def get_order(order_id: int) -> dict[str, int]:
    "Retrieve an order by its ID."
    return db.orders.get(order_id)

@logix.capability(effects="write", requires_approval=True)
def issue_refund(order_id: int, amount: float) -> dict[str, int]:
    "Issue a refund for an order."
    return payments.refund(order_id, amount)

def refund_policy(args, ctx):
    order = db.orders.get(args["order_id"])
    if order["state"] != "delivered":
        return Deny("ORDER_NOT_DELIVERED", "order is still in transit")
    return None  # Allow

logix.authorize(issue_refund, check=refund_policy)

server = LogixMCPServer(logix, name="order-service")
server.run()   # stdio by default
```

Every MCP tool that appears in the client's catalog corresponds to a
registered capability. When the client calls a tool, the handler:

1. Converts the call to a single-step plan (`{"call": name, "with": args}`).
2. Runs `logix.run(plan, context=ctx)` — the full pipeline.
3. Returns `result.value` on success, or raises `ToolError` on failure
   (which FastMCP converts to a `CallToolResult` with `isError: true`).

### What MCP clients see

`LogixMCPServer.describe()` returns the `tools/list` payload as plain
dicts:

```python
[{"name": "get_order",
  "description": "Retrieve an order by its ID.",
  "inputSchema": {"type": "object",
                  "properties": {"order_id": {"type": "integer"}},
                  "required": ["order_id"],
                  "additionalProperties": false}},
 {"name": "issue_refund", ...}]
```

**What is not surfaced:** `effects` (`read` / `write`) and
`requires_approval` are ExecGate-side metadata. The standard MCP
`tools/list` response contains only `name`, `description`, and
`inputSchema`. A client calling `issue_refund` does not know in advance
that approval is required; it will receive `APPROVAL_REQUIRED` at call
time. This is intentional — approval is enforced by the server, not
advertised to the model. If you want clients to know a tool is
sensitive, put it in the `description` string.

### `context_factory`

`LogixMCPServer` accepts a `context_factory` — a zero-argument callable
returning an `ExecutionContext` per tool call. It defaults to
`ExecutionContext(principal="mcp")`.

```python
def context_from_mcp_session():
    session = get_current_mcp_session()
    return ExecutionContext(
        principal=session.user_id,
        tenant=session.tenant,
        roles=frozenset(session.roles),
    )

server = LogixMCPServer(logix, name="order-service",
                        context_factory=context_from_mcp_session)
```

**Current limitation:** `context_factory` takes **zero arguments**. Per-request
principals from MCP auth metadata are not yet plumbed through (F5 in
the handoff report). Workaround: one server per principal, or a
`context_factory` that reads session state from FastMCP's request
context. A future release will pass the request context to the factory.

### Runtime behavior

- **Async bridge.** `logix.run` is synchronous; MCP handlers are async.
  `LogixMCPServer._build_handler` wraps `logix.run` in
  `asyncio.to_thread`, so a slow handler does not freeze the event loop.
- **Every call is verified.** No shortcut for "this is just one step."
- **Errors are MCP errors.** Every ExecGate failure code
  (`UNKNOWN_CAPABILITY`, `SCHEMA_VALIDATION_FAILED`, `POLICY_REJECTED`,
  `APPROVAL_REQUIRED`, `HANDLER_FAILED`, `OUTPUT_VALIDATION_FAILED`,
  ...) is surfaced as a `ToolError` with the code in the text. MCP
  clients see `isError: true` and a message.

---

## 3. Known limitations of server mode (0.1.0)

These are real constraints, not oversights. They are documented so that
applications that need them can plan around them.

### 3.1 Approval-required capabilities are unreachable

A capability marked `requires_approval=True` cannot be executed over
MCP server mode in 0.1.0. Every call returns `APPROVAL_REQUIRED` — there
is no channel through which the MCP client can supply an `ApprovalToken`.

**What this means in practice:**

- A capability with `requires_approval=True` is effectively invisible to
  MCP clients. They can call it; they will always get an error.
- The capability is still useful through the direct `logix.run(...)` /
  `logix.execute(...)` API from application code.

**What to do:**

- **Option 1 (recommended):** Do not register approval-required
  capabilities on a `LogixMCPServer`. Expose them through application
  code that goes through the human approval flow (see
  `docs/semantic-layer.md §5`).
- **Option 2 (future):** If you need approval over MCP, an
  elicitation-based flow (mid-call user prompt) is being designed. It
  is not in 0.1.0. See ADR-0007's "Deferred" section for the design
  considerations.

A future release may add:
- Approval via MCP elicitation (`mcp.elicit(...)` mid-call).
- Approval via a separate endpoint (e.g., an HTTP route that issues a
  token, with the MCP client supplying the token as an opaque argument).

Neither is in 0.1.0. Document this if you expose such capabilities over
MCP; users will hit this and need to know why.

### 3.2 Multi-step plans are not reachable

`LogixMCPServer` exposes each capability as a single-call tool. There is
no MCP tool that accepts a multi-step plan with `$ref`.

**Consequence:** any capability with a grounding rule
(`logix.grounding(require_ref_for=[...])`) cannot be satisfied over MCP.
Grounding requires a `$ref` to an earlier step; a single-call plan has
no earlier step. Every call returns `GROUNDING_REQUIRED`.

**What to do:**

- **Option 1 (recommended):** Do not register grounded capabilities on
  a `LogixMCPServer`. Expose them through application code that
  constructs a multi-step plan.
- **Option 2 (capability-specific endpoint):** Expose a *composite*
  capability that internally does the two steps:

  ```python
  @logix.capability(effects="write")
  def refund_order(order_id: int) -> dict[str, int]:
      "Issue a full refund for an order (fetches total internally)."
      order = db.orders.get(order_id)
      return payments.refund(order_id, order["total"])

  # This one has no grounding rule — it doesn't need one.
  # The model can call it with just the order_id.
  ```

  This is the recommended pattern when the composite makes business
  sense. It keeps the MCP surface single-call while preserving the
  "fetch then act" discipline.

- **Option 3 (future):** A `logix_plan` meta-tool that accepts a
  multi-step plan. **Strongly not recommended.** It would effectively
  expose `logix.run` to the MCP client, bypassing the catalog entirely.
  See ADR-0006's "Alternatives considered."

### 3.3 Schema advertisement depends on FastMCP version

FastMCP 4.0.8 derives the MCP input schema from `handler(**kwargs)`,
which produces a permissive schema. FastMCP 4.1.x may or may not support
explicit schema registration depending on the minor version.

**Consequence:** the MCP-side schema may be permissive
(`additionalProperties: true`, no required fields) even though the ExecGate
schema is strict.

**What this means:** a client that *ignores* the MCP schema and sends
the right arguments gets a successful call. A client that sends wrong
arguments gets `SCHEMA_VALIDATION_FAILED` from `logix.run`. **The
verifier enforces the real schema; the MCP advertisement is
informational.** No security gap.

If you need the MCP-side schema to match exactly, either:

- Upgrade FastMCP to a version that supports explicit schema
  registration (test with `server.describe()` after upgrade to see what
  FastMCP actually advertises).
- Add a custom `tools/list` middleware in your application (not in
  `execgate_mcp`) if FastMCP's API allows it.

Neither is required for security — the verifier is the boundary.

### 3.4 `context_factory` arity

As noted in §2, `context_factory` takes zero arguments. Per-request
principals require either a per-principal server or a factory that reads
FastMCP's request context (works on FastMCP 4.1.x but is not yet the
documented API).

---

## 4. Proxy mode — verify calls before forwarding

### What it does

`LogixMCPProxy` sits between an MCP client and an untrusted upstream MCP
server. Every incoming call is verified by ExecGate before being forwarded.
The upstream never sees a call that failed verification.

### Why this matters

The MCP ecosystem has a security problem the protocol does not address:

- Tool descriptions can hide prompt-injection payloads.
- Arguments can be fabricated or malformed.
- Side-effecting tools (`rm`, `DELETE`, payment calls) run if the model
  asks.
- No built-in approval gate.

Existing proxies (`mcpwall`, `AgentGuard`, `McpVanguard`, `Aran`) block
by **signature** — a list of `rm -rf` variants and similar patterns.
ExecGate blocks by **schema and policy** — an invented argument, a
disallowed value, or a denied live-state condition is rejected before
the upstream sees the call.

The two approaches are complementary. A signature-based proxy catches
"the model typed a shell command." A schema-based proxy catches "the
model sent arguments the schema doesn't allow." Deploy both when
appropriate.

### Quickstart

```python
import asyncio
from execgate import Logix, Deny
from execgate_mcp import LogixMCPProxy

logix = Logix()

# Optionally pre-configure policies that apply to wrapped tools.
def refund_policy(args, ctx):
    order = db.orders.get(args["order_id"])
    if order["state"] != "delivered":
        return Deny("ORDER_NOT_DELIVERED", "order is still in transit")
    return None

proxy = LogixMCPProxy(logix, "http://upstream-service/mcp")

async def main():
    await proxy.startup()
    # After startup, the proxy has fetched the upstream catalog and
    # registered wrapper capabilities in `logix.registry`.
    logix.authorize("upstream_issue_refund", check=refund_policy)

    try:
        await proxy.run_async()
    finally:
        await proxy.shutdown()

asyncio.run(main())
```

### What `startup()` does

1. Opens an MCP client connection to the upstream.
2. Fetches `tools/list` and wraps each tool as a native `Capability`:
   - `input_schema` derived from the upstream `inputSchema` (via
     `mcp_schema_to_logix`),
   - `handler` forwards to the upstream via `client.call_tool`,
   - `effects="write"` by default (upstream is untrusted),
   - `requires_approval=False` by default; the application can mark
     specific wrapped tools with `logix.require_approval(...)` after
     startup.
3. Registers those capabilities in the ExecGate engine, then builds an
   outer MCP server exposing them.

Every incoming call now goes through ExecGate before reaching the upstream:

```
Client → Proxy → logix.run(plan) → verification pipeline
                                       ↓ (if passed)
                                   upstream.call_tool
                                       ↓
                                     Client
```

### What the proxy catches

- **A client inventing a tool** the upstream does not have →
  `UNKNOWN_CAPABILITY`.
- **Malformed arguments** → `SCHEMA_VALIDATION_FAILED`.
- **A policy attached to a wrapped capability** → `POLICY_REJECTED`
  (e.g., "don't refund more than the remaining balance").
- **An approval requirement** → `APPROVAL_REQUIRED` unless a valid token
  is supplied.
- **An idempotent capability called twice with the same args** → the
  second call returns the cached result without hitting upstream.

### What the proxy does not catch

- A malicious upstream returning fabricated data.
- An upstream `inputSchema` that lies (declares `integer`, receives
  string; ExecGate trusts the declared schema — which is the schema the
  upstream asked for).
- Prompt injection in an upstream tool's `description` or response.
- An upstream tool being *replaced* with a different behavior under the
  same name. (Detected only if the tool's `inputSchema` also changes,
  which changes the snapshot hash.)

For those, compose with a content-scanning proxy.

### Startup failures

If any upstream tool's `inputSchema` uses a keyword `execgate_mcp` cannot
faithfully convert, `startup()` raises `ValueError` naming the tool and
the keyword. The proxy does not start. This is deliberate — silently
weakening a schema at proxy startup would defeat the proxy's purpose.

**Supported schema keywords:**

- `type` — all JSON primitives, `object`, `array`
- `properties`
- `required`
- `additionalProperties: true | false` (not a schema object)
- `items`
- `enum`
- `anyOf`

**Rejected (with a clear error):**

- `$ref`, `$defs`, `definitions`
- `oneOf`, `allOf`, `not`, `if`/`then`/`else`
- `patternProperties`
- `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
- `minLength`, `maxLength`, `pattern`, `format`
- `minItems`, `maxItems`, `uniqueItems`
- `additionalProperties: {schema}` (a schema dict, not a boolean)

The rejection is deliberate. A silently weakened schema is worse than a
clear startup error.

### Lifecycle

- `await proxy.startup()` — connect and register capabilities. Raises if
  already started. On failure, closes the upstream client and leaves
  the proxy in a clean state.
- `await proxy.shutdown()` — close the upstream client. Safe to call if
  not started.
- `await proxy.run_async(**kwargs)` — run the outer server.
- `proxy.run(**kwargs)` — run blocking.
- `proxy.server` — the underlying `LogixMCPServer`.
- `proxy.upstream_tool_names` — the names of the wrapped tools.

### The `FakeMCPClient` for testing

`tests/mcp/conftest.py` provides a `FakeMCPClient` that implements the
surface `logix_mcp.upstream` and `logix_mcp.proxy` depend on:
`__aenter__`, `__aexit__`, `list_tools`, `call_tool`. Use it as a
template for testing your own proxy integrations without a live
upstream.

---

## 5. The leaf-node rule (ADR-0006, ADR-0007)

`execgate_mcp` is a leaf node. It sits between MCP clients/servers and the
ExecGate engine. It:

- **May** import from `execgate.tools` (ToolSpec), `execgate.results`
  (Result, Error), `execgate.engine` (Logix), `execgate.capabilities`
  (Capability), `execgate.context` (ExecutionContext), `execgate.approval`
  (for approval-related paths), `execgate.schemas` (Type constructors),
  `execgate.policies` (Allow/Deny).
- **May not** import from `execgate.verifier`, `execgate.executor`,
  `execgate.ir`, or `execgate._internal`.
- **May not** call `_construct_verified_plan`, `execute_verified`, or
  `verify_plan` directly.

The only way to run a handler from `execgate_mcp` is `logix.run()` or
`logix.execute(verified_plan)`. Both go through the full pipeline.

`tests/mcp/test_leaf_node_boundary.py` enforces this with an AST scan of
every source file in `src/execgate_mcp/`, plus a positive assertion that
every `logiq.*` import is on the documented allowlist.

If you're adding a new feature to `execgate_mcp` and it needs
verifier-internal access, the answer is almost always "put the feature
in `src/logiq/` and expose it through a public method" — not "let
`execgate_mcp` reach into the internals." The trust boundary is not a
convention; it is a structural property.

---

## 6. Operational notes

### FastMCP version

`execgate_mcp` requires `fastmcp>=4,<5`. FastMCP is built on the official
`mcp` Python SDK v2. Pin the minor version you ship against; FastMCP's
API for explicit schema registration varies between minor versions, and
`execgate_mcp.server` adapts to what's available at runtime.

### Async bridge

`logix.run` is synchronous, but MCP handlers are async.
`execgate_mcp.server._build_handler` wraps `logix.run` in
`asyncio.to_thread` — the sync pipeline runs in a worker thread, and the
main event loop stays responsive. Without this, a slow handler would
freeze the whole MCP server.

For the proxy, the wrapper handler runs in that same worker thread, so
it uses `asyncio.run_coroutine_threadsafe(client.call_tool(...), loop)`
to schedule the upstream call on the main loop. This is correct because
`to_thread` frees the loop while the worker thread runs. Do not
"simplify" it to `asyncio.run(...)` inside the handler — that deadlocks.

### Logging

MCP wire traffic is verbose. `execgate_mcp` logs at `INFO` for tool
registration and `DEBUG` for registration paths. It does not log
argument values, handler returns, or plan contents. If you need wire-level
logging, configure FastMCP's middleware — not `execgate_mcp`.

### Testing

- **Server mode:** use `LogixMCPServer.describe()` to inspect the catalog
  without a live transport. Use `tests/mcp/test_wire_protocol.py` as a
  template for end-to-end tests via `fastmcp.Client(server.mcp)`.
- **Proxy mode:** use `FakeMCPClient` from `tests/mcp/conftest.py`.

### Permissions on the stdio transport

When FastMCP runs in stdio mode, the MCP client (Claude Desktop, Cursor,
etc.) spawns the server as a subprocess. The server inherits the
client's working directory and environment. If the server needs a
credential (API key, DB connection), configure it explicitly rather
than relying on inherited env vars that may or may not be present.

---

## 7. When not to use `execgate_mcp`

- **You don't need MCP.** If your application calls ExecGate directly from
  Python, you don't need this package. `logix.run(plan)` is the same
  pipeline MCP server mode runs.
- **You only want MCP transport for internal use.** If both ends are
  your own code, you can skip MCP entirely and pass `dict` plans between
  services. MCP adds wire-protocol overhead for benefits you don't need.
- **You need prompt-injection scanning.** That's a different threat
  model. ExecGate verifies *requests*; content-side scanning (mcpwall,
  Aran) verifies *descriptions and responses*. Compose them; don't
  expect one to do both.
- **You need approval over MCP.** Not supported in 0.1.0. See §3.1.
- **You need multi-step plans over MCP.** Not supported in 0.1.0. See
  §3.2.

---

## 8. Security checklist for MCP deployments

- [ ] **Review what you expose.** Every capability registered on a
      `LogixMCPServer` becomes a tool the client can call. Read the
      catalog; decide if each capability is appropriate for external
      access.
- [ ] **Do not expose approval-required capabilities over MCP** unless
      you have a non-MCP approval path (§3.1).
- [ ] **Do not expose grounded capabilities over MCP** unless the
      composite pattern applies (§3.2).
- [ ] **Attach invariants to anything live-state-sensitive.** A
      capability that reads the database should check ownership /
      state in the invariant, not only in the handler.
- [ ] **Use `context_factory` to supply a real principal**, not the
      default `"mcp"`. Otherwise invariants see an anonymous caller.
- [ ] **Compose with a content-scanning proxy** if your upstream could
      be compromised or the model's output could be prompt-injected.
      ExecGate verifies requests; content scanning is a separate layer.
- [ ] **Treat the MCP client as trusted, or don't.** A local MCP client
      (Claude Desktop, Cursor) runs on the user's machine; the model is
      the user's. A hosted MCP client is different — verify the trust
      model before exposing write capabilities.
- [ ] **Log the `Error.code`** for every MCP call. Codes are stable;
      they let you see policy rejections, schema failures, and
      unexpected tool names.

---

## 9. Reference

- `src/execgate_mcp/adapter.py` — data shaping between ExecGate and MCP
- `src/execgate_mcp/server.py` — server mode
- `src/execgate_mcp/proxy.py` — proxy mode
- `src/execgate_mcp/upstream.py` — fetch and wrap upstream tools
- `src/execgate_mcp/py.typed`
- `docs/adr/0006-adapters-never-touch-trust-boundary.md` — the general adapter rule
- `docs/adr/0007-mcp-leaf-node-boundary.md` — the specific MCP rule
- `tests/mcp/` — the full MCP test suite
- `docs/api-reference.md §17` — MCP API surface
- `docs/ai-integration.md` — provider-neutral catalog and adapter model
- `docs/security.md` — the threat model, including what MCP does not
  protect against
```

