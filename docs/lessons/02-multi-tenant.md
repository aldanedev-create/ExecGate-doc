# Lesson 02 — Multi-Tenant

Build an application that serves multiple tenants from one process, with isolated engines, per-tenant policies, and cross-tenant rejection. By the end, you'll have a `TenantRouter` that routes each request to the right engine and demonstrates that one tenant cannot access another tenant's capabilities.

**Time:** 30 minutes.

**You will build:** Approximately 70 lines of application code and 60 lines of tests.

**You will understand:** Engine isolation, per-engine state, and tenant-scoped `ExecutionContext`.

---

## What you're building

A SaaS application where:

- Two tenants exist: `acme` (enterprise) and `globex` (free tier).
- Each tenant has its own `Logix` engine.
- `acme` has a `refund_order` capability; `globex` does not.
- Both tenants have a `read_order` capability.
- `acme` refunds are capped at $5,000. `globex` cannot issue refunds.

The critical properties:

1. **A `globex` plan cannot call `refund_order`.** The capability does not exist in its registry.
2. **A `globex` plan calling `read_order` succeeds.** The capability exists in both registries.
3. **An `acme` plan requesting a refund above $5,000 is denied.** The tenant's limit is enforced by a per-tenant invariant.
4. **Engines are isolated.** Registering a capability on one engine does not affect another.
5. **A `VerifiedPlan` from one engine cannot be executed by another.** The registry snapshot hashes differ.

---

## Setup

Create the workspace and file:

```bash
mkdir -p logiq-lessons/02-multi-tenant
cd logiq-lessons/02-multi-tenant
touch tenants.py
```

Open `tenants.py` in your editor.

## Step 1 — Define the tenant configuration

Start with the tenant configuration:

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class TenantConfig:
    name: str
    max_refund_amount: float
    allows_refunds: bool
```

Two fields are worth noticing:

- `max_refund_amount` defines the tenant's refund limit.
- `allows_refunds` determines whether the tenant has the refund capability at all.

These are different concerns. `acme` allows refunds, with a $5,000 cap. `globex` does not allow refunds, so its refund limit is not used.

Add the configurations:

```python
TENANTS = {
    "acme": TenantConfig(
        name="acme",
        max_refund_amount=5000.0,
        allows_refunds=True,
    ),
    "globex": TenantConfig(
        name="globex",
        max_refund_amount=0.0,
        allows_refunds=False,
    ),
}
```

## Step 2 — Build an engine per tenant

Import the Logiq classes and define `make_engine()`:

```python
from logiq import Logix, Allow, Deny


def make_engine(tenant: TenantConfig) -> Logix:
    """Create a Logix engine for a specific tenant."""
    logix = Logix()

    # Both tenants have read_order.
    @logix.capability(effects="read")
    def read_order(order_id: int) -> dict[str, float]:
        """Retrieve an order by its ID."""
        return {"id": float(order_id), "total": 50.0}

    # Only tenants that allow refunds have refund_order.
    if tenant.allows_refunds:

        @logix.capability(effects="write")
        def refund_order(
            order_id: int,
            amount: float,
        ) -> dict[str, float]:
            """Issue a refund for an order."""
            return {
                "refunded": float(order_id),
                "amount": amount,
            }

        # The refund amount must come from a prior step's output.
        logix.grounding(require_ref_for=["refund_order.amount"])

        # The tenant's refund cap is an invariant.
        def refund_limit(args, ctx):
            if args["amount"] > tenant.max_refund_amount:
                return Deny(
                    "EXCEEDS_LIMIT",
                    f"refund amount exceeds {tenant.name}'s limit of "
                    f"${tenant.max_refund_amount}",
                )
            return Allow()

        logix.authorize(refund_order, check=refund_limit)

    return logix
```

Two things are important here.

**Each engine has its own capability registry.** `globex` never registers `refund_order`. The capability is not merely hidden or disabled; it does not exist in that engine's registry.

**Each invariant captures its tenant configuration.** The `refund_limit` closure for `acme` uses its own refund limit. `globex` has no refund capability, so there is no refund limit to enforce.

Because `TenantConfig` is frozen and the closure captures the configuration passed during engine construction, changing the source configuration later does not update the existing engine's captured limit. Rebuild the engine to apply a new configuration, or deliberately implement runtime configuration reads.

## Step 3 — Build the router

Add the router:

```python
class TenantRouter:
    """Route requests to the right engine based on tenant."""

    def __init__(self, tenants: dict[str, TenantConfig]):
        self._engines = {
            name: make_engine(config)
            for name, config in tenants.items()
        }

    def run(self, tenant: str, plan: dict, *, principal: str):
        """Run a plan against the selected tenant's engine."""
        if tenant not in self._engines:
            raise ValueError(f"unknown tenant: {tenant}")

        logix = self._engines[tenant]
        ctx = logix.context(principal=principal, tenant=tenant)
        return logix.run(plan, context=ctx)

    def engine(self, tenant: str) -> Logix:
        """Access an engine for testing and advanced use."""
        if tenant not in self._engines:
            raise ValueError(f"unknown tenant: {tenant}")
        return self._engines[tenant]

    def tenants(self) -> list[str]:
        return list(self._engines.keys())
```

The router:

- Builds one engine per tenant.
- Keeps each engine's registry separate.
- Routes a plan to the selected engine.
- Passes the tenant into `ExecutionContext`, so invariants can inspect `ctx.tenant` when needed.

Initialize the router:

```python
router = TenantRouter(TENANTS)
print(router.tenants())
```

Expected output:

```text
['acme', 'globex']
```

## Step 4 — Verify capability isolation

Try calling `refund_order` on `globex`:

```python
plan = {
    "call": "refund_order",
    "with": {"order_id": 1, "amount": 50.0},
}

result = router.run("globex", plan, principal="alice")
print(result.ok)
print(result.errors[0].code)
```

Expected output:

```text
False
UNKNOWN_CAPABILITY
```

`globex` does not have `refund_order` in its registry. The plan references a capability that does not exist, so it is rejected before that handler can run.

Now try a grounded refund plan on `acme`:

```python
plan = {
    "version": "1",
    "steps": [
        {
            "id": "o",
            "call": "read_order",
            "with": {"order_id": 1},
        },
        {
            "id": "r",
            "call": "refund_order",
            "with": {
                "order_id": 1,
                "amount": {"$ref": "o.total"},
            },
        },
    ],
}

result = router.run("acme", plan, principal="alice")
print(result.ok)
print(result.value)
```

Expected output:

```text
True
{'o': {'id': 1.0, 'total': 50.0}, 'r': {'refunded': 1.0, 'amount': 50.0}}
```

The same logical operation has different outcomes depending on the selected engine. `globex` rejects the refund with `UNKNOWN_CAPABILITY`, while `acme` allows the grounded refund.

The router selects the engine; that engine's registry and policies determine what can run.

## Step 5 — Try to exceed the refund limit

`acme` has a $5,000 refund cap. To test it, register a read capability on `acme` that returns an order total of $9,999:

```python
logix_acme = router.engine("acme")


@logix_acme.capability(effects="read")
def read_big_order(order_id: int) -> dict[str, float]:
    """Retrieve a large order."""
    return {"id": float(order_id), "total": 9999.0}
```

Create a plan that references the large order's total:

```python
big_plan = {
    "version": "1",
    "steps": [
        {
            "id": "o",
            "call": "read_big_order",
            "with": {"order_id": 1},
        },
        {
            "id": "r",
            "call": "refund_order",
            "with": {
                "order_id": 1,
                "amount": {"$ref": "o.total"},
            },
        },
    ],
}

result = router.run("acme", big_plan, principal="alice")
print(result.ok)
print(result.errors[0].code)
print(result.errors[0].message)
```

Expected output:

```text
False
POLICY_REJECTED
refund amount exceeds acme's limit of $5000.0
```

Grounding passes because the amount comes from a prior step's output. The authorization invariant rejects the refund because `$9,999` exceeds the `$5,000` limit.

The `read_big_order` capability was registered only on `acme`'s engine. `globex`'s registry is unaffected.

## Step 6 — Verify that plans are bound to their engine

A `VerifiedPlan` is tied to the registry snapshot against which it was verified. Let's test what happens when you verify a plan using `acme` and try to execute it using `globex`.

Get both engines:

```python
acme_logix = router.engine("acme")
globex_logix = router.engine("globex")
```

Use the grounded plan:

```python
plan = {
    "version": "1",
    "steps": [
        {
            "id": "o",
            "call": "read_order",
            "with": {"order_id": 1},
        },
        {
            "id": "r",
            "call": "refund_order",
            "with": {
                "order_id": 1,
                "amount": {"$ref": "o.total"},
            },
        },
    ],
}

acme_ctx = acme_logix.context(principal="alice", tenant="acme")
report = acme_logix.verify(plan, context=acme_ctx)
assert report.ok
```

Now try executing the verified plan using `globex`'s engine:

```python
result = globex_logix.execute(report.verified_plan)
print(result.ok)
print(result.errors[0].code)
print(result.errors[0].message)
```

Expected behavior:

```text
False
POLICY_REJECTED
capability registry changed between verify and execute; re-run verify() before executing this plan
```

The exact error message should be confirmed against the implementation.

The `VerifiedPlan` is a valid plan object, so the initial type check should pass. The executor then compares the registry snapshot hash. Because `acme` has capabilities that `globex` does not, the snapshot hashes differ and execution is rejected.

This makes engine isolation structural: a `VerifiedPlan` from one engine cannot simply be reused with another engine.

## Step 7 — The complete application

Replace the contents of `tenants.py` with this complete file:

```python
"""Lesson 02: Multi-tenant Logiq application."""

from dataclasses import dataclass

from logiq import Logix, Allow, Deny


@dataclass(frozen=True)
class TenantConfig:
    name: str
    max_refund_amount: float
    allows_refunds: bool


TENANTS = {
    "acme": TenantConfig(
        name="acme",
        max_refund_amount=5000.0,
        allows_refunds=True,
    ),
    "globex": TenantConfig(
        name="globex",
        max_refund_amount=0.0,
        allows_refunds=False,
    ),
}


def make_engine(tenant: TenantConfig) -> Logix:
    """Create an isolated engine for one tenant."""
    logix = Logix()

    @logix.capability(effects="read")
    def read_order(order_id: int) -> dict[str, float]:
        """Retrieve an order by its ID."""
        return {"id": float(order_id), "total": 50.0}

    if tenant.allows_refunds:

        @logix.capability(effects="write")
        def refund_order(
            order_id: int,
            amount: float,
        ) -> dict[str, float]:
            """Issue a refund for an order."""
            return {
                "refunded": float(order_id),
                "amount": amount,
            }

        logix.grounding(require_ref_for=["refund_order.amount"])

        def refund_limit(args, ctx):
            if args["amount"] > tenant.max_refund_amount:
                return Deny(
                    "EXCEEDS_LIMIT",
                    f"refund amount exceeds {tenant.name}'s limit of "
                    f"${tenant.max_refund_amount}",
                )
            return Allow()

        logix.authorize(refund_order, check=refund_limit)

    return logix


class TenantRouter:
    """Route requests to the right tenant engine."""

    def __init__(self, tenants: dict[str, TenantConfig]):
        self._engines = {
            name: make_engine(config)
            for name, config in tenants.items()
        }

    def run(self, tenant: str, plan: dict, *, principal: str):
        if tenant not in self._engines:
            raise ValueError(f"unknown tenant: {tenant}")

        logix = self._engines[tenant]
        ctx = logix.context(principal=principal, tenant=tenant)
        return logix.run(plan, context=ctx)

    def engine(self, tenant: str) -> Logix:
        if tenant not in self._engines:
            raise ValueError(f"unknown tenant: {tenant}")
        return self._engines[tenant]

    def tenants(self) -> list[str]:
        return list(self._engines.keys())


if __name__ == "__main__":
    router = TenantRouter(TENANTS)
    print("Tenants:", router.tenants())

    plan = {
        "call": "refund_order",
        "with": {"order_id": 1, "amount": 50.0},
    }

    print("\n--- globex cannot refund ---")
    result = router.run("globex", plan, principal="alice")
    print(result.ok, result.errors[0].code if result.errors else "ok")

    print("\n--- acme can refund ---")
    grounded_plan = {
        "version": "1",
        "steps": [
            {
                "id": "o",
                "call": "read_order",
                "with": {"order_id": 1},
            },
            {
                "id": "r",
                "call": "refund_order",
                "with": {
                    "order_id": 1,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    result = router.run("acme", grounded_plan, principal="alice")
    print(result.ok, result.value if result.ok else result.errors)

    print("\n--- acme's VerifiedPlan cannot execute on globex ---")
    acme = router.engine("acme")
    globex = router.engine("globex")

    report = acme.verify(
        grounded_plan,
        context=acme.context(principal="alice", tenant="acme"),
    )
    assert report.ok

    result = globex.execute(report.verified_plan)
    print(result.ok, result.errors[0].code if result.errors else "ok")
```

Run it:

```bash
python tenants.py
```

Expected output:

```text
Tenants: ['acme', 'globex']

--- globex cannot refund ---
False UNKNOWN_CAPABILITY

--- acme can refund ---
True {'o': {'id': 1.0, 'total': 50.0}, 'r': {'refunded': 1.0, 'amount': 50.0}}

--- acme's VerifiedPlan cannot execute on globex ---
False POLICY_REJECTED
```

## Step 8 — Tests

Create `test_tenants.py`:

```python
import pytest

from tenants import TenantRouter, TENANTS


@pytest.fixture
def router():
    return TenantRouter(TENANTS)


def test_globex_cannot_refund(router):
    plan = {
        "call": "refund_order",
        "with": {"order_id": 1, "amount": 50.0},
    }

    result = router.run("globex", plan, principal="alice")

    assert not result.ok
    assert result.errors[0].code == "UNKNOWN_CAPABILITY"


def test_acme_can_refund(router):
    plan = {
        "version": "1",
        "steps": [
            {
                "id": "o",
                "call": "read_order",
                "with": {"order_id": 1},
            },
            {
                "id": "r",
                "call": "refund_order",
                "with": {
                    "order_id": 1,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    result = router.run("acme", plan, principal="alice")

    assert result.ok


def test_acme_limit_enforced(router):
    logix = router.engine("acme")

    @logix.capability(effects="read")
    def read_big_order(order_id: int) -> dict[str, float]:
        return {"id": float(order_id), "total": 9999.0}

    plan = {
        "version": "1",
        "steps": [
            {
                "id": "o",
                "call": "read_big_order",
                "with": {"order_id": 1},
            },
            {
                "id": "r",
                "call": "refund_order",
                "with": {
                    "order_id": 1,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    result = router.run("acme", plan, principal="alice")

    assert not result.ok
    assert result.errors[0].code == "POLICY_REJECTED"
    assert "5000" in result.errors[0].message


def test_engines_isolated(router):
    acme = router.engine("acme")
    globex = router.engine("globex")

    @acme.capability(effects="read")
    def acme_only(x: int) -> int:
        return x

    assert "acme_only" in acme.registry
    assert "acme_only" not in globex.registry

    plan = {"call": "acme_only", "with": {"x": 1}}

    assert router.run("acme", plan, principal="alice").ok

    globex_result = router.run("globex", plan, principal="alice")
    assert not globex_result.ok
    assert globex_result.errors[0].code == "UNKNOWN_CAPABILITY"


def test_verified_plan_bound_to_engine(router):
    acme = router.engine("acme")
    globex = router.engine("globex")

    plan = {
        "version": "1",
        "steps": [
            {
                "id": "o",
                "call": "read_order",
                "with": {"order_id": 1},
            },
            {
                "id": "r",
                "call": "refund_order",
                "with": {
                    "order_id": 1,
                    "amount": {"$ref": "o.total"},
                },
            },
        ],
    }

    acme_ctx = acme.context(principal="alice", tenant="acme")
    report = acme.verify(plan, context=acme_ctx)
    assert report.ok

    result = globex.execute(report.verified_plan)

    assert not result.ok
    assert result.errors[0].code == "POLICY_REJECTED"


def test_unknown_tenant_raises(router):
    with pytest.raises(ValueError, match="unknown tenant"):
        router.run(
            "does-not-exist",
            {"call": "x", "with": {}},
            principal="alice",
        )
```

Run the tests:

```bash
pytest test_tenants.py -v
```

**Expected:** Six tests pass.

## What you built

A multi-tenant application with:

- **One engine per tenant:** Each tenant has its own registry and policies.
- **Capability isolation:** Tenants without a capability receive `UNKNOWN_CAPABILITY` when a plan requests it.
- **Per-tenant invariants:** `acme`'s $5,000 cap is enforced by its engine; `globex` has no refund capability.
- **Cross-engine rejection:** A `VerifiedPlan` verified against one registry cannot execute against another registry with a different snapshot hash.

Six tests exercise these properties.

## What to try next

### 1. Add a Globex tier upgrade

Create a new configuration for `globex` with `allows_refunds=True` and `max_refund_amount=100.0`. Build a new router using that configuration.

Now `globex` should have refund capability, but a $150 refund should be denied while a $50 refund should pass the limit check.

Remember that the example's `read_order()` returns a fixed total of `50.0`. To test a $150 refund, register a test capability that returns a total of `150.0`.

### 2. Share state across tenants

In the current example, handlers return demonstration data rather than accessing a database. Modify the handlers to read from a shared `ORDERS` dictionary.

Test that a `$ref` into `read_order`'s output works as expected. The reference points to a prior step's output field; it does not itself provide tenant isolation. Your handlers and authorization policies must still enforce the appropriate data-access rules.

### 3. Add a cross-tenant invariant

Suppose the application has a rule: no tenant can refund more than $10,000 in one day.

Attach an invariant that reads a shared refund log. This is a shared rule rather than a per-tenant limit. It runs on each relevant engine while consulting shared state.

You'll need to define the log's storage, concurrency behavior, and reset policy for testing.

### 4. Add runtime tenant-configuration refresh

What if `acme`'s cap changes from $5,000 to $1,000 between `verify()` and `execute()`?

The example captures a frozen `TenantConfig` when the engine is built. Its current invariant therefore continues to use the captured value.

To support runtime configuration changes, make the invariant read the current configuration from a controlled shared source at recheck time. Test that a $3,000 refund is denied after the cap changes to $1,000.

Registry snapshot protection covers the capability registry; it should not be assumed to automatically snapshot external configuration or shared state.

## Where to read more

- [`docs/architecture.md`](../architecture.md) — Engine isolation as a design principle.
- [`docs/system-design.md`](../system-design.md) — Section 9: performance and state isolation.
- [`docs/api-reference.md`](../api-reference.md) — Section 2: creating multiple `Logix` instances.
- [`docs/security.md`](../security.md) — The snapshot-hash check as a security property.

## Next lesson

You've built multi-tenant isolation. Lesson 03 covers custom provider adapters — writing a translation layer for an AI SDK that `logiq_ai` does not ship with.

[Continue to Lesson 03 — Custom Adapter](03-custom-adapter.md)