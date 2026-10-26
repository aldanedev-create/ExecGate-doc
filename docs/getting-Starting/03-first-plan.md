# 03 — Your First Plan

Write a multi-step plan with `$ref` references, watch it succeed, then watch it fail when the reference is wrong.

**Time:** 5 minutes.

---

## Two shapes of a plan

ExecGate accepts two plan shapes.

**Single-call** (what you used in file 02):

```json
{
  "call": "add",
  "with": {
    "a": 1,
    "b": 2
  }
}
```

**Multi-step:**

```json
{
  "version": "1",
  "steps": [
    {
      "id": "o",
      "call": "get_order",
      "with": {
        "order_id": 502
      }
    },
    {
      "id": "r",
      "call": "refund",
      "with": {
        "order_id": {
          "$ref": "o.id"
        },
        "amount": {
          "$ref": "o.total"
        }
      }
    }
  ]
}
```

The difference is `steps`. Each step has an `id`, a `call` (capability name), and `with` (arguments). Steps can reference earlier steps via `$ref`.

`$ref` is the mechanism that makes multi-step plans useful. It says, "This argument comes from a prior step's validated output."

---

## Build a two-step plan

Create `refund.py`:

```python
from execgate import Logix

logix = Logix()


@logix.capability
def get_order(order_id: int) -> dict[str, float]:
    """Retrieve an order by ID."""
    return {"id": float(order_id), "total": 50.0}


@logix.capability
def refund(order_id: float, amount: float) -> dict[str, float]:
    """Issue a refund."""
    return {"refunded": order_id, "amount": amount}


plan = {
    "version": "1",
    "steps": [
        {"id": "o", "call": "get_order", "with": {"order_id": 502}},
        {
            "id": "r",
            "call": "refund",
            "with": {
                "order_id": {"$ref": "o.id"},
                "amount": {"$ref": "o.total"},
            },
        },
    ],
}

result = logix.run(plan)
print(result.ok)
print(result.value)
```

Run it:

```bash
python refund.py
```

Expected output:

```text
True
{'o': {'id': 502.0, 'total': 50.0}, 'r': {'refunded': 502.0, 'amount': 50.0}}
```

Three things happened:

1. Step `o` ran first. Its output, `{'id': 502.0, 'total': 50.0}`, was stored.
2. Step `r`'s arguments were resolved: `order_id` became `502.0`, and `amount` became `50.0`. Both came from `o`'s output.
3. `refund(502.0, 50.0)` ran. Its output was stored under `r`.

The result is a dictionary of step outputs, not just the final step's value. That's the multi-step result shape. Single-call plans return the value directly; multi-step plans return `{step_id: value}`.

---

## Why `$ref` matters

The refund amount `50.0` was not written in the plan. It was resolved from `o.total`. The model didn't have to know the amount or guess it. The plan says, "Use whatever `get_order` returned as the refundable total."

Compare that with a literal value:

```python
bad_plan = {
    "version": "1",
    "steps": [
        {"id": "o", "call": "get_order", "with": {"order_id": 502}},
        {
            "id": "r",
            "call": "refund",
            "with": {
                "order_id": {"$ref": "o.id"},
                "amount": 9999.0,  # Literal value
            },
        },
    ],
}

result = logix.run(bad_plan)
print(result.ok)
```

Output:

```text
True
```

This succeeds. Without grounding configured, a literal amount is allowed. The schema says `amount: float`; `9999.0` is a float, so it passes schema validation and runs.

This is the **"hallucinated amount" gap**. A model could propose `{"amount": 9999.0}`, and the schema would accept it. The plan is schema-valid but semantically wrong.

---

## Close the gap: configure grounding

Add this before running the plan:

```python
logix.grounding(require_ref_for=["refund.amount"])
```

Now run `bad_plan` again:

```python
result = logix.run(bad_plan)
print(result.ok)
print(result.errors)
```

Expected output:

```text
False
(Error(code='GROUNDING_REQUIRED',
       message="argument 'refund.amount' must be sourced from a $ref (not a literal value)",
       path='steps[1].with.amount', details={'capability': 'refund', 'argument': 'amount'}),)
```

The literal is rejected. The plan must source `amount` from an earlier step. The `$ref` version still works; the literal version fails.

This is the point of grounding: the model cannot type a value that must come from validated data. It has to fetch the order first, then reference its total.

For arguments that legitimately come from the user, such as a user-selected order ID or a user-supplied search query, use `literal_allowlist`:

```python
logix.grounding(
    require_ref_for=["refund.amount"],
    literal_allowlist=["refund.order_id"],
)
```

---

## Watch a reference fail

Try a forward reference — a `$ref` to a step that comes later:

```python
forward_plan = {
    "version": "1",
    "steps": [
        {
            "id": "r",
            "call": "refund",
            "with": {
                "order_id": {"$ref": "o.id"},
                "amount": {"$ref": "o.total"},
            },
        },
        {"id": "o", "call": "get_order", "with": {"order_id": 502}},
    ],
}

result = logix.run(forward_plan)
print(result.errors)
```

Expected output:

```text
(Error(code='INVALID_PLAN',
       message="$ref points to a non-earlier step: 'o'",
       path='steps[r].with.order_id', ...),)
```

Forward references are rejected at parse time. A step can only reference an earlier step. This is what makes cycles impossible through normal parsing: you can't build a cycle if references can only point backward.

Try a self-reference:

```python
self_ref = {
    "version": "1",
    "steps": [
        {
            "id": "s",
            "call": "refund",
            "with": {
                "order_id": {"$ref": "s.id"},
                "amount": 5.0,
            },
        },
    ],
}

print(logix.run(self_ref).errors)
```

Expected output:

```text
(Error(code='INVALID_PLAN',
       message="$ref points to a non-earlier step: 's'",
       ...),)
```

The self-reference is rejected for the same reason.

---

## Watch a reference fail at the type level

The verifier checks that a reference's type is compatible with the destination's declared type. An `int` is not a `float`:

```python
@logix.capability
def get_count() -> dict[str, int]:
    return {"count": 3}


@logix.capability
def need_float(amount: float) -> int:
    return 0


type_mismatch = {
    "version": "1",
    "steps": [
        {"id": "c", "call": "get_count", "with": {}},
        {
            "id": "n",
            "call": "need_float",
            "with": {"amount": {"$ref": "c.count"}},  # int -> float
        },
    ],
}

print(logix.run(type_mismatch).errors)
```

Expected output:

```text
(Error(code='INVALID_REFERENCE',
       message="reference type int is not assignable to destination type float",
       path='steps[1].with.amount', ...),)
```

This is the strict-type rule in action (ADR-0003). An `int` does not implicitly widen to a `float`. If you need a `float` destination, the source must declare a `float`.

---

## What you've learned

- Plans have two shapes: single-call (`{"call": ..., "with": ...}`) and multi-step (`{"version": ..., "steps": [...]}`).
- `$ref` sources arguments from prior steps. It's the mechanism that makes multi-step plans useful.
- Grounding (`logix.grounding(...)`) requires `$ref` for sensitive arguments. It closes the "hallucinated value" gap.
- Forward references are rejected at parse time. This makes cycles impossible under the plan's backward-reference rule.
- Reference type-checking is strict. `int` → `float` is rejected.

You now have a working two-step plan with grounding. The next file adds the AI: how to send the catalog to a model and run its proposal.

→ [04 — With an AI](04-with-an-ai.md)
