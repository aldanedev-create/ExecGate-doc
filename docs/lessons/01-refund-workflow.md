# Lesson 01 — Refund Workflow

Build a refund application with grounding, live-state authorization, human approval, and audit. By the end, you'll have a working `handle_refund_request()` function that:

- Fetches an order.
- Checks that the caller owns it (live-state authorization).
- Checks that the order is in a refundable state (live-state authorization).
- Requires the refund amount to come from the order's total (grounding).
- Requires human approval.
- Logs every step (audit).

**Time:** 40 minutes.

**You will build:** Approximately 80 lines of application code and 50 lines of tests.

**You will understand:** The entire semantic layer.

---

## What you're building

A support agent that can refund orders. The AI proposes; ExecGate verifies; your handlers run.

The critical properties:

1. **A model cannot invent a refund amount.** It must source the amount from a validated prior step using `$ref`.
2. **A model cannot refund another user's order.** A live-state check denies it, even with a valid approval.
3. **A model cannot refund an order that isn't delivered.** A live-state check denies it.
4. **A model cannot refund without approval.** A human must approve out-of-band, and the approval is bound to the exact action.
5. **Every action is auditable.** A trace records what ran, by whom, and with what outcome.

By the end, you'll exercise each property against a hand-written plan. Replace the hand-written plan with an AI proposal, and the same guarantees should hold.

---

## Setup

Create the workspace and file:

```bash
mkdir -p logiq-lessons/01-refund
cd logiq-lessons/01-refund
touch refund_app.py
```

Open `refund_app.py` in your editor. You'll add code in steps.

## Step 1 — The domain (fake, but stateful)

Real refunds interact with a real database. We'll use a dictionary for this lesson. The important thing is that the state is live — it can change between verification and execution.

Add this to `refund_app.py`:

```python
from execgate import Logix

logix = Logix()

# The "database". Live state. Mutable on purpose.
ORDERS: dict[int, dict] = {
    502: {"id": 502, "owner": "alice", "state": "delivered", "total": 50.0},
    777: {"id": 777, "owner": "bob", "state": "shipped", "total": 900.0},
}

REFUNDED: set[int] = set()
```

Three things to notice:

- `ORDERS` is the live state. An order can be delivered, shipped, or refunded. The state can change.
- Order `777` belongs to Bob, while order `502` belongs to Alice. If Alice tries to refund order `777`, the authorization policy will deny it.
- `REFUNDED` is a set. It tracks which orders have been refunded.

## Step 2 — Register two capabilities

Add the following functions to `refund_app.py`:

```python
@logix.capability(effects="read")
def get_order(order_id: int) -> dict[str, float]:
    """Retrieve an order by its ID."""
    order = ORDERS[order_id]
    return {"id": float(order["id"]), "total": order["total"]}


@logix.capability(effects="write")
def issue_refund(order_id: int, amount: float) -> dict[str, float]:
    """Issue a refund for an order."""
    REFUNDED.add(order_id)
    return {"refunded": float(order_id), "amount": amount}
```

There are two capabilities:

- `get_order` reads order information. `effects="read"` identifies it as read-only.
- `issue_refund` writes refund state. `effects="write"` identifies it as a capability with side effects.

Notice that `get_order()` returns only `id` and `total`. Its declared return type is `dict[str, float]`, so both returned values are floats. The full order also contains strings such as `owner` and `state`, which would not match that return type.

The plan can reference `o.id` and `o.total`. The authorization policy will read `owner` and `state` directly from the live order state.

**Unknown order IDs:** `ORDERS[order_id]` raises `KeyError` if the order does not exist. This lesson leaves that exception uncaught. In a production application, handle missing orders explicitly and return an appropriate application-level error.

## Step 3 — Mark refunds as approval-required

Add:

```python
logix.require_approval(issue_refund)
```

Now a plan that calls `issue_refund` without a valid approval token should fail with `APPROVAL_REQUIRED`.

The token must be issued by your application and bound to the exact capability and arguments.

Try it by adding:

```python
plan = {
    "call": "issue_refund",
    "with": {"order_id": 502, "amount": 50.0},
}

result = logix.run(plan)
print(result.ok)
print(result.errors[0].code)
print("502 refunded?", 502 in REFUNDED)
```

Run the file:

```bash
python refund_app.py
```

Expected output:

```text
False
APPROVAL_REQUIRED
502 refunded? False
```

The plan is schema-valid: `order_id` is an integer and `amount` is a float. But `issue_refund` requires approval, and no token was provided.

The handler should not run, so `REFUNDED` remains empty.

## Step 4 — Add live-state authorization

We'll enforce two invariants:

- The caller must own the order.
- The order must be delivered.

Add the imports and policy:

```python
from execgate import Allow, Deny


def refund_policy(args, ctx):
    order = ORDERS[args["order_id"]]

    if order["owner"] != ctx.principal:
        return Deny("NOT_OWNER", "caller does not own this order")

    if order["state"] != "delivered":
        return Deny("NOT_DELIVERED", "order is not in a refundable state")

    return Allow()


logix.authorize(issue_refund, check=refund_policy)
```

The policy receives:

- `args`: the resolved arguments, containing actual values rather than `$ref` expressions.
- `ctx`: the `ExecutionContext` supplied by the caller.

It returns `Allow()` or `Deny(code, message)`.

The authorization check runs in the recheck window, immediately before the handler executes. If it returns `Deny`, the handler does not run and the plan fails with `POLICY_REJECTED`.

Now test the policy:

```python
alice = logix.context(principal="alice")
bob = logix.context(principal="bob")

# Alice tries to refund her own order (502).
# The policy allows it, but approval is still required.
result = logix.run(plan, context=alice)
print(result.errors[0].code)

# Alice tries to refund Bob's order (777).
bob_plan = {
    "call": "issue_refund",
    "with": {"order_id": 777, "amount": 900.0},
}

result = logix.run(bob_plan, context=alice)
print(result.errors[0].code)
print(result.errors[0].message)
```

Expected output from these calls:

```text
APPROVAL_REQUIRED
POLICY_REJECTED
caller does not own this order
```

The first request passes the authorization checks because Alice owns order `502` and it is delivered. However, approval is missing.

The second request is rejected because Alice does not own order `777`. The ownership invariant denies the request before the missing approval becomes the relevant failure.

The invariant runs before the approval check. **Approval does not override authorization.**

## Step 5 — Add grounding

A model could propose `{"amount": 9999.0}`. That value is a valid float, but it is not the actual order total.

Grounding closes this gap by requiring the refund amount to come from a prior step's validated output.

Add:

```python
logix.grounding(require_ref_for=["issue_refund.amount"])
```

Now a refund plan that supplies a literal amount should fail with `GROUNDING_REQUIRED`. The amount must reference a prior step's output.

Test a literal amount:

```python
literal_plan = {
    "version": "1",
    "steps": [
        {"id": "o", "call": "get_order", "with": {"order_id": 502}},
        {
            "id": "r",
            "call": "issue_refund",
            "with": {"order_id": 502, "amount": 9999.0},
        },
    ],
}

result = logix.run(literal_plan, context=alice)
print(result.ok)
print(result.errors[0].code)
```

Run the file:

```bash
python refund_app.py
```

Expected output for these two lines:

```text
False
GROUNDING_REQUIRED
```

The literal `9999.0` is rejected. The refund amount must come from an earlier step.

Now try a grounded plan:

```python
grounded_plan = {
    "version": "1",
    "steps": [
        {"id": "o", "call": "get_order", "with": {"order_id": 502}},
        {
            "id": "r",
            "call": "issue_refund",
            "with": {
                "order_id": 502,
                "amount": {"$ref": "o.total"},
            },
        },
    ],
}

result = logix.run(grounded_plan, context=alice)
print(result.ok)
print(result.errors[0].code if result.errors else "no errors")
```

Expected output:

```text
False
APPROVAL_REQUIRED
```

The plan passes grounding because the amount references `o.total`, which resolves to `50.0`. Alice owns order `502`, and it is delivered. Execution is still blocked because approval is missing.

The plan is grounded and authorized, but it still needs human approval.

## Step 6 — Issue an approval token

The application issues the token after a human approves the action.

Add this import near the top of `refund_app.py`:

```python
from execgate.approval import issue
```

Then add:

```python
# Verify the plan first.
report = logix.verify(grounded_plan, context=alice)
assert report.ok

# The human approves. The token is bound to the exact action.
token = issue(
    capability="issue_refund",
    args={"order_id": 502, "amount": 50.0},
    context=alice,
    issuer="human:alice",
)

result = logix.execute(
    report.verified_plan,
    context=alice,
    approval=token,
)

print(result.ok)
print(result.value)
print("502 refunded?", 502 in REFUNDED)
```

Expected output:

```text
True
{'o': {'id': 502.0, 'total': 50.0}, 'r': {'refunded': 502.0, 'amount': 50.0}}
502 refunded? True
```

The plan runs successfully, and `REFUNDED` now contains order `502`.

Here's what happened:

1. `verify(grounded_plan, context=alice)` performs verification and returns a report containing the verified plan.
2. `issue(...)` constructs an approval token bound to the action.
3. `execute(...)` executes the verified plan. During the recheck window, authorization and approval are checked before the handler runs.

The token binds:

- `capability="issue_refund"` — a token for another capability won't match.
- `args={"order_id": 502, "amount": 50.0}` — a token for a different order or amount won't match.
- `context=alice` — a token issued for a different principal won't match.
- The context's tenant and roles, as described by the token's binding behavior.

If the action or relevant context differs at execution time, the token should be rejected with `APPROVAL_REQUIRED`. A model cannot change the proposed amount after approval and still reuse the same token.

## Step 7 — Add audit logging

Every step should be auditable. Attach an audit hook:

```python
class PrintAudit:
    def on_step(self, event):
        print(
            f"[audit] step={event['capability']} status={event['status']} "
            f"duration={event['duration_ms']:.2f}ms "
            f"error={event['error_code']}"
        )

    def on_result(self, event):
        print(
            f"[audit] result ok={event['ok']} "
            f"execution_id={event['execution_id'][:8]}"
        )


logix.audit(PrintAudit())
```

The example expects the hook to receive metadata such as the capability name, status, duration, error code, and execution ID — not the arguments, return value, or model prompt.

Register the hook before running the calls you want to audit.

A successful two-step plan should produce two step events and one result event. A failed attempt should produce audit events according to the executor's event behavior.

Example output (illustrative timing and execution IDs):

```text
[audit] step=issue_refund status=failed duration=0.15ms error=APPROVAL_REQUIRED
[audit] result ok=False execution_id=abc12345
False
...
[audit] step=get_order status=ok duration=0.42ms error=None
[audit] step=issue_refund status=ok duration=0.88ms error=None
[audit] result ok=True execution_id=def67890
True
...
```

Your actual timing and execution IDs will differ.

## Step 8 — Build `handle_refund_request()`

Now assemble the workflow into a function that a real application can call:

```python
def ask_human_to_approve(verified_plan) -> bool:
    """Stub. In a real app, prompt the user."""
    print(f"Approve: {[s.capability for s in verified_plan.steps]}")
    return True  # Auto-approve for the lesson.


def handle_refund_request(user_message: str, principal: str):
    """
    Handle a refund request.

    1. Get the catalog.
    2. Use a hand-written plan for this lesson.
    3. Verify the plan.
    4. Ask a human to approve.
    5. Execute with the token.
    """
    ctx = logix.context(principal=principal)

    # 1. Get the capability catalog.
    catalog = logix.tools.format("json")

    # 2. Propose a plan.
    # In a real application, an AI client could propose the plan using
    # the catalog. This lesson uses a hand-written plan.
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 502}},
            {
                "id": "r",
                "call": "issue_refund",
                "with": {
                    "order_id": 502,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    # 3. Verify.
    report = logix.verify(plan, context=ctx)
    if not report.ok:
        return {
            "ok": False,
            "stage": "verify",
            "errors": [e.code for e in report.errors],
        }

    # 4. Ask a human to approve.
    # The token is issued by application code, not by the AI.
    if not ask_human_to_approve(report.verified_plan):
        return {
            "ok": False,
            "stage": "approval",
            "message": "User did not approve.",
        }

    token = issue(
        capability="issue_refund",
        args={"order_id": 502, "amount": 50.0},
        context=ctx,
        issuer=f"human:{principal}",
    )

    # 5. Execute.
    result = logix.execute(
        report.verified_plan,
        context=ctx,
        approval=token,
    )

    if result.ok:
        return {"ok": True, "value": result.value}

    return {
        "ok": False,
        "stage": "execute",
        "errors": [e.code for e in result.errors],
    }
```

Call the function:

```python
print(handle_refund_request("Refund $50 on order 502", "alice"))
```

The output should include the approval prompt, audit events, and final result. The exact output depends on the audit event formatting and the representation of the returned values.

The function demonstrates the workflow, but it still uses a fixed order ID and amount. The `user_message` and `catalog` are not used to generate the plan in this example.

In a real application:

- Replace the hand-written plan with a validated plan proposal from your chosen AI integration.
- Replace `ask_human_to_approve()` with a real approval interface.
- Derive the approved action and token arguments from the verified action rather than hard-coding them.
- Keep the verification, approval, and execution steps in the same controlled workflow.

## Step 9 — Test the failure paths

Create `test_refund_app.py`:

```python
import pytest

from execgate.approval import issue

from refund_app import (
    logix,
    ORDERS,
    REFUNDED,
)


def test_wrong_owner_denied():
    """Alice cannot refund Bob's order."""
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 777}},
            {
                "id": "r",
                "call": "issue_refund",
                "with": {
                    "order_id": 777,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    ctx = logix.context(principal="alice")
    result = logix.run(plan, context=ctx)

    assert not result.ok
    assert any(e.code == "POLICY_REJECTED" for e in result.errors)
    assert 777 not in REFUNDED


def test_not_delivered_denied():
    """Bob cannot refund his shipped order (777)."""
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 777}},
            {
                "id": "r",
                "call": "issue_refund",
                "with": {
                    "order_id": 777,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    ctx = logix.context(principal="bob")
    result = logix.run(plan, context=ctx)

    assert not result.ok
    assert any(e.code == "POLICY_REJECTED" for e in result.errors)
    assert 777 not in REFUNDED


def test_hallucinated_amount_rejected():
    """A literal amount fails grounding."""
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 502}},
            {
                "id": "r",
                "call": "issue_refund",
                "with": {"order_id": 502, "amount": 9999.0},
            },
        ],
    }

    ctx = logix.context(principal="alice")
    result = logix.run(plan, context=ctx)

    assert not result.ok
    assert any(e.code == "GROUNDING_REQUIRED" for e in result.errors)


def test_no_approval_denied():
    """A grounded plan without approval fails."""
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 502}},
            {
                "id": "r",
                "call": "issue_refund",
                "with": {
                    "order_id": 502,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    ctx = logix.context(principal="alice")
    result = logix.run(plan, context=ctx)

    assert not result.ok
    assert any(e.code == "APPROVAL_REQUIRED" for e in result.errors)


def test_happy_path():
    """A grounded, approved, owned, delivered refund succeeds."""
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 502}},
            {
                "id": "r",
                "call": "issue_refund",
                "with": {
                    "order_id": 502,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    ctx = logix.context(principal="alice")
    report = logix.verify(plan, context=ctx)
    assert report.ok

    token = issue(
        capability="issue_refund",
        args={"order_id": 502, "amount": 50.0},
        context=ctx,
        issuer="human:alice",
    )

    result = logix.execute(
        report.verified_plan,
        context=ctx,
        approval=token,
    )

    assert result.ok
    assert 502 in REFUNDED


def test_approval_does_not_bypass_ownership():
    """Even with a valid token, Alice cannot refund Bob's order."""
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 777}},
            {
                "id": "r",
                "call": "issue_refund",
                "with": {
                    "order_id": 777,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    ctx = logix.context(principal="alice")
    report = logix.verify(plan, context=ctx)
    assert report.ok

    # Issue a token for Alice refunding 777. Even if a human approved
    # this action, the invariant must still deny it.
    token = issue(
        capability="issue_refund",
        args={"order_id": 777, "amount": 900.0},
        context=ctx,
        issuer="human:alice",
    )

    result = logix.execute(
        report.verified_plan,
        context=ctx,
        approval=token,
    )

    assert not result.ok
    assert any(e.code == "POLICY_REJECTED" for e in result.errors)
    assert 777 not in REFUNDED
```

Run the tests:

```bash
pytest test_refund_app.py -v
```

**Expected:** Six tests pass.

The most important test is `test_approval_does_not_bypass_ownership`. A token for Alice and order `777` is issued. The authorization invariant must still deny the action because Bob owns the order.

The test verifies that approval does not bypass authorization and that the refund handler does not add order `777` to `REFUNDED`.

---

## The complete application

The following is the complete `refund_app.py` file, ready to copy. It combines the domain, capabilities, policies, audit hook, and application function.

```python
"""Lesson 01: Refund workflow with grounding, invariants, approval, and audit."""

from execgate import Logix, Allow, Deny
from execgate.approval import issue

logix = Logix()

# --- Live state (fake database) ---
ORDERS: dict[int, dict] = {
    502: {"id": 502, "owner": "alice", "state": "delivered", "total": 50.0},
    777: {"id": 777, "owner": "bob", "state": "shipped", "total": 900.0},
}

REFUNDED: set[int] = set()


# --- Capabilities ---
@logix.capability(effects="read")
def get_order(order_id: int) -> dict[str, float]:
    """Retrieve an order by its ID."""
    order = ORDERS[order_id]
    return {"id": float(order["id"]), "total": order["total"]}


@logix.capability(effects="write")
def issue_refund(order_id: int, amount: float) -> dict[str, float]:
    """Issue a refund for an order."""
    REFUNDED.add(order_id)
    return {"refunded": float(order_id), "amount": amount}


# --- Policies ---
logix.require_approval(issue_refund)
logix.grounding(require_ref_for=["issue_refund.amount"])


def refund_policy(args, ctx):
    order = ORDERS[args["order_id"]]

    if order["owner"] != ctx.principal:
        return Deny("NOT_OWNER", "caller does not own this order")

    if order["state"] != "delivered":
        return Deny("NOT_DELIVERED", "order is not in a refundable state")

    return Allow()


logix.authorize(issue_refund, check=refund_policy)


# --- Audit ---
class PrintAudit:
    def on_step(self, event):
        print(
            f"[audit] step={event['capability']} status={event['status']} "
            f"duration={event['duration_ms']:.2f}ms "
            f"error={event['error_code']}"
        )

    def on_result(self, event):
        print(
            f"[audit] result ok={event['ok']} "
            f"execution_id={event['execution_id'][:8]}"
        )


logix.audit(PrintAudit())


# --- Application ---
def ask_human_to_approve(verified_plan) -> bool:
    """Stub. In a real app, prompt the user."""
    print(f"Approve: {[s.capability for s in verified_plan.steps]}")
    return True


def handle_refund_request(user_message: str, principal: str):
    """Verify, approve, and execute a hand-written refund plan."""
    ctx = logix.context(principal=principal)

    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 502}},
            {
                "id": "r",
                "call": "issue_refund",
                "with": {
                    "order_id": 502,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    report = logix.verify(plan, context=ctx)
    if not report.ok:
        return {
            "ok": False,
            "stage": "verify",
            "errors": [e.code for e in report.errors],
        }

    if not ask_human_to_approve(report.verified_plan):
        return {
            "ok": False,
            "stage": "approval",
            "message": "User did not approve.",
        }

    token = issue(
        capability="issue_refund",
        args={"order_id": 502, "amount": 50.0},
        context=ctx,
        issuer=f"human:{principal}",
    )

    result = logix.execute(
        report.verified_plan,
        context=ctx,
        approval=token,
    )

    if result.ok:
        return {"ok": True, "value": result.value}

    return {
        "ok": False,
        "stage": "execute",
        "errors": [e.code for e in result.errors],
    }


if __name__ == "__main__":
    print(handle_refund_request("Refund $50 on order 502", "alice"))
```

Run it:

```bash
python refund_app.py
```

You should see the approval prompt, audit events, and final result.

## What you built

A refund workflow that demonstrates:

- **Grounding:** The refund amount comes from the order total rather than an arbitrary literal.
- **Authorization:** Alice cannot refund Bob's order, and shipped orders cannot be refunded.
- **Human approval:** The token is bound to the action and relevant context.
- **Audit:** Execution emits events containing capability, status, duration, and error information.
- **Independent checks:** Approval does not override authorization.

Six tests exercise the expected success and failure paths. The test `test_approval_does_not_bypass_ownership` is especially important: authorization and approval are separate checks.

## What to try next

### 1. Break the approval binding

Issue a token for an amount of `9999.0` while the verified plan resolves to `50.0`. The token should be rejected because its arguments do not match the approved action.

```python
ctx = logix.context(principal="alice")

report = logix.verify(grounded_plan, context=ctx)
assert report.ok

bad_token = issue(
    capability="issue_refund",
    args={"order_id": 502, "amount": 9999.0},
    context=ctx,
    issuer="human:alice",
)

result = logix.execute(
    report.verified_plan,
    context=ctx,
    approval=bad_token,
)

print(result.errors[0].code)  # Expected: APPROVAL_REQUIRED
```

### 2. Change an order's state between verification and execution

What happens if the order changes after verification?

```python
ctx = logix.context(principal="alice")

report = logix.verify(grounded_plan, context=ctx)
assert report.ok

ORDERS[502]["state"] = "shipped"

token = issue(
    capability="issue_refund",
    args={"order_id": 502, "amount": 50.0},
    context=ctx,
    issuer="human:alice",
)

result = logix.execute(
    report.verified_plan,
    context=ctx,
    approval=token,
)

print(result.errors[0].code)  # Expected: POLICY_REJECTED
```

The invariant should run at execution time and see the new state. Verification is not authorization. This demonstrates the principle described in ADR-0004.

**Reset the order state to `"delivered"` before rerunning the happy-path tests.**

### 3. Add a third capability

Try adding `cancel_order(order_id)`. Register it and add an invariant that allows cancellation only for shipped orders, not delivered ones. Extend the tests to cover both cases.

### 4. Replace the hand-written plan with an AI proposal

`logix.tools.format("json")` provides the capability catalog in this example. Write a small script that sends the catalog to your model of choice and validates the returned proposal before execution.

The plan shape remains the same. The AI proposes; ExecGate verifies.

## Where to read more

- [`docs/semantic-layer.md`](../semantic-layer.md) — Sections 2–5: grounding, invariants, approval, and idempotency.
- [`docs/api-reference.md`](../api-reference.md) — Sections 8–9: the API surface used in this lesson.
- [`docs/usage-model.md`](../usage-model.md) — Section 4: the interaction diagram, including the approval gate.
- [`docs/security.md`](../security.md) — What this lesson proves and what it does not.
- [`tests/security/test_schema_validity_not_authorization.py`](../../tests/security/test_schema_validity_not_authorization.py) — The test that formalizes the principle that approval does not bypass authorization.

## What this lesson does not cover

### Idempotency

If the same refund is issued twice, such as after a network retry, the handler can run twice. This lesson does not implement idempotency.

See [`docs/semantic-layer.md`](../semantic-layer.md), Section 6, and [`docs/production-guide.md`](../production-guide.md), Section 6.

### Distributed approvals

The token is issued in the same process as the executor in this example. For an external approval service, the issuer field can record the external authority. The approval mechanism and trust boundary must still be designed appropriately for the application.

### Rate limiting

Real refunds might be rate-limited per principal. This is another possible authorization invariant:

```python
def rate_limit(args, ctx):
    if refunds_today(ctx.principal) > 100:
        return Deny("RATE_LIMITED", "too many refunds today")
    return Allow()
```

The example assumes an application-defined `refunds_today()` function. The actual storage, time window, and concurrency behavior are application-specific.

### Conditional execution in multi-step plans

For a workflow such as “refund if delivered, otherwise escalate,” you may need separate plans or a composite capability. See [`docs/plan-format.md`](../plan-format.md), Section 9, for the documented scope and limitations.

The lesson exercises the semantic layer in one coherent application. Other workflows require their own application-specific rules.

## Next lesson

You've built the Level 3 anchor. Lesson 02 covers multi-tenant isolation — running several applications in one process, each with its own registry, policies, and invariants.

[Continue to Lesson 02 — Multi-Tenant](02-multi-tenant.md)