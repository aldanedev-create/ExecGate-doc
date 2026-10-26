# 05 — What Now

You've shipped the Level 2 experience. Here's how to go further.

**Time:** 5 minutes to read; hours to apply.

---

## You have a working boundary

At this point you have:

- **Registered capabilities** — Python functions with inferred schemas.
- **Run plans** — single-call and multi-step, with `$ref` references.
- **Sent a catalog to an AI** — the model proposes JSON, and ExecGate verifies it.
- **Handled failures** — `UNKNOWN_CAPABILITY`, `SCHEMA_VALIDATION_FAILED`, and `GROUNDING_REQUIRED`.

That's Level 2. It's enough for a working application.

Level 3 — production — adds:

- **Live-state authorization** — `logix.authorize(...)`.
- **Human approval** — `logix.require_approval(...)` and tokens.
- **Grounding for sensitive arguments** — `logix.grounding(...)`.
- **Bounded repair** — the `RepairLoop`.
- **Audit** — `logix.audit(hook)`.
- **Separate verification from execution** — the human-approval gate pattern.

Level 3 does not require rewriting what you have. Same capabilities, same catalog, same `logix.run()`. It adds checks around them.

---

## Pick your path

Five paths from here. Pick the one that matches your situation.

### Path A: "I need live authorization and approvals"

Your handlers do things that must be gated by current state — refunds, transfers, or sensitive reads.

**Read:**

- [`docs/lessons/01-refund-workflow.md`](../lessons/01-refund-workflow.md) — the canonical example. Builds a full refund workflow with grounding, invariants, approval, and audit.
- [`docs/semantic-layer.md`](../semantic-layer.md) — the reference for grounding, invariants, approval, and idempotency.
- [`docs/api-reference.md` §8–§9](../api-reference.md) — the API surface for `authorize`, `require_approval`, `grounding`, and `issue`.

### Path B: "I'm already using Pydantic"

Your domain objects are Pydantic models. You want to use them as capability schemas.

**Read:**

- [`docs/pydantic.md`](../pydantic.md) — the adapter guide.
- [`docs/lessons/05-pydantic-models.md`](../lessons/05-pydantic-models.md) — build a capabilities file from existing models.

**Install:**

```bash
pip install "execgate[pydantic]"
```

### Path C: "I'm exposing capabilities to MCP clients"

Claude Desktop, Cursor, or your own MCP client needs to call your capabilities.

**Read:**

- [`docs/mcp.md` §2](../mcp.md) — server mode.
- [`docs/lessons/04-mcp-proxy.md`](../lessons/04-mcp-proxy.md) — the proxy pattern (wrapping an untrusted upstream).

**Install:**

```bash
pip install "execgate[mcp]"
```

**Watch out:** Capabilities with `requires_approval=True` are unreachable over MCP server mode. See `docs/mcp.md` §3.1. Expose those through direct `logix.run()` or `logix.execute()` calls in your application.

### Path D: "I'm wrapping an untrusted MCP server"

You want to add a verification layer in front of an MCP server you don't control.

**Read:**

- [`docs/mcp.md` §4](../mcp.md) — proxy mode.
- [`docs/lessons/04-mcp-proxy.md`](../lessons/04-mcp-proxy.md) — the worked example.

**Install:**

```bash
pip install "execgate[mcp]"
```

**Note:** The proxy rejects upstream schemas it cannot faithfully convert, including `oneOf`, `$ref`, and constraint keywords. If the upstream uses those, the proxy will refuse to start. That's deliberate.

### Path E: "I'm writing a new provider adapter"

Your AI provider isn't OpenAI, Anthropic, Gemini, or local. You want a first-class adapter.

**Read:**

- [`docs/writing-an-adapter.md`](../writing-an-adapter.md) — the 30-line walkthrough.
- [`docs/lessons/03-custom-adapter.md`](../lessons/03-custom-adapter.md) — build a complete adapter with conformance tests.
- [`docs/ai-integration.md`](../ai-integration.md) — the design behind the adapter protocol.

---

## Common pitfalls

From the hands-on report and from watching developers use ExecGate. If you hit one of these, you're not alone.

### `-> dict` fails at registration

```python
@logix.capability
def f() -> dict:  # TypeError: unsupported annotation: dict
    ...
```

A bare `dict` is not a schema. Use `dict[str, int]` or a Pydantic model.

### `float` rejects `int`

```python
@logix.capability
def f(x: float) -> int:
    ...

logix.run({"call": "f", "with": {"x": 5}}).errors
# SCHEMA_VALIDATION_FAILED: expected float, got int
```

No implicit widening. `5.0` is a float; `5` is an int. See ADR-0003.

### `bool` is not `int`

```python
logix.run({"call": "f", "with": {"x": True}}).errors
# SCHEMA_VALIDATION_FAILED: expected int, got bool
```

`True` is not `1` in ExecGate.

### `authorize` requires `Allow()` or `Deny(code, message)`

```python
# WRONG:
logix.authorize(f, check=lambda args, ctx: True)
# AUTHORIZATION_FAILED: invalid decision type bool

# RIGHT:
from execgate import Allow, Deny

logix.authorize(f, check=lambda args, ctx: Allow())
logix.authorize(f, check=lambda args, ctx: Deny("REASON", "why"))
```

The check must return a `Decision`. A raising check fails closed.

### Grounding paths are `"capability.argument"`

```python
logix.grounding(require_ref_for=["amount"])
# ValueError: grounding path must be 'capability.argument'

logix.grounding(require_ref_for=["issue_refund.amount"])
# OK
```

### The `handle` loop

If the model proposes a plan that fails verification, **do not** rerun `logix.run()` with the same plan. Feed `result.errors` back to the model so it can propose a corrected plan. The corrected plan goes through verification again. See [`04-with-an-ai.md`](04-with-an-ai.md) for the pattern.

---

## The one-sentence summary

> **The developer declares what is possible and what is permitted. The AI chooses what to attempt. ExecGate decides what actually happens.**

Every file in this path has been an instance of that split. Every file in `docs/` expands on it.

---

## Where to go next

If you're done with Level 2 and want the reference:

- [`docs/usage-model.md`](../usage-model.md) — developer, AI, and boundary.
- [`docs/system-design.md`](../system-design.md) — the full pipeline.
- [`docs/api-reference.md`](../api-reference.md) — every API.
- [`docs/security.md`](../security.md) — the threat model.

If you want the production guide:

- [`docs/production-guide.md`](../production-guide.md) — deployment, observability, limits, and incident response.

If you want the source:

- [`src/logiq/`](../../src/logiq/) — the code.
- [`tests/security/`](../../tests/security/) — the security guarantees and their tests.

Good luck. If you hit a wall, check the docs first; if the docs don't answer your question, file an issue.

---

## Feedback

The getting-started path is the first thing every developer reads. If any file was confusing, incomplete, or wrong, that's a documentation bug — file it. We'd rather fix a doc than lose a user.
