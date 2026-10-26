## `docs/api-reference.md`

```markdown
# API Reference

Every public API in `logiq`, with stability markers, signatures, and
usage. This is the contract; `docs/architecture.md` and
`docs/system-design.md` are the design rationale.

**Status legend:**

- **stable 0.1** — part of the 0.1 contract. Breaking changes need a
  major version bump.
- **experimental** — present in 0.1 but semantics may change between
  minor versions. Pin your version if you rely on it.
- **reserved** — name fixed, semantics deferred. Do not rely on it.

Every example below is real: if it's in this document, it runs.

---

## Table of contents

1. Top-level imports
2. `Logix` — the engine
3. `@logix.capability` — registration
4. `logix.run` / `verify` / `execute` — execution
5. `logix.tools` — AI discovery
6. `logix.schemas` — inspection
7. `logix.registry` — inspection
8. Policies: `authorize`, `require_approval`, `grounding`, `policy`
9. Approval tokens
10. Context
11. Observability: `audit`, `Trace`, `StepTrace`
12. Limits
13. Data types: `Result`, `VerificationReport`, `Error`, `VerifiedPlan`, `ToolSpec`
14. Error codes
15. Optional — `execgate_pydantic`
16. Optional — `execgate_ai`
17. Optional — `execgate_mcp`
18. Reserved APIs
19. What is deliberately not in the API

---

## 1. Top-level imports

The public surface of the core package is small. Everything else lives
in a submodule or an optional adapter.

```python
from execgate import (
    # Engine
    Logix,

    # Execution outcomes
    Result,
    VerificationReport,
    Error,

    # Trusted context
    ExecutionContext,

    # Decisions (returned by invariants)
    Allow,
    Deny,
    RequireApproval,

    # Verified intermediate representation
    VerifiedPlan,

    # AI catalog type
    ToolSpec,

    # Version
    __version__,
)
```

These are all **stable 0.1** unless otherwise noted below.

Optional adapters:

```python
from execgate_pydantic import (PydanticType, HandlerMode, set_handler_mode)
from execgate_ai import (ProviderAdapter, AdapterError, ToolSpec, get_adapter)
from execgate_mcp import (LogixMCPServer, LogixMCPProxy, LogixMCPProxy)
```

The core never imports these. `import execgate` works with none of them
installed (see `tests/pydantic/test_core_without_pydantic.py` and
`tests/mcp/test_core_without_mcp.py`).

---

## 2. `Logix` — the engine

`logix.engine.Logix`. **Stable 0.1.**

The engine is the only object that ties together a capability registry,
a policy set, an invariant registry, a grounding policy, an idempotency
store, and a tool catalog. It holds no AI provider handle; the
application owns the model call.

### `Logix(*, limits=None, idempotency_store=None)` — constructor

Create an isolated engine.

```python
from execgate import Logix

logix = Logix()
```

Parameters:

| Name | Type | Default | Meaning |
|---|---|---|---|
| `limits` | `PlanLimits \| None` | `DEFAULT_LIMITS` | Resource limits for plans |
| `idempotency_store` | `IdempotencyStore \| None` | `InMemoryIdempotencyStore()` | Store for `idempotent=True` capabilities |

Each `Logix()` instance has its own state. Two engines do not share a
registry, a policy set, an invariant registry, a grounding policy, or an
idempotency store.

```python
a = Logix()
b = Logix()
a.limits(max_steps=1)
assert b._limits.max_steps == 32  # unaffected
```

For tests that need isolation, create a new engine. For applications
with multiple trust boundaries or tenants, create one engine per
boundary.

### `logix.registry` — property

`Registry` object. **Stable 0.1.** See §7.

### `logix.schemas` — property

`_SchemaCatalog` object. **Stable 0.1.** See §6.

### `logix.tools` — property

`ToolCatalog` object. **Stable 0.1.** See §5.

---

## 3. `@logix.capability` — registration

`logix.capability` is a property that returns a callable registrar.
This makes all four forms work:

```python
@logix.capability
def add(a: int, b: int) -> int:
    "Add two integers."
    return a + b

@logix.capability(name="math.add", effects="read")
def add(a: int, b: int) -> int:
    "Add two integers."
    return a + b

logix.capability.register(add, name="math.add")

logix.capability.get("add")           # inspect a registered capability
logix.capability.names()              # list all registered names
logix.capability.unregister("add")    # remove a capability
```

### `@logix.capability` — decorator form

**Stable 0.1.** Registers the function and returns **the original
function**, not a wrapper. Direct invocation and unit testing continue to
work.

```python
@logix.capability
def add(a: int, b: int) -> int:
    "Add two integers."
    return a + b

assert add(2, 3) == 5    # still callable as a normal function
assert "add" in logix.registry
```

Decorator arguments:

| Name | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str \| None` | function name | Public capability name |
| `description` | `str \| None` | docstring | Human-readable description |
| `effects` | `"read" \| "write" \| None` | `None` | Advisory effect class |
| `requires_approval` | `bool` | `False` | Approval required to execute |
| `idempotent` | `bool` | `False` | Deduplicate by `(name, args_hash)` |

```python
@logix.capability(name="customer.lookup", effects="read")
def get_customer(customer_id: int) -> dict[str, int]:
    "Retrieve an authorized customer record."
    return {"id": customer_id}

@logix.capability(effects="write", requires_approval=True, idempotent=True)
def issue_refund(order_id: int, amount: float) -> dict[str, int]:
    "Issue a refund."
    return {"refunded": order_id}
```

Registration fails immediately if:

- Any argument lacks an annotation.
- Any annotation is unsupported (`set`, `Any`, bare `dict`, etc.).
- The return annotation is unsupported.
- The function is async, a class, or a method with `self`/`cls` as the
  first parameter.
- The function has `*args` or `**kwargs`.
- The `name` is empty or already registered.

Error message aggregates all annotation problems at once:

```python
@logix.capability
def bad(x, y: set) -> dict:
    return {}
# TypeError: cannot register capability 'bad':
#   parameter 'x': missing annotation
#   parameter 'y': unsupported annotation: set
#   return: unsupported annotation: dict
```

### `logix.capability.register(fn, *, name=None, ...)` — programmatic

**Experimental.** Same effect as the decorator, programmatic form.
Returns the original function.

```python
def add(a: int, b: int) -> int:
    return a + b

logix.capability.register(add, name="math.add")
```

### `logix.capability.get(name)` — lookup

**Stable 0.1.** Returns the registered `Capability` (the dataclass).
Raises `KeyError` if absent.

```python
cap = logix.capability.get("add")
assert cap.name == "add"
assert cap.input_schema.to_json_schema()["properties"]["a"] == {"type": "integer"}
```

### `logix.capability.names()` — list

**Stable 0.1.** Returns registered capability names, in registration
order.

### `logix.capability.unregister(name)` — remove

**Experimental.** Removes the capability. Invalidates the registry
snapshot hash. Raises `KeyError` if absent.

---

## 4. `logix.run` / `verify` / `execute` — execution

Three entry points. `run()` is the convenience. `verify()` + `execute()`
provide explicit control.

### `logix.run(plan, *, context=None) -> Result`

**Stable 0.1.** Verify and execute in one call. Never bypasses a check
because the plan is short.

```python
from execgate import Logix

logix = Logix()

@logix.capability
def add(a: int, b: int) -> int:
    return a + b

result = logix.run({"call": "add", "with": {"a": 10, "b": 20}})
assert result.ok
assert result.value == 30
```

Parameters:

| Name | Type | Default | Meaning |
|---|---|---|---|
| `plan` | `Any` | — | Dict, JSON string, or `CanonicalPlan` |
| `context` | `ExecutionContext \| None` | `None` | Trusted caller context |

Returns a `Result` (§13). Never raises for plan failures; always returns
a `Result` with `ok=True` or `ok=False`.

```python
# Failure case: unknown capability
result = logix.run({"call": "does_not_exist", "with": {}})
assert not result.ok
assert result.errors[0].code == "UNKNOWN_CAPABILITY"

# Failure case: schema violation
result = logix.run({"call": "add", "with": {"a": "ten", "b": 20}})
assert not result.ok
assert result.errors[0].code == "SCHEMA_VALIDATION_FAILED"
```

### `logix.verify(plan, *, context=None) -> VerificationReport`

**Stable 0.1.** Static checks only. Does not invoke any handler. Returns
a `VerificationReport` whose `verified_plan` is a `VerifiedPlan` on
success.

```python
report = logix.verify(
    {"call": "add", "with": {"a": 1, "b": 2}},
    context=logix.context(principal="alice"),
)
if report.ok:
    print(report.verified_plan.verification_hash)
else:
    print([e.code for e in report.errors])
```

Use this when you need to separate "should we do this?" from "do it" —
e.g., to insert a human approval gate.

**Verification is not an authorization grant.** `execute()` re-runs
every check that depends on live state (ADR-0004).

### `logix.execute(verified_plan, *, context=None, approval=None) -> Result`

**Stable 0.1.** Execute a `VerifiedPlan`. Runs the recheck window
before every step.

```python
report = logix.verify(plan, context=ctx)
assert report.ok

# Human approval gate — the AI has no path here.
if ask_human(report.verified_plan):
    token = logix.approval.issue(
        capability="issue_refund",
        args={"order_id": 1, "amount": 5.0},
        context=ctx,
        issuer="human:alice",
    )
    result = logix.execute(report.verified_plan, context=ctx, approval=token)
```

Parameters:

| Name | Type | Default | Meaning |
|---|---|---|---|
| `verified_plan` | `VerifiedPlan` | — | Produced by `verify()` |
| `context` | `ExecutionContext \| None` | `None` | Trusted caller context |
| `approval` | `ApprovalToken \| dict[str, ApprovalToken] \| None` | `None` | Single token or per-capability dict |

**Structural guarantee:** `execute()` accepts only a `VerifiedPlan`
instance. Passing a plain dict — even one claiming `{"verified": true}`
— raises `TypeError`.

```python
try:
    logix.execute({"call": "add", "with": {"a": 1, "b": 2}})
except TypeError as e:
    print(e)  # execute() accepts only a VerifiedPlan produced by verify()
```

`approval` can be a single `ApprovalToken` (applies to any step that
requires approval) or a `dict` mapping capability names / step IDs to
tokens (multi-step plans with distinct approvals).

---

## 5. `logix.tools` — AI discovery

`logix.tools` is the **only** view of the engine an AI is allowed to
see. It exposes capabilities as JSON Schema, never handler code or
internal state.

### `logix.tools.describe() -> list[ToolSpec]`

**Stable 0.1.** Provider-neutral catalog.

```python
specs = logix.tools.describe()
# [ToolSpec(name="add", description="Add two integers.",
#           input_schema={"type": "object",
#                         "properties": {"a": {"type": "integer"},
#                                        "b": {"type": "integer"}},
#                         "required": ["a", "b"],
#                         "additionalProperties": false},
#           output_schema={"type": "integer"},
#           effects=None, approval=None, schema_version="1")]
```

The `input_schema` is the **exact** schema the verifier enforces. The
catalog and the validator cannot disagree.

### `logix.tools.format(provider="json") -> Any`

**Stable 0.1.** Provider-shaped catalog.

| Provider | Behavior |
|---|---|
| `"json"` | Neutral list of dicts (`spec.to_neutral_dict()`) |
| `"openai"` | `[{"type": "function", "function": {...}}]` |
| `"anthropic"` | `[{"name": ..., "input_schema": ...}]` |
| `"gemini"` | `[{"name": ..., "parameters": ...}]` |
| `"local"` | Neutral form (for JSON-mode prompt) |
| Anything else | Neutral form (never raises) |

```python
neutral = logix.tools.format("json")             # always available
openai = logix.tools.format("openai")            # optional adapter
unknown = logix.tools.format("some-new-provider") # falls back to json
```

The `"json"` path requires no optional package and is the guarantee
behind "works with any AI that emits JSON."

### `logix.tools.for_capability(name) -> ToolSpec`

**Stable 0.1.** Single-capability description. Raises `KeyError` if
absent.

### `logix.tools.names() -> list[str]`

**Stable 0.1.** Registered capability names, in registration order.

---

## 6. `logix.schemas` — inspection

Read-only view over the derived schemas.

### `logix.schemas.for_capability(name) -> CapabilitySchema`

**Stable 0.1.** Returns a dataclass with:

- `name: str`
- `description: str`
- `input: dict` — input JSON Schema
- `output: dict | None` — output JSON Schema (or `None` if unannotated)
- `input_type: ObjectType` — the underlying `Type` instance
- `output_type: Type | None` — the underlying `Type` instance

```python
s = logix.schemas.for_capability("issue_refund")
assert s.input["properties"]["amount"]["exclusiveMinimum"] == 0
assert s.input["required"] == ["order_id", "amount"]
assert s.input_type  # ObjectType instance (advanced use)
```

### `logix.schemas.names() -> list[str]`

**Stable 0.1.** Registered capability names.

---

## 7. `logix.registry` — inspection

Read-only view over registered capabilities. The registry is the **only**
source of truth for what can be invoked.

### `logix.registry.get(name) -> Capability`

**Stable 0.1.** Raises `KeyError` if absent.

### `logix.registry.names() -> list[str]`

**Stable 0.1.** Names in registration order.

### `logix.registry.snapshot_hash() -> str`

**Stable 0.1.** A stable digest of every capability's contract. Excludes
the handler implementation — two registries with identical contracts but
different handler code hash identically. Used by the verifier and the
executor to detect registry changes between verify and execute.

### Iteration

**Stable 0.1.** `logix.registry` is iterable in registration order.

```python
for cap in logix.registry:
    print(cap.name, cap.description)
```

### `Capability` fields

| Field | Type | Meaning |
|---|---|---|
| `name` | `str` | Public capability name |
| `description` | `str` | Docstring or explicit override |
| `handler` | `Callable` | The original function |
| `input_schema` | `ObjectType` | Derived input schema |
| `output_schema` | `Type \| None` | Derived output schema (or `None`) |
| `effects` | `"read" \| "write" \| None` | Advisory |
| `requires_approval` | `bool` | Approval required |
| `idempotent` | `bool` | Deduplicate by args |

---

## 8. Policies: `authorize`, `require_approval`, `grounding`, `policy`

### `logix.authorize(capability, *, check) -> None`

**Experimental.** Attach a live-state check. Runs in the recheck window,
immediately before the handler is invoked.

```python
from execgate import Allow, Deny

def refund_policy(args, ctx):
    order = db.orders.get(args["order_id"])
    if order["owner"] != ctx.principal:
        return Deny("NOT_OWNER", "caller does not own this order")
    return Allow()

logix.authorize(issue_refund, check=refund_policy)
logix.authorize("issue_refund", check=refund_policy)  # same, by name
```

The check receives `(args, ctx)` and returns one of:

- `Allow()` — permit.
- `Deny(code, message)` — reject with `POLICY_REJECTED`.
- `RequireApproval(reason)` — route to approval.
- Any other return type → `AUTHORIZATION_FAILED` (fails closed).

A crashing check also produces `AUTHORIZATION_FAILED`. **A check that
raises never silently allows execution.**

### `logix.require_approval(capability, *, principal_bound=True) -> None`

**Experimental.** Mark a capability as approval-gated.

```python
logix.require_approval(issue_refund)
```

After this, executing `issue_refund` without an `ApprovalToken` returns
`APPROVAL_REQUIRED`. The token must match `(capability, args_hash,
principal, context_hash)` exactly.

`principal_bound=True` is accepted for API stability; in 0.1.0 every
token is principal-bound by construction.

### `logix.grounding(*, require_ref_for=(), literal_allowlist=()) -> None`

**Experimental.** Configure grounding rules.

```python
logix.grounding(
    require_ref_for=["issue_refund.amount"],
    literal_allowlist=["get_order.order_id"],
)
```

- `require_ref_for` lists `"<capability>.<argument>"` paths whose value
  must be a `$ref` expression (a validated prior-step output).
- `literal_allowlist` lists paths that may be literals even if they
  would otherwise be required to be refs.

A literal for a `require_ref_for` path (not allowlisted) produces
`GROUNDING_REQUIRED`. Runs at verify time, before the verifier.

### `logix.policy(name, *, rule) -> None`

**Experimental.** Register a named, reusable policy for cross-cutting
rules.

```python
def tenant_guard(plan, ctx):
    ...

logix.policy("tenant_isolation", rule=tenant_guard)
```

Named policies are not run automatically by the pipeline in 0.1.0. The
application invokes them via `logix._policies.run(name, plan, ctx)` (or
`logix._policies.decisions(plan, ctx)` for all). Per-capability dynamic
checks — the ones the executor *does* run — go through
`logix.authorize(...)`.

---

## 9. Approval tokens

`execgate.approval`. **Experimental.**

An `ApprovalToken` is the application's assertion that a specific human
or system approved a specific action with specific arguments, for a
specific principal, in a specific context. The AI cannot construct or
forge one because approval is not part of its output channel.

### `execgate.approval.issue(*, capability, args, context, issuer) -> ApprovalToken`

Issue a token. Must be called from trusted application code (a UI
callback, an admin tool, an upstream system).

```python
from execgate.approval import issue

token = issue(
    capability="issue_refund",
    args={"order_id": 502, "amount": 50.0},
    context=logix.context(principal="alice"),
    issuer="human:alice",
)
```

Validation:

- `capability` must be a non-empty string.
- `args` must be a dict.
- `issuer` must be a non-empty string.

### `ApprovalToken` fields

| Field | Type | Meaning |
|---|---|---|
| `capability` | `str` | Capability name |
| `args_hash` | `str` | SHA-256 of canonical args |
| `principal` | `str` | Principal at issue time |
| `context_hash` | `str` | SHA-256 of context (principal, tenant, roles) |
| `issued_at` | `float` | Unix timestamp |
| `issuer` | `str` | Who issued the approval |

### `ApprovalToken.matches(capability, args, context) -> bool`

Return `True` iff the token binds to exactly this action. All four of
capability, args, principal, and context must match.

### `ApprovalToken.to_dict() -> dict`

Safe serialization for audit. Contains no secrets (no raw args, no raw
context).

---

## 10. Context

`execgate.context.ExecutionContext`. **Experimental.**

Trusted caller identity. Supplied by the application; never by the AI.

### `ExecutionContext(principal, tenant=None, roles=frozenset(), request_id=None, extra={})`

```python
from execgate import ExecutionContext

ctx = ExecutionContext(
    principal="alice",
    tenant="acme",
    roles=frozenset({"support"}),
)
```

Fields:

| Field | Type | Meaning |
|---|---|---|
| `principal` | `str` | The caller's identity (required, non-empty) |
| `tenant` | `str \| None` | Tenant / organization |
| `roles` | `frozenset[str]` | Roles the application has authenticated |
| `request_id` | `str \| None` | Request correlation ID |
| `extra` | `Mapping[str, Any]` | Domain-specific data (frozen) |

The context is **frozen** — `extra` is a `MappingProxyType`. It cannot
be mutated between verify and execute.

### `logix.context(**kwargs) -> ExecutionContext`

**Stable 0.1.** Convenience constructor.

```python
ctx = logix.context(principal="alice", tenant="acme")
```

### `ExecutionContext.with_roles(*roles) -> ExecutionContext`

**Experimental.** Return a copy with additional roles (for tests and
fixtures).

### `ExecutionContext.to_dict() -> dict`

**Stable 0.1.** Safe serialization.

---

## 11. Observability

### `logix.audit(hook) -> None`

**Experimental.** Attach an audit hook.

```python
class MyAudit:
    def on_step(self, event):
        # event: {"execution_id", "step_id", "capability", "status",
        #         "duration_ms", "error_code"}
        logger.info("logiq.step", extra=event)

    def on_result(self, event):
        # event: {"execution_id", "plan_version", "ok", "error_code"}
        logger.info("logiq.result", extra=event)

logix.audit(MyAudit())
```

`on_step` fires after each step. `on_result` fires once per execution.
Exceptions from the hook are swallowed (a broken auditor must not block
legitimate actions).

The hook receives **safe metadata only** — no raw argument values, no
handler return values, no model prompts.

### `Trace`

**Stable 0.1.** Per-execution metadata. `Result.trace` is a `Trace` or
`None`.

Fields:

| Field | Type |
|---|---|
| `execution_id` | `str` (UUID hex) |
| `plan_version` | `str` |
| `verification_duration_ms` | `float` |
| `steps` | `tuple[StepTrace, ...]` |

`Trace.to_dict()` — safe serialization.

### `StepTrace`

**Stable 0.1.** Per-step metadata.

Fields:

| Field | Type |
|---|---|
| `step_id` | `str` |
| `capability` | `str` |
| `status` | `"ok" \| "failed"` |
| `duration_ms` | `float` |
| `error_code` | `str \| None` |

`StepTrace` has no field for argument values, return values, or
exceptions — the absence is structural.

---

## 12. Limits

### `PlanLimits(max_bytes=64_000, max_steps=32, max_depth=8, max_invocations=64)`

**Stable 0.1.** Resource limits for a single plan. Frozen dataclass.

Enforced at parse time for `max_bytes`, `max_steps`, `max_depth`.
`max_invocations` is present for forward compatibility; not enforced by
the executor in 0.1.0.

### `DEFAULT_LIMITS`

**Stable 0.1.** The default `PlanLimits` instance.

### `logix.limits(*, max_steps=None, max_bytes=None, max_depth=None, max_invocations=None) -> None`

**Experimental.** Override one or more limits on the current engine.
Only named limits are changed.

```python
logix.limits(max_steps=5, max_bytes=1000)
# max_depth and max_invocations unchanged
```

`logix._limits` reflects the current values. The engine is isolated —
two engines with different limits do not interfere.

---

## 13. Data types

### `Result`

**Stable 0.1.** Outcome of `run()` or `execute()`.

```python
@dataclass(frozen=True)
class Result:
    ok: bool
    value: Any | None
    errors: tuple[Error, ...]
    trace: Trace | None
    execution_id: str
```

Invariants enforced at construction:

- `ok=True` → `errors == ()` (`Result(ok=True, errors=(e,))` raises).
- `ok=False` → `len(errors) >= 1` (`Result(ok=False, errors=())` raises).

Classmethods:

- `Result.success(value, *, trace=None)` — factory.
- `Result.failure(errors, *, trace=None)` — factory.

Methods:

- `Result.to_dict() -> dict` — safe serialization; JSON-safe.

```python
result = logix.run({"call": "add", "with": {"a": 1, "b": 2}})
if result.ok:
    print(result.value)            # 3
else:
    for e in result.errors:
        print(e.code, e.message)
```

### `VerificationReport`

**Stable 0.1.** Outcome of `verify()`.

```python
@dataclass(frozen=True)
class VerificationReport:
    ok: bool
    verified_plan: VerifiedPlan | None
    errors: tuple[Error, ...]
```

Invariants:

- `ok=True` → `verified_plan is not None`.
- `ok=False` → `verified_plan is None` and `len(errors) >= 1`.

Classmethods:

- `VerificationReport.success(verified_plan)`.
- `VerificationReport.failure(errors)`.

Methods:

- `VerificationReport.to_dict() -> dict`.

### `Error`

**Stable 0.1.** A structured failure.

```python
@dataclass(frozen=True)
class Error:
    code: str                # one of the stable codes (§14)
    message: str             # human-readable, redacted
    path: str | None = None  # e.g. "arguments.customer_id"
    details: dict = {}
```

`Error(code="NOT_A_REAL_CODE", ...)` raises `ValueError` — the code must
be in the stable taxonomy.

Methods:

- `Error.to_dict() -> dict`.

Error codes are the contract. Switch on `code`, not on `message`.

### `VerifiedPlan`

**Stable 0.1.** The verified intermediate representation. Constructed
only by the verifier; frozen; unforgeable from user code. See ADR-0002.

Fields:

| Field | Type | Meaning |
|---|---|---|
| `plan_version` | `str` | The plan's version (currently `"1"`) |
| `steps` | `tuple[VerifiedStep, ...]` | Normalized steps |
| `dependency_order` | `tuple[str, ...]` | Topological order (step IDs) |
| `capability_snapshot_hash` | `str` | Registry hash at verify time |
| `verification_hash` | `str` | Hash of the plan content |
| `single_call` | `bool` | `True` for `{"call": ...}` form |

Methods:

- `VerifiedPlan.serialize() -> dict` — for audit. Re-entering the
  pipeline requires `verify()` on the serialized form.

**`VerifiedPlan(...)` raises `TypeError`** — there is no public
constructor. `logix.execute` is the only sanctioned way to run one.

### `VerifiedStep`

**Stable 0.1.** One normalized step.

Fields: `id: str`, `capability: str`, `arguments: Mapping[str, Any]`
(a `MappingProxyType`).

### `ToolSpec`

**Stable 0.1.** A provider-neutral capability description.

```python
@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict            # JSON Schema
    output_schema: dict | None
    effects: "read" | "write" | None
    approval: "required" | "principal_bound" | None
    schema_version: str           # "1"
```

Methods: `ToolSpec.to_neutral_dict() -> dict`.

---

## 14. Error codes

**Stable 0.1.** Codes are part of the contract. Adding a code is a minor
release. Renaming or removing one is a major release.

| Code | Stage | Handler ran? | Meaning |
|---|---|---|---|
| `INVALID_PLAN` | parse | no | Structurally malformed input |
| `UNKNOWN_CAPABILITY` | verify | no | Capability not in registry |
| `SCHEMA_VALIDATION_FAILED` | verify | no | Argument shape wrong |
| `INVALID_REFERENCE` | verify / execute | no | `$ref` bad path or incompatible type |
| `DEPENDENCY_CYCLE` | verify (defensive) | no | Circular `$ref` |
| `POLICY_REJECTED` | recheck (dynamic) | possibly earlier steps | Invariant returned `Deny`, or snapshot hash changed |
| `AUTHORIZATION_FAILED` | recheck | possibly earlier steps | Invariant raised, or principal changed |
| `APPROVAL_REQUIRED` | recheck | possibly earlier steps | Missing or mismatched approval token |
| `IDEMPOTENCY_CONFLICT` | recheck | no for this step | Same key, different args, or in-flight |
| `RESOURCE_LIMIT_EXCEEDED` | parse | no | `max_bytes`, `max_steps`, `max_depth` |
| `HANDLER_FAILED` | execute | yes, this step | Handler raised |
| `OUTPUT_VALIDATION_FAILED` | execute | yes, this step | Handler returned wrong shape |
| `GROUNDING_REQUIRED` | verify (before verifier) | no | Sensitive arg is a literal |
| `EXECUTION_CANCELLED` | execute | possibly earlier steps | Unexpected internal error |

Two useful distinctions:

1. **"Rejected before any handler ran" vs. "rejected after some ran."**
   The first set (parse / verify / grounding) has no side effects. The
   second set (recheck / execute) may have. `Result.trace` shows which
   steps succeeded.
2. **`HANDLER_FAILED` vs. `OUTPUT_VALIDATION_FAILED`.** "Handler raised"
   vs. "handler ran and returned the wrong shape." Distinct codes so
   callers can distinguish.

Codes are defined as module constants in `execgate.errors`:

```python
from execgate.errors import (
    INVALID_PLAN, UNKNOWN_CAPABILITY, SCHEMA_VALIDATION_FAILED,
    INVALID_REFERENCE, DEPENDENCY_CYCLE, POLICY_REJECTED,
    AUTHORIZATION_FAILED, APPROVAL_REQUIRED, RESOURCE_LIMIT_EXCEEDED,
    HANDLER_FAILED, OUTPUT_VALIDATION_FAILED, EXECUTION_CANCELLED,
    IDEMPOTENCY_CONFLICT, GROUNDING_REQUIRED,
    ALL_CODES,
)
```

---

## 15. Optional — `execgate_pydantic`

`execgate_pydantic` is an optional adapter. It requires `pydantic>=2,<3`.
Importing it without Pydantic installed raises a clear `ImportError`.

See `docs/pydantic.md` for the full guide.

### Installation

```bash
pip install "execgate[pydantic]"
```

### Automatic detection

`@logix.capability` detects Pydantic models in signatures and wraps
them. No user action required.

```python
from pydantic import BaseModel, Field

class CreateOrder(BaseModel):
    product_id: int = Field(ge=0)
    quantity: int = Field(ge=1, le=100)

@logix.capability
def prepare_order(order: CreateOrder) -> dict[str, int]:
    "Prepare an order for review."
    return {"ok": 1}

result = logix.run({
    "call": "prepare_order",
    "with": {"order": {"product_id": 1, "quantity": 5}},
})
```

### `execgate_pydantic.HandlerMode`

**Experimental.** Enum with two values: `MODEL` (handler receives model
instances) and `VALUES` (handler receives plain dicts).

### `execgate_pydantic.set_handler_mode(mode) -> HandlerMode`

**Experimental.** Set the global mode. Accepts `HandlerMode` or its
string value (`"model"`, `"values"`).

### `execgate_pydantic.get_handler_mode() -> HandlerMode`

**Experimental.** Return the current global mode.

### `execgate_pydantic.install(logix) -> None`

**Experimental.** Explicit no-op assertion that the adapter is available.
Raises `ImportError` if not.

### `execgate_pydantic.PydanticType`

**Experimental.** The `Type` implementation that wraps a Pydantic model.
Most users never touch this; it appears in `execgate.schemas` output when a
model-typed field is inspected.

---

## 16. Optional — `execgate_ai`

`execgate_ai` is a leaf-node adapter (ADR-0006) with **zero runtime
dependencies**. It shapes JSON Schema and parses response dicts. It does
not import any provider SDK.

See `docs/ai-integration.md` for the full guide.

### `execgate_ai.get_adapter(name) -> ProviderAdapter`

**Stable 0.1.** Return an adapter for the given provider name. Falls
back to `NeutralJSONAdapter` for unknown names.

```python
from execgate_ai import get_adapter

adapter = get_adapter("openai")
adapter = get_adapter("anthropic")
adapter = get_adapter("gemini")
adapter = get_adapter("local")
adapter = get_adapter("json")                 # neutral
adapter = get_adapter("some-new-provider")    # also neutral
```

### `execgate_ai.ProviderAdapter`

**Stable 0.1.** The protocol every adapter implements.

```python
class ProviderAdapter(Protocol):
    name: str
    def format_tools(self, specs: list[ToolSpec]) -> Any: ...
    def parse_proposal(self, raw: Any) -> dict[str, Any]: ...
```

Two methods. Adapters cannot touch the verifier, executor, or registry.

### `execgate_ai.AdapterError`

**Stable 0.1.** Raised by `parse_proposal` when the response cannot be
translated. Never leaks past the caller; the application translates it
to `INVALID_PLAN` or drops the proposal.

### `execgate_ai.ToolSpec`

Re-exported from `execgate.tools`. Same class.

### Provider modules

**Experimental.** Each provider is a module in `execgate_ai.providers`:

- `execgate_ai.providers.openai` — `OpenAIAdapter`
- `execgate_ai.providers.anthropic` — `AnthropicAdapter`
- `execgate_ai.providers.gemini` — `GeminiAdapter`
- `execgate_ai.providers.local` — `LocalAdapter`

You do not normally import them directly; `get_adapter(name)` returns
the right instance.

### `execgate_ai.prompt_json_mode.build(specs, *, system="", strict=True) -> str`

**Experimental.** Build a system prompt for local models that emit JSON
but lack native tool calling. See `docs/ai-integration.md §7`.

### `execgate_ai.custom_example.ExampleAdapter`

**Experimental.** A reference adapter (~30 lines). Not registered; a
template for writing new adapters.

---

## 17. Optional — `execgate_mcp`

`execgate_mcp` requires `fastmcp>=4,<5`. It is a leaf-node adapter (ADR-0007)
and cannot import `execgate.verifier`, `execgate.executor`, `execgate.ir`, or
`execgate._internal`.

See `docs/mcp.md` for the full guide.

### Installation

```bash
pip install "execgate[mcp]"
```

### `execgate_mcp.LogixMCPServer(logix, *, name="logix", context_factory=None)`

**Experimental.** Expose a Logix engine's capabilities as MCP tools.

```python
from execgate_mcp import LogixMCPServer

server = LogixMCPServer(logix, name="order-service")
server.run()   # stdio by default
```

The engine's registry must be fully populated before constructing the
server. Registering capabilities after the server starts does not add
new tools.

`context_factory` is a zero-argument callable returning an
`ExecutionContext` per tool call. Defaults to
`ExecutionContext(principal="mcp")`.

Methods:

- `server.run(**kwargs)` — run blocking.
- `server.run_async(**kwargs)` — run async.
- `server.mcp` — the underlying FastMCP instance.
- `server.describe()` — raw `tools/list` payload as plain dicts.

**Known limitations (0.1.0):**

- Capabilities with `requires_approval=True` are unreachable — MCP
  clients always get `APPROVAL_REQUIRED`. See `docs/mcp.md`.
- Multi-step plans with `$ref` are not reachable — the server exposes
  single-call tools only.
- `context_factory` is zero-argument; per-request principals from MCP
  auth metadata are not yet supported.

### `execgate_mcp.LogixMCPProxy(logix, upstream, *, name="logix-proxy", context_factory=None)`

**Experimental.** Wrap an untrusted upstream MCP server; verify every
call through ExecGate before forwarding.

```python
import asyncio
from execgate_mcp import LogixMCPProxy

proxy = LogixMCPProxy(logix, "http://upstream-service/mcp")

async def main():
    await proxy.startup()   # fetch upstream tools, register wrapper capabilities
    try:
        await proxy.run_async()
    finally:
        await proxy.shutdown()

asyncio.run(main())
```

Methods:

- `await proxy.startup()` — connect, fetch `tools/list`, wrap each tool
  as a native `Capability`, register.
- `await proxy.shutdown()` — close upstream client. Safe if not started.
- `await proxy.run_async(**kwargs)` — run async.
- `proxy.run(**kwargs)` — run blocking.
- `proxy.server` — the underlying `LogixMCPServer` (after startup).
- `proxy.upstream_tool_names` — wrapped tool names.

**Startup failures:** if an upstream tool's `inputSchema` uses an
unsupported keyword (`oneOf`, `$ref`, `minLength`, ...),
`startup()` raises `ValueError` naming the tool and keyword. The proxy
does not start. Silently weakening a schema would defeat the proxy.

### `execgate_mcp.adapter`

**Stable 0.1.** Pure data-shaping functions:

- `tool_spec_to_mcp_dict(spec) -> dict` — `ToolSpec` → MCP tool.
- `from_mcp_call(name, arguments) -> dict` — MCP call → neutral plan.
- `result_to_mcp_response(result) -> Any` — `Result` → MCP response (or
  raise `ToolError`).
- `format_errors_for_mcp(errors) -> str` — format errors for MCP.
- `mcp_schema_to_logix(schema) -> ObjectType` — MCP JSON Schema → Logix
  `ObjectType`.
- `extract_mcp_result_value(call_result) -> Any` — extract plain value
  from an MCP `CallToolResult`.
- `schema_errors_to_errors(schema_errors) -> list[Error]` — convert
  `SchemaError` instances to `Error`.

---

## 18. Reserved APIs

These names are fixed but have no implementation guarantee in 0.1.0.
They raise `NotImplementedError`.

### `logix.dry_run(plan, *, context=None)` — **reserved**

Would show what would happen without invoking handlers: normalized plan,
dependency order, static decisions. Semantics deferred.

### `logix.explain(plan) -> str` — **reserved**

Would return a human-readable explanation of validation failures.
Semantics deferred.

### `logix.plan(...)` (in `execgate.plans.format`) — **reserved**

Would construct a plan using a supported helper or builder. Semantics
deferred; hand-written dicts and JSON strings are supported today.

---

## 19. What is deliberately not in the API

So the surface stays honest:

- **No `logix.exec(code)`.** Never execute AI-generated Python. See
  ADR-0001.
- **No `logix.call_directly(name, **kwargs)`.** A direct dispatch would
  bypass the pipeline. Handlers are still callable as normal Python
  functions; the *pipeline* is what `logix.run` guarantees.
- **No `logix.set_approval(True)`.** Approval is a bound token, not a
  boolean. See ADR-0004.
- **No `logix.registry.add(cap)` public path for arbitrary dicts.**
  Registration goes through `build_capability`, which enforces schema
  inference.
- **No `VerifiedPlan(...)` public constructor.** See ADR-0002.
- **No `logix.tools.describe_raw()`.** The catalog is always JSON Schema;
  no raw handler reflection is exposed.
- **No AI-provider object inside `Logix`.** The application owns the
  model call.

These are not oversights. Each one would be a channel for bypassing the
verification boundary.

---

## 20. Version and stability summary

| | |
|---|---|
| **Current version** | `0.1.0` (alpha) |
| **Python** | `>=3.11` |
| **Core runtime deps** | none (stdlib only) |
| **Stable APIs** | `Logix`, `run`, `verify`, `execute`, `tools.describe`, `tools.format`, `Result`, `VerificationReport`, `Error`, `VerifiedPlan`, `ToolSpec`, `ExecutionContext`, `PlanLimits`, error codes |
| **Experimental APIs** | `authorize`, `require_approval`, `grounding`, `policy`, `limits`, `audit`, `issue` (approval), `PydanticType` and related, `execgate_mcp` classes, `execgate_ai` providers |
| **Reserved APIs** | `dry_run`, `explain`, `plans.format.plan` |

Stable means the API name and semantics will not change in a minor or
patch release. Experimental means the API exists but may change; pin
your version if you rely on it. Reserved means the name is fixed but
there is no implementation guarantee.

**The core guarantee** — "a plan that fails verification does not reach
a normal handler" — is stable. It will not be weakened in a minor or
patch release.
```

---