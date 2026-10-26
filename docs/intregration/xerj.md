# XERJ Integration

[XERJ](https://github.com/xerj-ai/xerj) is a local-first, AI-native search engine. It indexes code, docs, logs, and structured files for BM25, vector, and hybrid search, and exposes an Elasticsearch-compatible HTTP API. It ships an MCP server (`xerj mcp`) and a CLI.

This document covers integrating XERJ with ExecGate. There are three integration shapes; only one is recommended as the default.

**ExecGate does not improve retrieval quality.** XERJ's retrieval is XERJ's. The value of the integration is scoping, authorization, and audit — properties that a permissive MCP schema and a single-principal node do not provide.

---

## 1. What XERJ Provides and What ExecGate Adds

XERJ's MCP server exposes `xerj_search` with a permissive schema: an `index` glob (for example, `"mcpcode-*"`) , a `size`, a `_source` field filter, and an arbitrary Elasticsearch query body. That works well for a single-user local setup. It is not a tenant boundary.

XERJ's own security model states that running with `--insecure` makes every caller a superuser of every index, including `/_memory` namespaces. With TLS and API keys enabled, the node authenticates *a* caller — it does not scope *which* caller sees *which* index.

Four concrete risks follow:

1. **`index` is caller-controlled.** An agent that can set `index: "*"` can read across tenants. ExecGate addresses this by declaring `index: Literal["code", "docs"]` — a narrower schema enforced before the HTTP call.
2. **`size` is unbounded.** A large `size` returns an arbitrarily large result set, creating context-window and proxy-memory problems. A ExecGate capability with `size: Annotated[int, Gt(0), Le(20)]` caps it at the contract level.
3. **Query DSL is arbitrary.** XERJ accepts a full Elasticsearch query body. A native ExecGate capability that takes `query: str` (plain text) and constructs the DSL internally is narrower: an agent cannot directly construct field-probing or wildcard-heavy queries.
4. **`/_memory` writes.** If you expose XERJ's HTTP API directly, its Elasticsearch-compatible surface includes index creation, deletion, and document upsert. Those operations have `effects="write"` and belong behind `logix.require_approval(...)`.

XERJ's MCP server appears to expose only search tools. If you expose the HTTP API directly, you have a broader surface and more reason for approval gating.

---

## 2. Three Integration Shapes

### Shape A — Native ExecGate Capability → XERJ HTTP API (Recommended)

```text
Agent → ExecGate (native xerj_search capability) → XERJ node (HTTP)
```

Register a typed capability that calls the Elasticsearch-compatible `_search` endpoint directly.

```python
import httpx
from typing import Annotated, Literal

from execgate import Deny, Logix
from execgate.schemas import Gt, Le, MaxLength, MinLength

logix = Logix()

XERJ_URL = "http://localhost:7700"  # Your XERJ node
XERJ_API_KEY = "..."


@logix.capability(effects="read")
def xerj_search(
    query: Annotated[str, MinLength(1), MaxLength(200)],
    index: Literal["code", "docs"] = "code",
    size: Annotated[int, Gt(0), Le(20)] = 10,
) -> list[dict[str, str]]:
    """Search the XERJ index for code or docs."""
    response = httpx.post(
        f"{XERJ_URL}/{index}-*/_search",
        headers={"Authorization": f"ApiKey {XERJ_API_KEY}"},
        json={
            "query": {"match": {"body": query}},
            "size": size,
            "_source": ["ax_path", "language", "symbols", "defs", "body"],
        },
        timeout=5.0,
    )
    response.raise_for_status()

    hits = response.json().get("hits", {}).get("hits", [])

    return [
        {
            "path": hit.get("_source", {}).get("ax_path", ""),
            "language": hit.get("_source", {}).get("language", ""),
            "symbols": ",".join(
                hit.get("_source", {}).get("symbols", [])
            ),
        }
        for hit in hits
    ]


# Per-caller scoping — XERJ has no per-caller authorization.
def tenant_scope(args, ctx):
    allowed = (
        {"code", "docs"}
        if ctx.tenant == "internal"
        else {"docs"}
    )

    if args["index"] not in allowed:
        return Deny(
            "INDEX_FORBIDDEN",
            f"tenant {ctx.tenant} cannot read {args['index']}",
        )

    return None


logix.authorize(xerj_search, check=tenant_scope)
```

#### Why This Shape Is Recommended

- **The schema is yours.** `index` is `Literal["code", "docs"]`, not an arbitrary glob. `size` is capped. `query` is a plain string; the handler constructs the query DSL.
- **Authorization is per caller.** `tenant_scope` denies access to an index outside the caller's tenant. XERJ does not provide this tenant-scoping layer itself.
- **One HTTP hop.** There is no MCP layer between ExecGate and XERJ.
- **Effects are declared.** `effects="read"` tells the AI catalog that this capability is read-only, so the AI should not propose it as a write action.
- **Audit is available.** `logix.audit(hook)` can record searches with their principal (`ctx.principal`) and result summary, subject to the audit hook's supported event fields.

If you expose only one integration, use this shape.

### Shape B — `LogixMCPProxy` Around `xerj mcp`

```text
Agent → LogixMCPProxy → xerj mcp (stdio) → XERJ node (HTTP)
```

Use `execgate_mcp.LogixMCPProxy` to wrap `xerj mcp` as an MCP upstream:

```python
import asyncio

from execgate import Deny, Logix
from execgate_mcp import LogixMCPProxy

logix = Logix()


def narrow_index(args, ctx):
    # The xerj_search schema from xerj mcp is permissive.
    # Narrow it here.
    if args.get("index", "") not in ("code", "docs"):
        return Deny(
            "INDEX_FORBIDDEN",
            "index must be code or docs",
        )

    return None


proxy = LogixMCPProxy(logix, "stdio://xerj mcp")


async def main():
    # Fetches tools/list and wraps each tool as a capability.
    await proxy.startup()

    # After startup, attach narrowing invariants.
    logix.authorize("xerj_search", check=narrow_index)

    try:
        await proxy.run_async()
    finally:
        await proxy.shutdown()


asyncio.run(main())
```

#### When This Shape Is Appropriate

- You do not own the XERJ binary, such as when using a shared XERJ node run by another team or an upstream that may change.
- You want to inherit future XERJ tools. `startup()` fetches `tools/list`, so new XERJ capabilities can be wrapped automatically.
- You want a ExecGate enforcement boundary around everything that crosses the MCP boundary.

#### Costs and Limitations

- **Additional hops:** The request crosses the proxy, the XERJ MCP server, and the XERJ HTTP API. Latency adds up.
- **Permissive upstream schemas:** `startup()` accepts `xerj_search` as exposed by XERJ. Its `inputSchema` may allow an Elasticsearch query body. Invariants can narrow runtime behavior, but the schema-level guarantees are weaker than Shape A's `Literal["code", "docs"]`.
- **Unsupported schemas:** If a future XERJ tool uses a JSON Schema keyword that `mcp_schema_to_logix` does not understand — such as `oneOf`, `$ref`, or unsupported constraint keywords — `startup()` raises. This is deliberate: silently downgrading to `AnyType` would defeat the proxy's purpose. However, an XERJ update may require a `execgate_mcp` update.

For a small, stable tool set like XERJ's, Shape A is simpler and tighter. Shape B is more useful when the upstream is untrusted or exposes many changing tools.

### Shape C — Expose Native Capabilities Over MCP to Clients

```text
MCP client (Claude Desktop, Cursor)
    → LogixMCPServer
    → ExecGate (native capabilities)
    → XERJ (HTTP)
```

If you're building for XERJ's primary audience — coding agents and MCP-capable clients — expose your native `xerj_search` capability outward:

```python
from execgate_mcp import LogixMCPServer

# logix is the engine from Shape A, with xerj_search registered.
server = LogixMCPServer(
    logix,
    name="xerj-search",
    context_factory=lambda: logix.context(principal="mcp-user"),
)

server.run()
```

MCP clients see `xerj_search` with the strict schema, including the literal index allowlist and bounded `size`. Every call goes through `logix.run()`, and `tenant_scope` applies.

This is the right shape when the client is the AI — Claude Desktop, Cursor, or a similar MCP client — and you own the XERJ node. It gives MCP clients the full pipeline without a second MCP hop to XERJ.

#### Limits

- **Static context factory:** In version `0.1.0`, `context_factory` is static. All MCP calls receive the same principal. Per-request principals from MCP authentication metadata require a future release; see F5 in the handoff report.
- **Approval-required capabilities:** In version `0.1.0`, approval-required capabilities are unreachable over MCP. If you add a `xerj_index_document` capability with `requires_approval=True`, MCP clients cannot call it successfully; they receive `APPROVAL_REQUIRED`. Document this limitation; see `docs/mcp.md`.

---

## 3. Which Shape Should You Choose?

| Your Situation | Recommended Shape |
|---|---|
| You own the XERJ binary; single-tenant internal use | A |
| You own the XERJ binary; multi-tenant use | A + tenant invariant |
| You expose to MCP clients such as Claude Desktop or Cursor | A + C |
| XERJ is a shared upstream you do not control | B |
| You do not need MCP and call `logix.run()` directly | A |

Shape A covers most cases. Shape B adds verification where the upstream is not trusted. Shape C adds external exposure when MCP clients are the consumers.

**Shapes A + C are the recommended default for a coding-agent scenario:** use a native capability for the trust boundary and an MCP server for the external interface.

---

## 4. Practical Configuration

### XERJ Index Layout

A common layout:

```text
code-<repo>  # One index per repository, or one shared "code" index
docs         # Documentation
_memory      # Agent scratchpad; treat as write-only from agent code
```

The narrower the index set, the easier tenant scoping becomes:

```python
def tenant_scope(args, ctx):
    allowed = {
        "internal": {"code", "docs"},
        "partner": {"docs"},
        "public": {"docs"},
    }.get(ctx.tenant, set())

    if args["index"] not in allowed:
        return Deny(
            "INDEX_FORBIDDEN",
            "not available to this tenant",
        )

    return None
```

### Field Projection

`_source` limits what comes back. Returning `body` for every hit can be expensive. For code search, return `defs` and `symbols`, and include `body` only when the client requests it:

```python
@logix.capability(effects="read")
def xerj_search(
    query: Annotated[str, MinLength(1), MaxLength(200)],
    index: Literal["code", "docs"] = "code",
    size: Annotated[int, Gt(0), Le(20)] = 10,
    include_body: bool = False,
) -> list[dict[str, str]]:
    source = ["ax_path", "language", "symbols", "defs"]

    if include_body:
        source.append("body")

    # Build the XERJ request using `source`.
    ...
```

The AI can see `include_body` in the schema and choose whether to request it. A model that does not know it needs the body will not request it.

### Timeouts

XERJ may return within milliseconds for a local index. Set `timeout=5.0` on the HTTP call.

A timeout surfaces as `HANDLER_FAILED` if that is how the application and ExecGate represent the resulting handler exception. Treat it as a network or upstream problem, not a policy issue.

### Authentication

The API key is a process-level credential. It belongs in `os.environ`, not in the capability's arguments:

```python
import os

XERJ_API_KEY = os.environ["XERJ_API_KEY"]
```

Never accept an API key as a capability argument. If the model could propose `{"api_key": "..."}`, the trust boundary would be moot.

---

## 5. What ExecGate Does Not Do Here

- **It does not improve retrieval quality.** XERJ's reported 94%-versus-38% right-file-first result belongs to XERJ. ExecGate does not alter scoring.
- **It does not sanitize retrieved documents.** A poisoned document returned by search is a content-scanning concern (for example, mcpwall or Aran). If you need scanning, compose the integration with those tools.
- **It does not enforce `--insecure` versus TLS.** XERJ's transport security is XERJ's responsibility. ExecGate narrows what the agent can ask for, not what the port accepts.
- **It does not manage XERJ's index lifecycle.** Creating, reindexing, or deleting indices is an operational concern. If you expose those operations as capabilities, gate them with `requires_approval`.

---

## 6. Testing the Integration

The capability schema can be tested without running XERJ:

```python
from typing import Literal

from execgate import Logix


def test_xerj_capability_scope():
    """The capability schema enforces the index allowlist."""
    logix = Logix()

    @logix.capability(effects="read")
    def xerj_search(
        query: str,
        index: Literal["code", "docs"] = "code",
        size: int = 10,
    ) -> list[dict]:
        return []  # Unused in this test.

    # Unknown index → SCHEMA_VALIDATION_FAILED.
    result = logix.run({
        "call": "xerj_search",
        "with": {
            "query": "merge_segments",
            "index": "_memory",
        },
    })

    assert not result.ok
    assert result.errors[0].code == "SCHEMA_VALIDATION_FAILED"

    # Known index → accepted.
    result = logix.run({
        "call": "xerj_search",
        "with": {
            "query": "merge_segments",
            "index": "code",
        },
    })

    assert result.ok
```

The pattern is simple: the schema is the first defense. A test that calls `logix.run(...)` with a hostile index proves that the schema rejects it.

An end-to-end test against a live XERJ instance is optional. The schema contract can be tested without one.

---

## 7. When a `logiq_xerj` Package Would Make Sense

A dedicated `logiq_xerj` package may be justified if:

- XERJ reaches a stable `1.0.0` release.
- Multiple ExecGate users report writing the same `xerj_search` capability.
- The XERJ HTTP API is stable enough to maintain typed capabilities against.

Until then, this document and an example at `examples/12_xerj_native.py` are the right investment. This approach is reversible — delete two files if necessary — rather than creating a maintenance obligation around a release-candidate binary.

---

## 8. Summary

| Topic | Recommendation or Boundary |
|---|---|
| What ExecGate adds | Scoping, authorization, audit, output validation |
| What ExecGate does not add | Retrieval quality, transport security, content safety |
| Recommended shape | Shape A: native capability → XERJ HTTP |
| When to use Shape B | Untrusted or shared XERJ upstream |
| When to use Shape C | MCP clients are the consumers |
| Example | `examples/12_xerj_native.py` |
