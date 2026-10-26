# Lesson 05 — Pydantic Models

Reuse existing Pydantic domain models as capability schemas. By the end, you'll have a capabilities file built from models you already use, with `$ref` traversal into model outputs and validation handled by Pydantic.

**Time:** 30 minutes. **You will build:** ~50 lines of capabilities code, ~50 lines of tests. **You will understand:** `PydanticType`, `HandlerMode`, `$ref` into model outputs, and the `list[Model]` limitation.

---

## What you're building

A small order-processing application. Your domain models already exist as Pydantic `BaseModel` classes. You want to use them as capability schemas without redeclaring every field with `Annotated[...]`.

The critical properties:

1. A Pydantic model in a signature becomes a capability schema.
2. Field constraints such as `Field(ge=0)` are enforced.
3. A valid call passes a model instance to the handler by default.
4. Failed validation produces `SCHEMA_VALIDATION_FAILED`.
5. `$ref` into a model-typed output works — the field is traversed through `PydanticType.walk`.
6. `list[Model]` fields are not traversable via `$ref` — a documented limitation with a workaround.

---

## Setup

```bash
mkdir -p logiq-lessons/05-pydantic-models && cd logiq-lessons/05-pydantic-models
touch models.py capabilities.py test_capabilities.py

pip install "logiq[pydantic]"
```

## Step 1 — Define your existing Pydantic models

Create `models.py`:

```python
"""Domain models. Assume these already exist in your application."""

from pydantic import BaseModel, Field


class CreateOrder(BaseModel):
    """What the client sends to create an order."""

    product_id: int = Field(ge=0, description="The product to order.")
    quantity: int = Field(ge=1, le=100, description="How many.")


class Address(BaseModel):
    """Shipping address."""

    city: str = Field(min_length=1)
    postcode: str = Field(min_length=1)


class Order(BaseModel):
    """A created order."""

    id: int
    status: str
    address: Address
    total: float
```

These are the models your application already uses:

- `CreateOrder` — input, with constraints.
- `Address` — nested inside `Order`.
- `Order` — output, with a nested `Address`.

You don't want to redeclare them with `Annotated[int, Gt(0), Le(100)]`. You want the schemas to come from the models.

## Step 2 — Register a capability with a model

Create `capabilities.py`:

```python
"""Logiq capabilities built from existing Pydantic models."""

from logiq import Logix

from models import Address, CreateOrder, Order

logix = Logix()


@logix.capability(effects="write")
def prepare_order(order: CreateOrder) -> Order:
    """Prepare an order for review."""
    return Order(
        id=1,
        status="pending",
        address=Address(city="Berlin", postcode="10115"),
        total=order.quantity * 10.0,
    )
```

Two things are different from the pure-native version:

- There is no `Field(ge=0)` in the capability signature. The constraint lives in the Pydantic model.
- `Address` is imported at the top because the handler uses it.

Registration works because Logiq detects the Pydantic models and wraps them as `PydanticType` instances.

Try it:

```bash
python capabilities.py
```

There is no output — the file just registers the capability. A successful import demonstrates that registration completed.

## Step 3 — Inspect the schema

Add the following to `capabilities.py`:

```python
import json

print(json.dumps(logix.tools.format("json"), indent=2))
```

Example output, abbreviated:

```json
[
  {
    "name": "prepare_order",
    "description": "Prepare an order for review.",
    "input_schema": {
      "type": "object",
      "properties": {
        "order": {"$ref": "#/$defs/CreateOrder"}
      },
      "required": ["order"],
      "additionalProperties": false,
      "$defs": {
        "CreateOrder": {
          "type": "object",
          "properties": {
            "product_id": {"type": "integer", "minimum": 0},
            "quantity": {"type": "integer", "minimum": 1, "maximum": 100}
          },
          "required": ["product_id", "quantity"]
        }
      }
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "id": {"type": "integer"},
        "status": {"type": "string"},
        "address": {"$ref": "#/$defs/Address"},
        "total": {"type": "number"}
      },
      "required": ["id", "status", "address", "total"],
      "$defs": {
        "Address": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "minLength": 1},
            "postcode": {"type": "string", "minLength": 1}
          },
          "required": ["city", "postcode"]
        }
      }
    },
    "effects": "write",
    "approval": null,
    "schema_version": "1"
  }
]
```

The schema is derived from the model's schema using Pydantic's `model_json_schema()`. The `Field(ge=0)` and `Field(le=100)` constraints appear as `minimum` and `maximum`. The `$ref` and `$defs` structure is standard JSON Schema for nested models.

The same schema is used by the verifier and shown in the catalog, so they cannot disagree about the schema they use.

## Step 4 — Try valid and invalid calls

### Valid input

```python
import json

result = logix.run({
    "call": "prepare_order",
    "with": {"order": {"product_id": 1, "quantity": 5}},
})

print("Valid:", result.ok)
print("Value:", json.dumps(result.value, indent=2))
print("Type of value:", type(result.value).__name__)
```

Example output:

```text
Valid: True
Value: {
  "id": 1,
  "status": "pending",
  "address": {"city": "Berlin", "postcode": "10115"},
  "total": 50.0
}
Type of value: dict
```

Two things to notice:

- `result.value` is a dictionary, not an `Order`. The executor normalizes Pydantic outputs to JSON-safe dictionaries before storing and returning them. This is what makes `Result.to_dict()` JSON-safe.
- The handler receives a `CreateOrder` instance. It can access `order.quantity`, which requires a model rather than a dictionary.

### Invalid input

Try a quantity greater than the model's `le=100` constraint:

```python
result = logix.run({
    "call": "prepare_order",
    "with": {"order": {"product_id": 1, "quantity": 500}},
})

print("Invalid:", result.ok)
print("Error:", result.errors[0].code, result.errors[0].message)
```

Example output:

```text
Invalid: False
Error: SCHEMA_VALIDATION_FAILED Value error, Input should be less than or equal to 100 (less_than_equal)
```

Pydantic's validation error is translated into a Logiq `SCHEMA_VALIDATION_FAILED` error. The handler is not invoked.

The path in `result.errors[0].path` identifies the field; for this example, it is `with.order.quantity`.

Try omitting a required field:

```python
result = logix.run({
    "call": "prepare_order",
    "with": {"order": {"product_id": 1}},
})

print(result.errors[0].code, result.errors[0].message)
```

Example output:

```text
SCHEMA_VALIDATION_FAILED Field required (missing)
```

## Step 5 — Use `$ref` with a model-typed output

Multi-step plans can reference fields in a model's output. The verifier walks through `PydanticType.walk`, which resolves field names to their corresponding Logiq types.

Add these capabilities to `capabilities.py`:

```python
@logix.capability(effects="read")
def get_order(order_id: int) -> Order:
    """Retrieve an order by ID."""
    return Order(
        id=order_id,
        status="delivered",
        address=Address(city="Berlin", postcode="10115"),
        total=50.0,
    )


@logix.capability(effects="write")
def refund(order_id: int, amount: float) -> dict[str, float]:
    """Issue a refund."""
    return {"refunded": float(order_id), "amount": amount}
```

Now reference fields from `get_order` in a multi-step plan:

```python
plan = {
    "version": "1",
    "steps": [
        {"id": "o", "call": "get_order", "with": {"order_id": 1}},
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
print("Grounded refund:", result.ok)
print("Value:", result.value)
```

Example output:

```text
Grounded refund: True
Value: {'o': {'id': 1, 'status': 'delivered', 'address': {...}, 'total': 50.0},
        'r': {'refunded': 1.0, 'amount': 50.0}}
```

- `$ref: "o.id"` resolves to `Order.id`, which has type `IntType`.
- `$ref: "o.total"` resolves to `Order.total`, which has type `FloatType`.

Both types are assignable to their destination parameters: `refund.order_id: int` and `refund.amount: float`. The verifier accepts the plan.

### Reference a nested field

You can also reference a field inside a nested model:

```python
plan = {
    "version": "1",
    "steps": [
        {"id": "o", "call": "get_order", "with": {"order_id": 1}},
        {
            "id": "n",
            "call": "note_city",
            "with": {"city": {"$ref": "o.address.city"}},
        },
    ],
}
```

`PydanticType.walk("address")` returns another `PydanticType` for `Address`. Calling `walk("city")` on that returns `StrType`. The reference resolves through two levels of model traversal.

This example assumes that a `note_city` capability accepting `city: str` has been registered.

## Step 6 — Understand the `list[Model]` limitation

Add a model with a list of nested models:

```python
class LineItem(BaseModel):
    amount: float


class OrderWithItems(BaseModel):
    id: int
    items: list[LineItem]


@logix.capability(effects="read")
def get_order_items(order_id: int) -> OrderWithItems:
    """Retrieve an order with line items."""
    return OrderWithItems(
        id=order_id,
        items=[LineItem(amount=50.0), LineItem(amount=30.0)],
    )
```

Try to reference a field inside an item:

```python
@logix.capability
def need_item(amount: float) -> dict[str, float]:
    return {"amount": amount}


plan = {
    "version": "1",
    "steps": [
        {"id": "o", "call": "get_order_items", "with": {"order_id": 1}},
        {
            "id": "n",
            "call": "need_item",
            "with": {"amount": {"$ref": "o.items.0.amount"}},
        },
    ],
}

result = logix.run(plan)
print("$ref into list[Model]:", result.ok)
print("Error:", result.errors[0].code if result.errors else "ok")
```

Example output:

```text
$ref into list[Model]: False
Error: INVALID_REFERENCE
```

`PydanticType.walk("items")` returns `None` in this scenario. The field's type is `list[LineItem]`, and `walk` cannot traverse a `list[Model]` because the item type is a Pydantic model rather than a native Logiq type.

This limitation is documented in `docs/pydantic.md` §4.

### Workaround: use `list[dict]`

If you need `$ref` traversal into the list, declare the field as `list[dict]`:

```python
class OrderWithItems(BaseModel):
    id: int
    items: list[dict[str, float]]
```

Then `$ref` into `items.0.amount` can work because `walk("items")` returns `ListType(DictType(FloatType))`, which supports traversal.

The trade-off is that you lose Pydantic's nested validation for the list items. For outputs, which are usually not revalidated, this may be acceptable. For inputs, use a model.

## Step 7 — Configure `HandlerMode`

`HandlerMode.VALUES` passes plain dictionaries to handlers instead of model instances. This is useful when a handler shouldn't depend on Pydantic or when the same handler is used through both Logiq and a non-Pydantic path.

```python
from logiq_pydantic import HandlerMode, set_handler_mode

# Default: handlers receive model instances.
set_handler_mode(HandlerMode.MODEL)


@logix.capability
def handle_order_model(order: CreateOrder) -> dict[str, int]:
    """Handler receives a model."""
    print(f"Type: {type(order).__name__}")
    print(f"Quantity: {order.quantity}")
    return {"quantity": order.quantity}


logix.run({
    "call": "handle_order_model",
    "with": {"order": {"product_id": 1, "quantity": 5}},
})
# Output: Type: CreateOrder, Quantity: 5


# Values mode: handlers receive dictionaries.
set_handler_mode(HandlerMode.VALUES)


@logix.capability
def handle_order_values(order: CreateOrder) -> dict[str, int]:
    """Handler receives a dictionary."""
    print(f"Type: {type(order).__name__}")
    print(f"Quantity: {order['quantity']}")
    return {"quantity": order["quantity"]}


logix.run({
    "call": "handle_order_values",
    "with": {"order": {"product_id": 1, "quantity": 5}},
})
# Output: Type: dict, Quantity: 5
```

Two things to remember:

- `HandlerMode` is a module-global setting. Set it at application startup. Changing it at runtime affects subsequent executions.
- Validation runs before the mode conversion. Whether the handler receives a model or a dictionary, Pydantic validates the input first. The mode changes what the handler sees, not what gets validated.

Set the mode back to `MODEL` after the demonstration, or leave it configured as your application requires.

## Step 8 — Complete application file

The following is the complete `capabilities.py` file. It uses the models from `models.py`.

```python
"""Logiq capabilities built from existing Pydantic models."""

import json

from logiq import Logix

from models import Address, CreateOrder, LineItem, Order, OrderWithItems

logix = Logix()


@logix.capability(effects="write")
def prepare_order(order: CreateOrder) -> Order:
    """Prepare an order for review."""
    return Order(
        id=1,
        status="pending",
        address=Address(city="Berlin", postcode="10115"),
        total=order.quantity * 10.0,
    )


@logix.capability(effects="read")
def get_order(order_id: int) -> Order:
    """Retrieve an order by ID."""
    return Order(
        id=order_id,
        status="delivered",
        address=Address(city="Berlin", postcode="10115"),
        total=50.0,
    )


@logix.capability(effects="write")
def refund(order_id: int, amount: float) -> dict[str, float]:
    """Issue a refund."""
    return {"refunded": float(order_id), "amount": amount}


@logix.capability(effects="read")
def get_order_items(order_id: int) -> OrderWithItems:
    """Retrieve an order with line items."""
    return OrderWithItems(
        id=order_id,
        items=[LineItem(amount=50.0), LineItem(amount=30.0)],
    )


@logix.capability
def need_item(amount: float) -> dict[str, float]:
    return {"amount": amount}


if __name__ == "__main__":
    print("=== Valid call ===")
    result = logix.run({
        "call": "prepare_order",
        "with": {"order": {"product_id": 1, "quantity": 5}},
    })
    print(json.dumps(result.value, indent=2))

    print("\n=== Constraint violation ===")
    result = logix.run({
        "call": "prepare_order",
        "with": {"order": {"product_id": 1, "quantity": 500}},
    })
    print(result.errors[0].code, "->", result.errors[0].message)

    print("\n=== $ref into model output ===")
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 1}},
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
    print(result.ok, result.value)

    print("\n=== $ref into list[Model] (not supported) ===")
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order_items", "with": {"order_id": 1}},
            {
                "id": "n",
                "call": "need_item",
                "with": {"amount": {"$ref": "o.items.0.amount"}},
            },
        ],
    }
    result = logix.run(plan)
    print(result.errors[0].code)
```

Run the file:

```bash
python capabilities.py
```

Expected output:

```text
=== Valid call ===
{
  "id": 1,
  "status": "pending",
  "address": {"city": "Berlin", "postcode": "10115"},
  "total": 50.0
}

=== Constraint violation ===
SCHEMA_VALIDATION_FAILED -> Value error, Input should be less than or equal to 100 (less_than_equal)

=== $ref into model output ===
True {'o': {'id': 1, 'status': 'delivered', 'address': {...}, 'total': 50.0},
      'r': {'refunded': 1.0, 'amount': 50.0}}

=== $ref into list[Model] (not supported) ===
INVALID_REFERENCE
```

## Step 9 — Write the tests

Create `test_capabilities.py`:

```python
"""Tests for Lesson 05."""

import pytest

from logiq_pydantic import HandlerMode, set_handler_mode

from capabilities import logix
from models import CreateOrder


@pytest.fixture(autouse=True)
def reset_handler_mode():
    yield
    set_handler_mode(HandlerMode.MODEL)


def test_valid_call_returns_dict():
    result = logix.run({
        "call": "prepare_order",
        "with": {"order": {"product_id": 1, "quantity": 5}},
    })
    assert result.ok
    assert isinstance(result.value, dict)
    assert result.value["total"] == 50.0


def test_constraint_violation_rejected():
    result = logix.run({
        "call": "prepare_order",
        "with": {"order": {"product_id": 1, "quantity": 500}},
    })
    assert not result.ok
    assert result.errors[0].code == "SCHEMA_VALIDATION_FAILED"


def test_missing_field_rejected():
    result = logix.run({
        "call": "prepare_order",
        "with": {"order": {"product_id": 1}},
    })
    assert not result.ok
    assert result.errors[0].code == "SCHEMA_VALIDATION_FAILED"


def test_ref_into_model_output():
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 1}},
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
    assert result.ok
    assert result.value["r"] == {"refunded": 1.0, "amount": 50.0}


def test_ref_into_nested_model_field():
    @logix.capability
    def note_city(city: str) -> dict[str, int]:
        return {"ok": 1}

    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order", "with": {"order_id": 1}},
            {
                "id": "n",
                "call": "note_city",
                "with": {"city": {"$ref": "o.address.city"}},
            },
        ],
    }
    result = logix.run(plan)
    assert result.ok


def test_ref_into_list_of_models_rejected():
    plan = {
        "version": "1",
        "steps": [
            {"id": "o", "call": "get_order_items", "with": {"order_id": 1}},
            {
                "id": "n",
                "call": "need_item",
                "with": {"amount": {"$ref": "o.items.0.amount"}},
            },
        ],
    }
    result = logix.run(plan)
    assert not result.ok
    assert result.errors[0].code == "INVALID_REFERENCE"


def test_handler_mode_model_receives_instance():
    received = []

    @logix.capability
    def handler_model(order: CreateOrder) -> dict[str, int]:
        received.append(order)
        return {"quantity": order.quantity}

    set_handler_mode(HandlerMode.MODEL)
    result = logix.run({
        "call": "handler_model",
        "with": {"order": {"product_id": 1, "quantity": 5}},
    })
    assert result.ok
    assert isinstance(received[0], CreateOrder)


def test_handler_mode_values_receives_dict():
    received = []

    @logix.capability
    def handler_values(order: CreateOrder) -> dict[str, int]:
        received.append(order)
        return {"quantity": order["quantity"]}  # type: ignore[index]

    set_handler_mode(HandlerMode.VALUES)
    result = logix.run({
        "call": "handler_values",
        "with": {"order": {"product_id": 1, "quantity": 5}},
    })
    assert result.ok
    assert isinstance(received[0], dict)
    assert received[0]["quantity"] == 5
```

Run the tests:

```bash
pytest test_capabilities.py -v
```

Expected: 8 tests pass.

## What you built

You now have capabilities built from existing Pydantic models, with:

- **Schemas derived from models:** `Field(ge=0)` becomes `minimum: 0`.
- **Input validated by Pydantic:** constraints and nested models are enforced before the handler runs.
- **`$ref` into model outputs:** `o.id`, `o.total`, and `o.address.city` resolve through `PydanticType.walk`.
- **The `list[Model]` limitation documented:** `$ref` cannot traverse this shape in the described implementation.
- **A `HandlerMode` toggle:** handlers receive model instances or dictionaries.

The eight tests cover the examples and limitations in this lesson.

## What to try next

1. **Try `list[dict]` as a workaround.** Change `OrderWithItems.items` to `list[dict[str, float]]`. Verify that `$ref` into `items.0.amount` now works. Note the trade-off: the inner dictionaries are not validated by Pydantic.

2. **Use `Annotated` on a model field.** Pydantic supports `Annotated[int, Field(ge=0)]` inside models. Add a `LineItem` with a `Field(ge=0)` amount and verify that the constraint appears in the schema as `minimum: 0`.

3. **Reuse a model across capabilities.** Use `CreateOrder` as input to both `prepare_order` and a second capability, `preview_order`. Does Pydantic validate it twice? Each `logix.run` call validates independently.

4. **Try a Pydantic v1 model.** `logiq_pydantic` requires `pydantic>=2,<3`. If your application still uses Pydantic v1, this adapter does not work. Options include upgrading to Pydantic v2 or using native `Annotated` types instead. There is no v1 support in version `0.1.0`.

## Where to read more

- `docs/pydantic.md` — the full adapter guide, including supported and unsupported patterns.
- `docs/schemas.md` §9 — what changes when `logiq_pydantic` is installed.
- `docs/ai-integration.md` — how the catalog works and why the schema comes from Pydantic unchanged.
- `src/logiq_pydantic/` — the adapter source.
- `tests/pydantic/` — the adapter tests.

## Next steps

You've completed the  lesson 5. You've built:

- A refund workflow with grounding, invariants, approval, and audit.
- A multi-tenant application with isolated engines.
- A custom provider adapter passing the conformance kit.
- An MCP proxy verifying untrusted upstream tools.
- A Pydantic integration reusing existing domain models.

That covers the full surface of Logiq. The reference docs — `docs/architecture.md`, `docs/system-design.md`, and `docs/security.md` — will make more sense now.

If you're building for production, read `docs/production-guide.md` next.

[← continue to lessons 6](lessons/06-ai-integration.md)
