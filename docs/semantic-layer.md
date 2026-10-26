# The Semantic Layer

The core verifies that a plan is *well-formed* and *statically permitted*.

The semantic layer reduces the residual risk that a well-formed plan is *semantically wrong* — the class of failure the core explicitly does not claim to eliminate.

Five concerns, each opt-in:

- **Grounding** — sensitive arguments must come from a `$ref`.
- **Invariants** — live-state checks attached per capability.
- **Recheck** — the per-step window that runs invariants, approval, and idempotency before each handler invocation.
- **Repair loop** — bounded retry with reroute refusal.
- **Idempotency** — per-key deduplication of side effects.

This document is the design rationale and usage guide for each. The code lives in `src/logiq/semantic/`.

---

## 1. The layered model

Logiq has two defensive layers:

| Layer | Eliminates | Determinism |
|---|---|---|
| **Core** | Mechanical failures: invented capabilities, wrong types, malformed plans, dangling refs, static policy | Deterministic; testable |
| **Semantic** | Semantic failures: model-typed sensitive values, unauthorized actions under live state, missing approvals, double side effects | Engineered minimization; probabilistic |

The core cannot eliminate semantic failures. A model that says `{"amount": 50.0}` is producing a schema-valid plan whose *value* is wrong. Only a mechanism that can look at where the value came from can reject it.

That's what grounding does. Where grounding is insufficient (live state, authorization, approval, deduplication), invariants and the recheck window handle it. Where residual risk remains after all of them, the repair loop and idempotency bound the damage.

See `docs/security.md` §"What Logiq does not protect against" for the honest scope.

---

## 2. Grounding

### What it is

Grounding is a policy the application declares. It says: for this capability, this argument must be sourced from a prior step's validated output — not typed by the model.

```python
logix.grounding(require_ref_for=["issue_refund.amount"])
```

With this rule, a plan whose `issue_refund.amount` argument is a literal is rejected:

```python
result = logix.run({
    "steps": [
        {"id": "o", "call": "get_order", "with": {"order_id": 502}},
        {
            "id": "r",
            "call": "issue_refund",
            "with": {
                "order_id": 502,
                "amount": 50.0,  # Literal; grounding rejects this
            },
        },
    ],
})

# result.errors[0].code == "GROUNDING_REQUIRED"
```

The plan must instead supply a `$ref`:

```json
{
  "id": "r",
  "call": "issue_refund",
  "with": {
    "order_id": 502,
    "amount": {"$ref": "o.total"}
  }
}
```

### When to use it

Grounding is per-argument, per-capability. Use it for arguments where:

- The value must correspond to a fact the model has no access to (a refund amount, a customer's balance, an invoice's line items).
- The model has no legitimate source for the value other than a prior tool call (a shipping carrier, a tax rate, an account number).
- A fabricated value would be plausible-looking and harmful.

Do not use it for arguments that legitimately come from the user or the application:

- The user's search query.
- The user's ID, which the application knows.
- A configuration value the plan cannot compute.

For those, use `literal_allowlist`:

```python
logix.grounding(
    require_ref_for=["issue_refund.amount"],
    literal_allowlist=["get_order.order_id"],  # User picks the order
)
```

### What it costs

- **Multi-step plans only.** A single-call plan has no earlier step to reference. Grounding cannot be satisfied by `{"call": "issue_refund", ...}` — the plan must be multi-step.
- **No computation.** A model cannot compute `50.0 * 0.5`. If it wants a partial refund, the application must expose a capability that computes it.
- **MCP limitation.** `LogixMCPServer` exposes single-call tools only. A capability with grounding cannot be exposed over MCP in 0.1.0. See `docs/mcp.md`.

### Where it runs

At verify time, before the verifier. A `GROUNDING_REQUIRED` error names the capability and argument:

```text
GROUNDING_REQUIRED: argument 'issue_refund.amount' must be sourced from a $ref (not a literal value)
```

Checking before the verifier means the error names the intended rule, not a downstream schema mismatch.

### Design rationale

See ADR-0005.

---

## 3. Invariants (`authorize`)

### What they are

An invariant is a live-state check attached to a capability. It receives the resolved arguments and the current `ExecutionContext` and returns a `Decision`:

```python
def refund_policy(args, ctx):
    order = db.orders.get(args["order_id"])

    if order["owner"] != ctx.principal:
        return Deny("NOT_OWNER", "caller does not own this order")

    if order["state"] != "delivered":
        return Deny("NOT_DELIVERED", "order is still in transit")

    return Allow()


logix.authorize(issue_refund, check=refund_policy)
```

### Decision types

- `Allow()` — permit.
- `Deny(code, message)` — reject with `POLICY_REJECTED`. `code` is application-defined; it appears in `Error.details["code"]`.
- `RequireApproval(reason)` — route to the approval flow. If no token is supplied, the result is `APPROVAL_REQUIRED`.

Any other return value (a `bool`, a string, `None`) is treated as an error: `AUTHORIZATION_FAILED: invalid decision type <type>`. An invariant that returns the wrong type is a bug in the invariant, and Logiq fails closed.

### What they cost

- **Live-state reads.** An invariant may query the database, call an external service, or read a cache. Each call runs at execute time, in the recheck window, immediately before the handler.
- **Crashes fail closed.** If an invariant raises, the result is `AUTHORIZATION_FAILED: invariant check for 'X' raised: RuntimeError`. The handler is not invoked. An invariant that crashes is a bug, but the bug does not become a bypass.
- **Run per step in multi-step plans.** A five-step plan runs the invariant for step 3 when step 3 is about to execute, not once for the whole plan. This is correct but means a policy that reads the database runs the query at the moment it matters, not before.

### When to use it

Invariants are the mechanism for authorization decisions that depend on live state:

- Ownership checks (is this the user's order?).
- State transitions (is the order in a refundable state?).
- Rate limits (has the user exceeded their quota?).
- Tenant scoping (does the plan touch another tenant?).
- Business rules that read from the database.

They are the wrong tool for:

- **Static checks that don't depend on live state.** Those belong in the verifier — but the verifier only runs schema-level checks in 0.1.0. For now, static business rules also go through invariants.
- **Prompts or descriptions.** An invariant is a check, not documentation.

### Receiving arguments

The invariant receives the resolved arguments — the values the handler will actually receive, not the `$ref` expressions. This is correct: an invariant that checks `args["amount"] > 0` needs the amount, not `{"$ref": "o.total"}`.

If a `$ref` fails to resolve (a step that ran but didn't return the referenced field), the reference failure happens before the invariant runs. The invariant is only called when the arguments are resolvable.

### Context

`ctx` is the `ExecutionContext` supplied to `logix.run(...)` or `logix.execute(...)`. The AI never supplies a context. The application does.

If the context was refreshed (see §4), the invariant sees the refreshed context.

---

## 4. The recheck window

### What it is

`semantic/recheck.py::recheck_step` is the per-step function that runs between "the plan was verified" and "the handler is invoked." It runs four checks:

1. Context refresh (if a refresher is supplied).
2. Invariants — the `authorize` checks.
3. Approval — the `ApprovalToken` (if required).
4. Idempotency — the store (if the capability is idempotent).

The executor calls it once per step, immediately before invoking the handler. The result is one of:

- **`PROCEED`** — all checks passed; invoke the handler.
- **`REPLAY`** — an idempotent call is being replayed; return the cached value without invoking the handler.
- **`DENY`** — an invariant denied; return `POLICY_REJECTED` or `AUTHORIZATION_FAILED`.
- **`APPROVAL_REQUIRED`** — the approval token is missing or invalid.

Only `PROCEED` and `REPLAY` result in a success (or a cached success). `DENY` and `APPROVAL_REQUIRED` produce failures.

### Order matters

The checks run in order. A crash in the first check stops the others. A `Deny` from the invariant stops before approval is checked.

This ordering is intentional:

1. **Context refresh first** — if the principal changed, everything else is evaluated against the wrong principal. Stop early.
2. **Invariants second** — a `Deny` is a final answer; there's no point checking approval if the invariant says no.
3. **Approval third** — if the invariant says "allow" or "require approval," check for a token.
4. **Idempotency last** — this is the reservation step; if we're going to invoke the handler, we reserve the key.

### Context refresh

A `context_refresher` is an optional zero-argument callable that returns a fresh `ExecutionContext`. When supplied, the recheck window compares the refreshed principal to the original. A change aborts with `AUTHORIZATION_FAILED: principal changed between verify and execute`.

Applications use this when they want to guarantee that a session still valid at verify time is still valid at execute time. It is not enabled by default because it requires the app to construct a refresher that reads session state.

### Why it exists

See ADR-0004.

---

## 5. Approval

### What it is

Approval is a token issued by the application, bound to `(capability, args_hash, principal, context_hash)`. The model cannot construct, forge, or reuse one.

### Flow

```python
# 1. Register the capability and mark it approval-gated.
@logix.capability
def issue_refund(order_id: int, amount: float) -> dict[str, int]:
    ...


logix.require_approval(issue_refund)

# 2. Verify the plan (static checks only; no handler runs).
ctx = logix.context(principal="alice")
report = logix.verify(plan, context=ctx)

if not report.ok:
    return handle_errors(report.errors)

# 3. THE APPROVAL GATE.
#    The AI has no path here. A human (or a system the application
#    trusts) decides to approve this exact action.
approval = ask_human(
    f"Approve {report.verified_plan.steps[0].capability}?"
)

if not approval:
    return "Operation cancelled."

token = logix.approval.issue(
    capability="issue_refund",
    args={"order_id": 502, "amount": 50.0},
    context=ctx,
    issuer="human:alice",
)

# 4. Execute with the token.
result = logix.execute(
    report.verified_plan,
    context=ctx,
    approval=token,
)
```

### What the token binds to

- `capability` — the capability name.
- `args_hash` — a hash of the resolved arguments, order-independent.
- `principal` — the `ctx.principal` at issue time.
- `context_hash` — a hash of the context's principal, tenant, and roles. Not `request_id` or `extra`.

A token matches only if all four are equal at execute time. A change in any of them produces `APPROVAL_REQUIRED`.

### Why issue-time binding matters

Suppose a model proposes a $50 refund. A human approves it. The token is bound to `{"order_id": 502, "amount": 50.0}`. If the model then re-proposes a $9999 refund with the same `order_id` and the same token, the `args_hash` mismatch rejects it. The human approved $50, not $9999. The token enforces that.

Same for principals: a token issued for Alice does not authorize Bob.

### Where to issue

Approval tokens must be issued from application code that the AI does not reach. Typically:

- A UI callback when the user clicks "approve."
- An admin command.
- An upstream system that has decided to grant approval.

The `issue(...)` function is not on the AI's output channel. The AI never sees an `ApprovalToken`.

### Testing approval

```python
from logiq.approval import issue

ctx = logix.context(principal="alice")
args = {"order_id": 502, "amount": 50.0}

report = logix.verify(
    {"call": "issue_refund", "with": args},
    context=ctx,
)

token = issue(
    capability="issue_refund",
    args=args,
    context=ctx,
    issuer="test",
)

result = logix.execute(
    report.verified_plan,
    context=ctx,
    approval=token,
)

assert result.ok
```

---

## 6. Idempotency

### What it is

Idempotency deduplicates side effects across retries. A capability that charges a card, sends an email, or submits an order can be marked `idempotent=True`. Two calls with the same arguments return the first call's result without invoking the handler a second time.

```python
@logix.capability(idempotent=True)
def charge(order_id: int, amount: float) -> dict[str, int]:
    ...
```

### How it works

The executor derives a key from `(capability_name, canonical_args_hash)`:

```python
key = f"{cap.name}:{canonical_args_hash(resolved_args)}"
```

The recheck window calls `store.check_and_reserve(key, args_hash)`, which returns one of:

- **`RESERVED`** — fresh key; proceed with handler invocation.
- **`REPLAY`** — key was committed with the same args; return the cached value without invoking the handler.
- **`CONFLICT`** — key was committed with different args, or is reserved by an in-flight call; reject with `IDEMPOTENCY_CONFLICT`.

After successful handler invocation, the executor calls `store.commit(key, output)`. On failure, it calls `store.release(key)` so a retry can reuse the key.

### What the store looks like

`IdempotencyStore` is a protocol:

```python
class IdempotencyStore(Protocol):
    def check_and_reserve(
        self,
        key: str,
        args_hash: str,
    ) -> IdempotencyResult:
        ...

    def commit(self, key: str, result: Any) -> None:
        ...

    def release(self, key: str) -> None:
        ...
```

`InMemoryIdempotencyStore` is the default; it is thread-safe, single-process, and does not survive restarts. Applications that need durable idempotency implement the protocol against their own store (Redis, Postgres, DynamoDB).

### What it does not do

- **Does not coordinate across processes.** The in-memory store cannot see another process's reservations. Two `logix.run(...)` calls in different processes with the same args will both invoke the handler.
- **Does not survive restarts.** A process crash loses reservations.
- **Does not guarantee exactly-once.** It guarantees "at most once per committed key, in this process." Distributed exactly-once requires durable infrastructure and cooperation from external services — see the spec's p.14 caveat, documented in `docs/production-guide.md`.

For payment, messaging, and order-submission operations where double execution is unacceptable, implement a durable `IdempotencyStore` backed by your database's transaction log or a dedicated idempotency table.

### When to use it

Use it for:

- Capabilities that charge, debit, or transfer money.
- Capabilities that send emails, SMS, or notifications.
- Capabilities that submit orders, create tickets, or otherwise produce side effects that are not naturally idempotent.
- Anywhere a network blip could cause a retry to run the handler twice.

Do not use it for:

- Read-only capabilities (no side effect, nothing to deduplicate).
- Capabilities that are naturally idempotent (setting a value to a specific state) — the deduplication doesn't hurt, but it doesn't help.

---

## 7. The repair loop

### What it is

A bounded retry tracker for the application's agent loop. It enforces:

- **Max attempts** — the model gets a fixed number of tries.
- **Reroute refusal** — after a `POLICY_REJECTED`, `AUTHORIZATION_FAILED`, or `APPROVAL_REQUIRED`, a subsequent plan that touches the same capability or effect class is refused.

### Why reroute refusal matters

The most dangerous repair is the one that routes around a policy:

- The refund was denied because the order isn't delivered. The model proposes a "store credit" — a different write-effect capability that wasn't denied but has the same financial effect.
- The refund was denied because the amount exceeded the refundable balance. The model proposes two smaller refunds.
- The refund was denied for Alice's tenant. The model proposes a refund for a different tenant.

A model that reads `POLICY_REJECTED` as a routing hint is exactly the failure mode Logix prevents. The repair loop catches it.

### Usage

```python
from logiq.semantic import RepairLoop, RepairRefused

loop = RepairLoop(max_attempts=3, registry=logix.registry)

for attempt in range(loop.max_attempts):
    proposal = ai_client.propose(user_msg, tools=catalog)

    # Check the proposal before running it.
    capabilities = [
        step["call"] for step in _extract_calls(proposal)
    ]

    try:
        loop.assert_proposal(capabilities)
    except RepairRefused as e:
        return f"I can't do that — {e}"

    result = logix.run(proposal)
    loop.record_outcome(result.errors)

    if result.ok:
        return result.value

    # Feed structured errors back to the model.
    messages.append({
        "role": "tool",
        "content": json.dumps(
            [e.to_dict() for e in result.errors]
        ),
    })

return "I couldn't complete that after several attempts."
```

### What it tracks

- The number of attempts.
- The capabilities denied in prior attempts (from `Error.details["capability"]`).
- The effect classes (`"read"` / `"write"`) of the denied capabilities.

`check_proposal(capabilities)` returns:

- **`ALLOWED`** — proceed.
- **`EXHAUSTED`** — maximum attempts reached.
- **`REFUSED`** — the plan touches a denied capability or effect class.

`assert_proposal(capabilities)` raises `RepairRefused` with a message describing the reason.

### What it does not catch

- **Semantic reroutes across effect classes.** A write denial does not block a read capability. A model could propose a read that reveals information. This is the application's job.
- **Multi-step reroutes.** A plan that combines a denied capability with allowed ones. The loop checks each capability in the plan; if any is refused, the whole plan is refused.
- **Cross-session reroutes.** The loop is per-request. A model that "remembers" a denial from a prior request could try again; the loop starts fresh each request.

The loop is a bound and a heuristic, not a proof. Combined with invariants (which see live state and are the real defense) and approval (which gates sensitive actions), it closes the most common reroute attempts.

---

## 8. How the pieces compose

A concrete example: refunding an order.

```text
Application configures:
  logix.authorize(issue_refund, check=refund_policy)       # invariants
  logix.require_approval(issue_refund)                    # approval
  logix.grounding(require_ref_for=["issue_refund.amount"]) # grounding

Model proposes:
  {
    "steps": [
      {
        "id": "o",
        "call": "get_order",
        "with": {"order_id": 502}
      },
      {
        "id": "r",
        "call": "issue_refund",
        "with": {
          "order_id": 502,
          "amount": {"$ref": "o.total"}
        }
      }
    ]
  }

Verification:
  parse     → valid multi-step
  grounding → amount is a $ref; ok
  verify    → schemas ok, refs type-check
  → VerifiedPlan

Application inserts a human gate:
  ask_human(VerifiedPlan) → approved

Approval token (issued by application, not model):
  token = issue(
      capability="issue_refund",
      args={"order_id": 502, "amount": 50.0},
      context=ctx,
      issuer="human:alice",
  )

Execution:
  step o: get_order(502) → {"id": 502, "total": 50.0}
  step r (recheck window):
    invariants  → refund_policy({"order_id": 502, "amount": 50.0}, alice) → Allow
    approval    → token.matches("issue_refund", args, ctx) → True
    idempotency → not configured for issue_refund
    → PROCEED
  step r: issue_refund(502, 50.0) → {"refunded": True}
  → Result.success({"o": {...}, "r": {...}})

If ANY check fails, the handler does not run:
  amount literal       → GROUNDING_REQUIRED (before verifier)
  no token             → APPROVAL_REQUIRED (recheck)
  not Alice's order    → POLICY_REJECTED (recheck)
  token for other amount → APPROVAL_REQUIRED (recheck)
```

The five pieces each catch a different class of failure. None of them alone is sufficient. All of them together mean the model's proposal must be grounded, authorized, approved, and deduplicated before any side effect occurs.

---

## 9. Where the code lives

| Concern | Module |
|---|---|
| Grounding policy and check | `semantic/grounding.py` |
| Invariant registry and runner | `semantic/invariants.py` |
| Recheck window | `semantic/recheck.py` |
| Repair loop | `semantic/repair_loop.py` |
| Idempotency store | `semantic/idempotency.py` |
| Approval tokens | `approval.py` |
| Decision types | `policies.py` |
| Engine wiring | `engine.py` |

---

## 10. Test coverage

The semantic layer is tested in:

- `tests/semantic/test_grounding_policy.py`
- `tests/semantic/test_invariants_authorize.py`
- `tests/semantic/test_recheck_on_execute.py`
- `tests/semantic/test_approval_binding.py`
- `tests/semantic/test_repair_loop_bounds.py`
- `tests/semantic/test_idempotency.py`

The security consequences are tested in `tests/security/`:

- `test_schema_validity_not_authorization.py` — invariants are not skipped.
- `test_approval_not_model_settable.py` — approval cannot be forged.
- `test_unknown_capability_never_invokes.py` — handlers are not invoked for unknown capabilities.
