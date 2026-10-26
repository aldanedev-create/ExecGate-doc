
# ADR-0007: MCP integration as a leaf-node adapter

**Status:** Accepted
**Date:** 2026-10-25
**Supersedes:** —
**Related:** ADR-0006 (adapters never touch the trust boundary)

---

## Context

Logiq integrates with the Model Context Protocol (MCP) in two modes:

- **Server mode** (`LogixMCPServer`) — expose a Logiq engine's
  capabilities to any MCP client. Every call runs through the full
  Logiq pipeline.
- **Proxy mode** (`LogixMCPProxy`) — verify calls to an untrusted
  upstream MCP server before forwarding.

The proxy mode is, structurally, a **verification boundary in front of
another server.** It would be natural to implement it by reaching into
Logiq's internals:

- Call the verifier directly.
- Construct a `VerifiedPlan` inline.
- Invoke `execute_verified` without going through `Logix.execute()`.

That temptation must be resisted. Every shortcut of that kind
reintroduces the exact risk the boundary exists to prevent: a code path
that *looks* like it verifies but that a subtle bug can make bypass
verification.

If `logiq_mcp` ever grows an import of `logiq.executor`, the guarantee
"a plan that fails verification cannot reach a handler" becomes
conditional on `logiq_mcp` always calling the executor correctly. That
is a much weaker claim than "the executor is not reachable from
`logiq_mcp`."

The same reasoning that produced ADR-0006 applies with more force here,
because MCP's transport is untrusted in both directions:

- **Server mode**: an untrusted MCP client supplies the arguments.
- **Proxy mode**: an untrusted upstream MCP server supplies the tool
  catalog and handles the call.

Neither direction is a peer of the trust boundary. Both are data.

---

## Decision

`logiq_mcp` is a **leaf-node optional adapter**, structurally identical
to `logiq_pydantic` and `logiq_ai`.

Concretely:

### 1. No import of trust-boundary internals

Source files under `src/logiq_mcp/` MUST NOT import from:

- `logiq.verifier`
- `logiq.executor`
- `logiq.ir`
- `logiq._internal`

### 2. No direct call to bypass functions

Source files MUST NOT call:

- `verify_plan`
- `_construct_verified_plan`
- `execute_verified`

The only sanctioned way to run a handler from `logiq_mcp` is
`Logix.run()` or `Logix.execute(verified_plan)`. Both go through the
full pipeline.

### 3. Imports from `logiq.*` are allowlisted

Only these public modules may be imported by `logiq_mcp`:

- `logiq` (version metadata, top-level re-exports)
- `logiq.tools` (`ToolSpec`)
- `logiq.results` (`Result`, `Trace`, `VerificationReport`)
- `logiq.errors` (`Error`, code constants)
- `logiq.context` (`ExecutionContext`)
- `logiq.capabilities` (`Capability` dataclass, `build_capability`)
- `logiq.engine` (`Logix`)
- `logiq.schemas` (`Type` constructors, `ObjectType`, `infer`)
- `logiq.schemas.types`, `logiq.schemas.infer` (submodules of the above)
- `logiq.approval` (for approval-related call paths)
- `logiq.policies` (`Allow`, `Deny`, `RequireApproval`)

Adding a new core import requires updating this ADR and the allowlist
in `tests/mcp/test_leaf_node_boundary.py` together.

### 4. Enforcement

`tests/mcp/test_leaf_node_boundary.py` performs:

- An AST scan of every `.py` file under `src/logiq_mcp/` for forbidden
  imports.
- An AST scan for forbidden function calls (`verify_plan`,
  `_construct_verified_plan`, `execute_verified`).
- A positive assertion that every `logiq.*` import is on the documented
  allowlist.
- A sanity check that the package still imports cleanly.

A PR that weakens this rule is rejected regardless of functionality.

---

## Consequences

**Positive:**

- The trust boundary is **structural**, not **conventional**.
  `logiq_mcp` cannot bypass verification even if a bug tries to — it
  has no reference to the functions that would let it.

- Changing the verifier or executor internals does not require
  reviewing `logiq_mcp`. The public API it depends on is stable, and
  the AST test catches accidental coupling.

- The same rule already governs `logiq_ai` and `logiq_pydantic`. New
  contributors learn one rule and apply it to every adapter.

- The proxy's correctness reduces to "does `logix.run()` work as
  documented?" — which is already covered by the security test suite.
  `logiq_mcp` adds no new correctness obligation at the trust
  boundary.

- A bug in `logiq_mcp` can produce a malformed plan (rejected by the
  verifier) or fail to call `run` (a functionality bug), but it cannot
  invoke a handler without the pipeline.

**Negative:**

- **`logiq_mcp` cannot optimize by caching verified plans across calls
  or by pre-computing verification results.** Every call pays the full
  pipeline cost. This is accepted: verification is microseconds, and
  handler execution dominates.

- **Some features naturally want verifier-internal access.** E.g., a
  proxy that wants to display the *verified* dependency graph rather
  than re-deriving it. Those features are deferred. If they become
  essential, they belong in `src/logiq/` as public methods, not in
  `logiq_mcp`.

- **Dependency on the exact `logiq` public API surface.** If a future
  release renames `ToolSpec` or changes `Result` fields, `logiq_mcp`
  breaks and must be updated. This is correct: adapters are versioned
  against the core they target.

- **The rule requires discipline to enforce.** The AST scan catches
  direct imports and calls. It does not catch a dynamic `importlib`
  call or a string-concatenated module name. The point is not to
  prevent a malicious adapter author (they could edit `src/logiq/`);
  it is to prevent an honest one from taking a shortcut that quietly
  reopens the trust boundary.

- **Approval-required capabilities are unreachable over server mode.**
  Not a consequence of the leaf-node rule per se — but a consequence of
  the trust boundary being where it is: `LogixMCPServer` cannot bypass
  the approval check, and MCP's `tools/call` has no channel for an
  `ApprovalToken`. This limitation is documented in `docs/mcp.md §3.1`.

---

## Alternatives considered

### Direct verifier/executor access

Allow `logiq_mcp` to import `logiq.verifier` and `logiq.executor` to
avoid "going through `Logix`."

**Rejected:** this defeats the structural guarantee. A bug in
`logiq_mcp` could produce a plan that passes verification *as
`logiq_mcp` understands it*, not as the verifier understands it. The
whole point of ADR-0002 (unforgeable IR) is that no code outside the
verifier can produce a `VerifiedPlan`; allowing `logiq_mcp` to call the
verifier directly reopens that.

### In-process verification bypass

Let the proxy verify a plan once and cache the `VerifiedPlan` for
subsequent calls with the same shape.

**Rejected:** verification is not an authorization grant (ADR-0004).
Re-verifying on every call is what makes "every call is checked"
literally true. A cached plan would still need the recheck window to
run, so the caching would save the static checks (microseconds) while
risking a stale-plan vulnerability.

### Bundle `logiq_mcp` into core

Ship it as part of `src/logiq/` so it can use internals.

**Rejected:** this would force every Logiq user to install FastMCP,
breaking the zero-runtime-dependency guarantee (`tests/pydantic/test_core_without_pydantic.py`
and `tests/mcp/test_core_without_mcp.py` enforce this). It would also
put MCP's moving API inside the core's release cadence.

### Restrict `logiq_mcp` to server mode only

Don't implement proxy mode at all; document that users should write
their own proxy.

**Rejected:** the proxy mode is where the security value is highest, and
the leaf-node rule lets us ship it without touching the boundary. The
cost of shipping it is a thin, well-tested wrapper; the cost of not
shipping it is that every user reimplements the same wrapper, usually
less safely.

### Expose more internals as public API

Expose `verify_plan`, `execute_verified`, and `_construct_verified_plan`
publicly so `logiq_mcp` (and anyone else) can use them without breaking
the rule.

**Rejected for 0.1.0:** every public API is a contract that must be
maintained. Exposing these publicly means every application can call
them directly — including applications that aren't adapters. If a
specific adapter needs a specific capability, the right move is to add
a narrowly-scoped public method to `Logix` (e.g.,
`Logix.get_verified_dependency_graph(plan)`) that goes through the
pipeline, not to expose the verifier.

### Trust each adapter to "be careful"

Ship `logiq_mcp` without an enforcement test and trust reviewers to
catch violations.

**Rejected:** the guarantee must survive a bug. "Be careful" does not
survive a bug; an AST scan does. The test is cheap, it runs in the
normal test suite, and it catches accidental coupling in PRs before
they land.

---

## Deferred: approval over MCP

The leaf-node rule is why `LogixMCPServer` cannot carry approvals. An
`ApprovalToken` is issued by the application and passed to
`logix.execute()`. MCP's `tools/call` has no channel for it, and the
`logiq_mcp` adapter cannot bypass the approval check to accept a
token-shaped argument (that would be bypassing verification).

For 0.1.0, the documented workaround is: don't expose approval-required
capabilities over MCP. See `docs/mcp.md §3.1`.

A future release may add:

- **Elicitation-based approval.** FastMCP's `elicit` primitive prompts
  the user mid-call. The model cannot forge it. But elicitation is a
  user prompt, not a separate approval workflow — different security
  property, needs its own ADR before shipping.
- **A separate HTTP endpoint.** The application issues a token via an
  HTTP route; the MCP client supplies it as an opaque argument. This is
  a workaround the application can implement today (issue the token
  in a webhook, pass it through the MCP call as a string). The downside
  is that the token becomes an argument the model could try to invent —
  but the token's signature check would reject any invented one. It's
  usable but fragile; not recommended for 0.1.0.
- **A `logix_plan` meta-tool.** An MCP tool that accepts a full plan
  dict and runs it through `logix.run`. **Strongly not recommended.**
  It would expose arbitrary plan execution to the MCP client, bypassing
  the catalog. See ADR-0006's "Alternatives considered" for the general
  reasoning.

Each of these is a future decision, not a 0.1.0 one.

---

## Reference

- `src/logiq_mcp/` — the adapter package
- `tests/mcp/test_leaf_node_boundary.py` — the enforcement
- `docs/mcp.md` — the integration guide (with §3 for limitations)
- `docs/adr/0006-adapters-never-touch-trust-boundary.md` — the general
  adapter rule that ADR-0007 specializes
- `docs/adr/0002-verified-ir-immutability.md` — why `VerifiedPlan`
  cannot be constructed outside the verifier
- `docs/adr/0004-recheck-on-execute.md` — why caching a
  `VerifiedPlan` would not eliminate the recheck window
```
