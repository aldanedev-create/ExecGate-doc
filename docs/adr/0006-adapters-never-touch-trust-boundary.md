
# ADR-0006: Optional adapters are leaf nodes

**Status:** Accepted
**Date:** 2026-10-25
**Supersedes:** —
**Related:** ADR-0007 (MCP specialization), `docs/architecture.md`

---

## Context

Logiq has three optional adapters:

- `logiq_pydantic` — turns Pydantic model classes into capability schemas.
- `logiq_ai` — translates the capability catalog into provider-specific
  tool-call shapes.
- `logiq_mcp` — exposes capabilities to MCP clients (server mode) and
  verifies untrusted upstream MCP servers (proxy mode).

Each adapter needs to interact with Logiq's public API. `logiq_pydantic`
needs to convert annotations; `logiq_ai` needs to read capabilities;
`logiq_mcp` needs to run plans and read results.

The obvious shape for an adapter is: "it's a module that lives in
`src/logiq_*` and does what it needs." The obvious temptation, once an
adapter needs something Logiq exposes only through the verifier or
executor, is to import from those modules directly.

That temptation is a security problem.

If an adapter could import `logiq.executor`, it could invoke
`execute_verified` directly — bypassing `Logix.run()` and `Logix.execute()`.
A bug in the adapter could produce a plan-shaped object that the adapter
*believes* is verified, pass it to the executor, and the executor would
accept it. The structural guarantee "the executor accepts only
`VerifiedPlan`" is bypassed because the adapter constructed the
`VerifiedPlan` instead of the verifier doing it.

If an adapter could import `logiq.verifier`, it could call `verify_plan`
directly and construct a `VerifiedPlan` outside the pipeline. Same
problem.

If an adapter could import `logiq.ir`, it could construct `VerifiedPlan`
objects with `_construct_verified_plan`.

The rule that closes all of this: **adapters are leaf nodes.** They do
not import from `verifier`, `executor`, `ir`, or `_internal`. They
interact with the trust boundary only through the public `Logix` engine
API.

---

## Decision

**Every optional adapter follows the leaf-node rule:**

1. **No import from trust-boundary internals.**

   Source files under `src/logiq_*/` MUST NOT import from:
   - `logiq.verifier`
   - `logiq.executor`
   - `logiq.ir`
   - `logiq._internal`

2. **No direct call to bypass functions.**

   Source files MUST NOT call:
   - `verify_plan`
   - `_construct_verified_plan`
   - `execute_verified`

   The only way to run a handler from an adapter is `Logix.run()` or
   `Logix.execute(verified_plan)`, both of which run the full pipeline.

3. **Imports from `logiq.*` are allowlisted.**

   Each adapter has an explicit list of permitted `logiq.*` modules
   (recorded in its conformance test). Adding a new import requires
   updating the ADR and the allowlist together.

4. **Enforcement.**

   - `tests/mcp/test_leaf_node_boundary.py` AST-scans `src/logiq_mcp/`
     for forbidden imports and forbidden calls, and asserts every
     `logiq.*` import is on the allowlist.
   - The same pattern applies to `logiq_ai` and `logiq_pydantic` via
     their conformance tests.

A PR that weakens this rule is rejected regardless of functionality.

---

## Consequences

**Positive:**

- The trust boundary is **structural**. An adapter has no reference to
  the functions that would let it bypass verification.
- A bug in an adapter cannot violate the guarantee. It can produce a
  malformed plan (which the verifier rejects), or it can fail to call
  `run` (which is a bug, but not a security bug). It cannot call a
  handler without the pipeline.
- Each adapter's test suite can be scoped tightly. The adapter tests
  focus on translation and ergonomics; the trust-boundary tests are in
  `tests/security/` and apply to the core, not to the adapters.
- The rule is uniform across all three adapters. A contributor who
  learns it once applies it everywhere.

**Negative:**

- **Adapter feature velocity is capped.** Some features would be easier
  if the adapter had access to the verifier's internals. E.g., a proxy
  that wants to show the *verified* dependency graph (rather than
  re-deriving it) would naturally want to reach into `ir`. That feature
  is deferred; if it becomes essential, it belongs in `src/logiq/` as a
  public method, not in an adapter.

- **Dependency on the public API surface.** If `logiq` renames a public
  type (`ToolSpec`, `Result`), every adapter breaks and must be updated.
  This is correct — adapters are versioned against the core they
  target — but it means more coordination than a monorepo.

- **Adapters cannot optimize by re-using internal state.** E.g., a proxy
  that wants to cache verified plans would want to know the plan's hash
  and reuse it. The `VerifiedPlan.verification_hash` is public, so this
  is possible without bypassing the rule — but the proxy must re-verify
  (ADR-0004), it cannot cache and skip. The performance cost is
  microseconds; the safety cost of not caching is none.

- **The rule requires discipline to enforce.** The AST scan catches
  direct imports and calls. It does not catch a dynamic `importlib` call
  or a string-concatenated module name. An adapter that *tried* to
  bypass the rule could do so. The point is not to prevent a malicious
  adapter author (they could just edit `src/logiq/`); it is to prevent
  an honest one from taking a shortcut that quietly reopens the trust
  boundary.

---

## Alternatives considered

**Let adapters import the verifier/executor.** Rejected. The structural
guarantee ("the executor accepts only `VerifiedPlan`") is only meaningful
if the executor is the only producer of `VerifiedPlan` invocations. An
adapter that can invoke the executor directly turns the guarantee into
"the executor accepts only `VerifiedPlan` instances, except when called
from an adapter that constructed one outside the verifier" — which is no
guarantee at all.

**Ship adapters in the core package, so they can use internals freely.**
Rejected. `import logiq` would then require Pydantic and/or FastMCP, or
would need optional imports scattered through the core. The core must
stay stdlib-only (`tests/pydantic/test_core_without_pydantic.py` and
`tests/mcp/test_core_without_mcp.py` enforce this). Bundling adapters
into the core defeats that.

**Expose more internals as public API so adapters can use them without
breaking the rule.** Rejected for 0.1.0. Every public API is a contract
that must be maintained. Exposing `verify_plan` or `execute_verified`
publicly means every application can call them directly, which is the
same problem in a different shape. If a specific adapter needs a
specific capability, the right move is to add a narrowly-scoped public
method to `Logix` (e.g., `Logix.get_verified_dependency_graph(plan)`)
that goes through the pipeline, not to expose the verifier.

**Allow adapters to import from `logiq` but prohibit only `verify_plan`
/ `execute_verified` calls.** Rejected. Prohibiting calls but allowing
imports means an adapter could still construct `VerifiedPlan` via
`_construct_verified_plan` (which is imported, not called directly, in
some code shapes) or via reflection. The AST scan catches both the
import and the call; a rule that catches only the call is weaker.

**Trust each adapter to "be careful."** Rejected. The guarantee must
survive a bug. "Be careful" does not survive a bug; a leaf-node rule
does.