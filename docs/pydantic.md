# Pydantic Integration

`execgate_pydantic` is an optional adapter that lets Pydantic model classes become capability schemas. It is not required for ExecGate; the native schema engine works without it.

The adapter is a leaf node (ADR-0006): it converts model annotations into `execgate.schemas.Type` instances and normalizes Pydantic instance output to JSON-safe dictionaries. It never touches the verifier, the executor, or the IR.

---

## 1. Install

```bash
pip install "execgate[pydantic]"
```

Requires `pydantic>=2,<3`.

Importing `execgate_pydantic` without Pydantic installed raises a clear `ImportError` naming the install command. `import execgate` never imports Pydantic.

---

## 2. Use

```python
from pydantic import BaseModel, Field
from execgate import Logix


class CreateOrder(BaseModel):
    product_id: int = Field(ge=0)
    quantity: int = Field(ge=1, le=100)


class Order(BaseModel):
    id: int
    status: str


logix = Logix()


@logix.capability(effects="write")
def prepare_order(order: CreateOrder) -> Order:
    "Prepare an order for review."
    return Order(id=1, status="pending")
```

Registration works unchanged. ExecGate detects the Pydantic models in the signature, wraps them as `PydanticType`, and the native schema engine handles the rest.

The AI sees the model's JSON Schema in the catalog:

```json
{
  "name": "prepare_order",
  "input_schema": {
    "type": "object",
    "properties": {
      "order": {
        "$ref": "#/$defs/CreateOrder"
      }
    },
    "required": ["order"]
  }
}
```

At call time:

```python
result = logix.run({
    "call": "prepare_order",
    "with": {"order": {"product_id": 1, "quantity": 5}},
})

assert result.ok
assert result.value == {"id": 1, "status": "pending"}
```

The handler receives a `CreateOrder` instance (`HandlerMode.MODEL` by default). `Result.value` is a JSON-safe dictionary produced by the model's `model_dump(mode="json")`.

---

## 3. What works

| Pattern | Supported |
|---|---|
| Direct model parameter | ✅ |
| `Optional[Model]` | ✅ |
| `list[Model]` | ✅ |
| `dict[str, Model]` | ✅ |
| `Union[ModelA, ModelB]` | ✅ |
| Nested models | ✅ Recursively |
| Model as return type | ✅ Normalized to dictionary |
| `$ref` into a model-typed output field | ✅ |
| `$ref` into a nested model field | ✅ |
| `Field(ge=..., le=..., min_length=...)` constraints | ✅ Via Pydantic |
| `extra="forbid"` | ✅ Via Pydantic |

---

## 4. What does not work

| Pattern | Status | Workaround |
|---|---|---|
| `Annotated[Model, ...]` metadata | Not unwrapped; the base is used and metadata is dropped | Use `Field(...)` inside the model |
| `tuple[Model, ...]`, `set[Model]` | Not supported; native inference rejects tuple/set | Use `list[Model]` |
| `TypeAdapter[X]` as a parameter annotation | Not supported; only `BaseModel` subclasses | Convert to a model |
| `$ref` into a `list[Model]` field | Not supported; `PydanticType.walk` returns `None` for `list[Model]` | Declare the field as `list[dict]` if you need `$ref` traversal |
| Custom `PydanticType` output normalization | Only `model_dump(mode="json")` is used | Subclass and override if needed; this is not part of the 0.1.0 public API |

These are documented limitations. They define the boundary between what the adapter supports and what it does not. If you encounter one, either restructure your code to avoid it or use the native schema engine (for example, `dict[str, float]` or `list[SomeType]`) instead of a model.

---

## 5. HandlerMode

Two modes are available, configured globally:

- **`HandlerMode.MODEL` (default):** The handler receives a Pydantic instance for each model-typed parameter.
- **`HandlerMode.VALUES`:** The handler receives the model's `model_dump(mode="json")` output — plain JSON-safe dictionaries.

```python
from execgate_pydantic import HandlerMode, set_handler_mode, get_handler_mode

set_handler_mode(HandlerMode.VALUES)  # or set_handler_mode("values")
assert get_handler_mode() == HandlerMode.VALUES
```

The mode is a global setting in version 0.1.0. It applies to every capability on every engine. It is a deployment choice, not a per-call option.

### When to use each mode

**MODEL** — Use when the handler benefits from Pydantic methods and features such as `model_validate`, `model_dump`, aliases, and validators. The handler trusts the model class.

**VALUES** — Use when the handler does not know about Pydantic, or when the same handler is used through both ExecGate and a non-Pydantic path. The values are plain dictionaries, identical to what a JSON-based caller would send.

### Thread safety

`set_handler_mode` writes to a module-global variable. Reads are not synchronized with writes. Configure the mode at application startup, before any concurrent access.

Changing it at runtime affects subsequent executions only; it does not mutate capability registrations.

### Default

The default is `HandlerMode.MODEL`. This is what a developer expects from `def f(order: Order)`: the handler receives an `Order`, not a dictionary.

---

## 6. How validation works

`PydanticType.validate(value, path)` calls:

```python
TypeAdapter(model_cls).validate_python(value)
```

On success, it returns `[]`. On `pydantic.ValidationError`, it translates every error into a `execgate.schemas.SchemaError`.

### Error translation

- `error["loc"]` (path tuple) → dotted path, such as `$.field.subfield`.
- `error["msg"]` → message.
- `error["type"]` (Pydantic error type) → preserved in the message as `(type)`.
- `error["input"]` → dropped. Raw inputs can contain sensitive data, so the error message names the field and the expectation, not the value.

### Example failure

```python
class Order(BaseModel):
    id: int
    total: float


result = logix.run({
    "call": "get_order",
    "with": {"id": "not-an-int", "total": -1.0},
})

assert not result.ok
assert result.errors[0].code == "SCHEMA_VALIDATION_FAILED"
assert "not-an-int" not in result.errors[0].message  # no raw input
```

---

## 7. JSON Schema export

`PydanticType.to_json_schema()` returns `model_cls.model_json_schema()`. That is the schema Pydantic produces, unmodified.

`logix.schemas.for_capability("prepare_order").input` produces a schema like this:

```json
{
  "type": "object",
  "properties": {
    "order": {
      "$ref": "#/$defs/CreateOrder"
    }
  },
  "required": ["order"],
  "additionalProperties": false,
  "$defs": {
    "CreateOrder": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "integer",
          "minimum": 0
        },
        "quantity": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        }
      },
      "required": ["product_id", "quantity"]
    }
  }
}
```

The catalog and the validator see the same schema. They cannot disagree.

---

## 8. `$ref` into Pydantic outputs

A multi-step plan can reference a field of a Pydantic-typed output. The verifier's `_walk_type_path` traverses `PydanticType.walk`, which resolves field names to their ExecGate types.

```python
@logix.capability
def get_order(order_id: int) -> Order:
    return Order(id=order_id, total=50.0)


@logix.capability
def refund(order_id: int, amount: float) -> dict[str, int]:
    return {"ok": 1}


result = logix.run({
    "version": "1",
    "steps": [
        {
            "id": "o",
            "call": "get_order",
            "with": {"order_id": 502},
        },
        {
            "id": "r",
            "call": "refund",
            "with": {
                "order_id": {"$ref": "o.id"},
                "amount": {"$ref": "o.total"},
            },
        },
    ],
})

assert result.ok
```

At verification time, `o.total` resolves to `FloatType` (from `Order.total: float`), which is assignable to `refund.amount: float`.

At execution time, the executor normalizes the returned `Order` to a dictionary before storing it in `step_outputs`, so `$ref` traversal works on plain dictionary data.

### Nested model fields

`Order.address.city` works: `PydanticType.walk("address")` returns another `PydanticType`, and calling `walk("city")` on that returns `StrType`.

### `list[Model]` limitation

`PydanticType.walk` returns `None` for a field whose type is `list[SomeModel]`. A `$ref` into `order.line_items.0.amount` is rejected at verification time.

If you need this, declare the field as `list[dict]` on the model — a plain dictionary with a shape known at runtime.

---

## 9. Failure modes

| Cause | Error code or behavior |
|---|---|
| Model validation fails (wrong type, missing field, constraint) | `SCHEMA_VALIDATION_FAILED` |
| Model output has the wrong shape | `OUTPUT_VALIDATION_FAILED` |
| Model annotation used without `execgate_pydantic` installed | `TypeError` at registration (`unsupported annotation: ModelName`) |
| `Annotated[Model, ...]` used | `Annotated` is unwrapped; the model is used and metadata is dropped (silent, documented) |
| `$ref` to a `list[Model]` field | `INVALID_REFERENCE` at verification time |

### The install-required error

A user who writes:

```python
@logix.capability
def f(order: Order) -> None:
    ...
```

without `execgate_pydantic` installed gets:

```text
TypeError: cannot register capability 'f':
  parameter 'order': unsupported annotation: Order
```

The error does not say "install `execgate_pydantic`." A user has to know the adapter exists. This is documented in `docs/schemas.md` §9 and in the error message itself if a future version can detect the case. In version 0.1.0, the core does not know the adapter exists.

---

## 10. What changes when the adapter is installed

The core does not import `execgate_pydantic`. What changes:

1. `capabilities._maybe_transform_pydantic` — a try-import. If successful, it calls `execgate_pydantic.transform_signature(info)` before inferring schemas.
2. `executor._prepare_handler_args` — a try-import of `execgate_pydantic.get_handler_mode` inside the executor. If successful, it uses the current mode when calling `PydanticType.prepare_input`.
3. **Executor output normalization** — `hasattr(cap.output_schema, "prepare_output")` is checked after output validation. If present, the value is normalized.

That's the entire integration: three try-imports. If `execgate_pydantic` is not installed, all three are no-ops.

---

## 11. Testing Pydantic capabilities

```python
def test_prepare_order(logix):
    @logix.capability
    def prepare_order(order: CreateOrder) -> Order:
        return Order(id=1, status="pending")

    result = logix.run({
        "call": "prepare_order",
        "with": {"order": {"product_id": 1, "quantity": 5}},
    })

    assert result.ok
    assert result.value == {"id": 1, "status": "pending"}

    # Invalid input: rejected by Pydantic validation.
    result = logix.run({
        "call": "prepare_order",
        "with": {"order": {"product_id": 1, "quantity": 200}},
    })

    assert not result.ok
    assert result.errors[0].code == "SCHEMA_VALIDATION_FAILED"
```

For testing the handler's own validation logic, remember that the handler receives a validated `CreateOrder` — it can assume the field types, but not the field values' business correctness.

Business rules belong in invariants (`logix.authorize(...)`), not in the model's `Field` constraints.

---

## 12. When to use Pydantic vs. native types

### Use Pydantic when

- You already have Pydantic models for your domain.
- You need cross-field validation (`model_validator`).
- You need aliases (`Field(alias="...")`).
- You want nested model structure with recursive validation.
- You want the model class's methods available in the handler.

### Use native types when

- Your types are simple primitives and containers.
- You want zero runtime dependencies (Pydantic is a substantial package).
- You do not need Pydantic's serialization features.
- You are writing a `execgate_mcp` proxy (the upstream tools' schemas are JSON Schema; Pydantic adds a conversion step).

Both approaches produce the same JSON Schema for the AI and the same verifier behavior. The choice is about the developer's workflow, not the guarantees.