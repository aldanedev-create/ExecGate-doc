# Schemas

How Logiq derives a contract from Python annotations, enforces it at runtime, and exports it as JSON Schema for AI catalogs.

The governing rule is ADR-0003: **reject rather than silently weaken.**

If an annotation cannot be faithfully represented, registration fails with a clear error rather than accepting a schema that doesn't match reality.

---

## 1. The contract

A capability's contract has two parts:

- **Input schema** — derived from the handler's parameter annotations. Every parameter must be annotated; unannotated parameters are rejected at registration.
- **Output schema** — derived from the return annotation. An unannotated return means "no output validation"; the handler's return value passes through without a check.

Both are `logiq.schemas.Type` instances. The **same** `Type` is used for:

- Runtime input validation (before the handler runs).
- Runtime output validation (after the handler runs).
- JSON Schema export (`tools.format("json")` → catalog → AI client).

The same schema is used in all three places, so the catalog and the verifier cannot disagree. If the AI sees `"type": "integer"` for an argument, the verifier will enforce `integer`.

---

## 2. Supported annotations

### Primitives

| Python | Logiq type | JSON Schema |
|---|---|---|
| `int` | `IntType` | `{"type": "integer"}` |
| `float` | `FloatType` | `{"type": "number"}` |
| `str` | `StrType` | `{"type": "string"}` |
| `bool` | `BoolType` | `{"type": "boolean"}` |
| `None` | `NoneType` | `{"type": "null"}` |
| `Any` | **Rejected** | — |

`typing.Any` is not accepted. It is not a validation contract; using it would be accepting everything. If you need "accept anything," the handler is taking data it cannot validate, and that should be visible in the signature. Use a concrete type.

### Containers

| Python | Logiq type | JSON Schema |
|---|---|---|
| `list[X]` | `ListType(item_type=X)` | `{"type": "array", "items": ...}` |
| `dict[str, X]` | `DictType(value_type=X)` | `{"type": "object", "additionalProperties": ...}` |

`dict[K, V]` with `K != str` is rejected — JSON object keys are always strings, so a non-`str` key annotation is a lie about what can arrive.

Bare `dict` and bare `list` are rejected. Use the parametrized form.

### Unions

| Python | Logiq type | JSON Schema |
|---|---|---|
| `Optional[X]` | `UnionType((X, NoneType()))` | `{"anyOf": [..., {"type": "null"}]}` |
| `Union[X, Y, ...]` | `UnionType((X, Y, ...))` | `{"anyOf": [...]}` |

### Literals

| Python | Logiq type | JSON Schema |
|---|---|---|
| `Literal["a", "b"]` | `LiteralType(("a", "b"))` | `{"enum": ["a", "b"]}` |

`Literal` values must be primitives (`str`, `int`, `bool`, `float`, `None`). A `Literal` mixing `bool` and `int` is rejected — `True == 1` in Python, and it's ambiguous which the user meant.

### Constraints via `Annotated`

Constraints attach to a base type via `typing.Annotated`:

```python
from typing import Annotated
from logiq.schemas import Gt, Le, MinLength, MaxLength, Pattern

def issue_refund(
    amount: Annotated[float, Gt(0), Le(10_000)],
    note: Annotated[str, MinLength(1), MaxLength(200)],
    tracking: Annotated[str, Pattern(r"^[A-Z0-9]{8,}$")],
) -> dict[str, int]:
    ...
```

Supported constraints:

| Constraint | Applies to | JSON Schema |
|---|---|---|
| `Gt(n)` | Numbers | `exclusiveMinimum: n` |
| `Ge(n)` | Numbers | `minimum: n` |
| `Lt(n)` | Numbers | `exclusiveMaximum: n` |
| `Le(n)` | Numbers | `maximum: n` |
| `MinLength(n)` | Strings, lists | `minLength: n` |
| `MaxLength(n)` | Strings, lists | `maxLength: n` |
| `Pattern(regex)` | Strings | `pattern: regex` (full match) |

Other `Annotated` metadata (arbitrary objects) is rejected:

```text
SchemaInferenceError: unsupported constraint on Annotated: <repr>.
```

`Annotated` can nest:

```python
Annotated[list[Annotated[int, Gt(0)]], MinLength(1)]
```

Each layer is validated.

---

## 3. What is not supported (and why)

| Annotation | Rejected with | Rationale |
|---|---|---|
| `typing.Any` | `"not a validation contract"` | Accepts everything; not a schema |
| Bare `dict` | `"unsupported annotation: dict"` | Missing key/value types |
| Bare `list` | `"unsupported annotation: list"` | Missing item type |
| `set`, `frozenset` | `"unsupported annotation: set"` | Not JSON-representable |
| `tuple[X, Y]` | `"unsupported annotation: tuple"` | Fixed-length arrays are unusual; not in the initial scope |
| `bytes` | `"unsupported annotation: bytes"` | Not JSON-representable |
| `Decimal` | `"unsupported annotation: Decimal"` | Preserving precision requires a specific JSON encoding choice |
| `datetime`, `date` | `"unsupported annotation: datetime"` | Preserving timezone semantics requires a specific encoding |
| Enum classes | `"unsupported annotation: <EnumName>"` | Use `Literal["a", "b"]` instead |
| `TypedDict` | `"unsupported annotation: <name>"` | Use a Pydantic model via `logiq_pydantic` |
| Dataclasses | `"unsupported annotation: <name>"` | Use a Pydantic model via `logiq_pydantic` |
| Pydantic models | Handled by `logiq_pydantic` | Not supported natively; the optional adapter enables them |
| Unannotated parameter | `"missing annotation"` | Every input must have a contract |
| Unresolved string annotation | `"could not be resolved to a type"` | Forward references must be resolvable at registration time |

The pattern is deliberate: anything that does not have an unambiguous JSON representation is rejected. Accepting `bytes` or `Decimal` would require the schema engine to make encoding choices that the application never agreed to.

If you need a type in this list, either:

- Use the closest supported type and do the conversion in the handler (e.g., take `str` for ISO-8601 datetimes and parse inside).
- Use `logiq_pydantic` and declare a Pydantic model that carries the conversion logic.

---

## 4. Strict type semantics (ADR-0003)

Three surprises that Logiq handles deliberately:

### `bool` is not `int`

In Python, `isinstance(True, int) == True`. In Logiq, `IntType` explicitly rejects `bool`:

```python
IntType().validate(True)  # error: expected int, got bool
IntType().validate(1)     # ok
```

This matters because a model that says `{"x": true}` should not be accepted by a handler that declares `x: int`. Booleans are not integers here.

### `int` is not `float`

There is no implicit widening:

```python
FloatType().validate(5)    # error: expected float, got int
FloatType().validate(5.0)  # ok
```

If a handler declares `amount: float` and the plan says `{"amount": 5}`, it is rejected. The plan must say `{"amount": 5.0}` or reference a step that returns a float.

`$ref` follows the same rule: `int` → `float` is not assignable. Use a capability with a float output schema, or use `dict[str, float]`, which still requires float values.

### Literal value type must match

```python
LiteralType(("a", "b")).validate("a")  # ok
LiteralType(("a", "b")).validate(1)    # error
LiteralType((1, 2)).validate(True)     # error (bool != int)
```

`True == 1` in Python, so `Literal[1, 2]` explicitly rejects `True`. Use `Literal[True, False]` if you want booleans.

---

## 5. Objects

`ObjectType` is what capability input schemas are. It has:

- `fields: dict[str, Type]` — the declared fields.
- `required: frozenset[str]` — the required field names (those without a default in the handler signature).
- `additional: bool` — whether unknown fields are allowed. Defaults to `False`.

### `additional=False` by default

The default is `additionalProperties: false`. Unknown fields are rejected:

```python
schema = ObjectType(
    fields={"a": IntType()},
    required=frozenset({"a"}),
)
schema.validate({"a": 1, "b": 2})
# → error at $.b: unknown field
```

This is the setting that stops `{"call": "add", "with": {"a": 1, "b": 2, "approved": true}}` from being accepted — the extra field is a schema violation, not a silent ignore. Silently ignoring extra fields is how a malicious model smuggles state.

Applications that need permissive extra fields must say so explicitly by constructing an `ObjectType` with `additional=True`. This is not the default and is not recommended.

### Nested objects

```python
ObjectType(
    fields={
        "order_id": IntType(),
        "customer": ObjectType(
            fields={
                "name": StrType(),
                "email": StrType(),
            },
            required=frozenset({"name"}),
        ),
    },
    required=frozenset({"order_id", "customer"}),
)
```

Nested `ObjectType`s validate recursively. Errors have paths like `$.customer.name`.

---

## 6. JSON Schema export

Every `Type` produces JSON Schema via `to_json_schema()`. The resulting schema is used in `tools.format(...)` and is what the AI client sees.

Example:

```python
@logiq.capability
def issue_refund(
    order_id: Annotated[int, Gt(0)],
    amount: Annotated[float, Gt(0), Le(10_000)],
) -> dict[str, float]:
    ...
```

`logiq.schemas.for_capability("issue_refund").input`:

```json
{
  "type": "object",
  "properties": {
    "order_id": {
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "amount": {
      "type": "number",
      "exclusiveMinimum": 0,
      "maximum": 10000
    }
  },
  "required": ["order_id", "amount"],
  "additionalProperties": false
}
```

This is the exact schema the verifier enforces. Same object, two views.

### `walk` for reference type-checking

Each `Type` also implements `walk(segment) -> Type | None`. This is what lets the verifier traverse a `$ref` path through a schema:

- `ObjectType.walk("field")` returns the field's `Type`.
- `DictType.walk(any_segment)` returns the value type.
- `ListType.walk(integer_segment)` returns the item type.
- `UnionType.walk(segment)` succeeds only if every member resolves the segment to the same type.
- Primitive types return `None` (no structure to walk).

Without `walk`, `$ref` type-checking would have to special-case each type; with it, adapter types (like `PydanticType`) plug in with no changes to the verifier.

---

## 7. Constraints via `Annotated`

A `ConstrainedType` wraps a base `Type` plus a list of constraint objects:

```python
ConstrainedType(
    base=IntType(),
    constraints=(Gt(0), Le(100)),
)
```

Validation runs the base check first, then each constraint. A failure in either produces a `SchemaError`. JSON Schema export merges the base schema with each constraint's fragment.

### `Pattern` uses full match

`Pattern(r"^[a-z]+$")` and `Pattern(r"[a-z]+")` are equivalent. Patterns are applied with `re.fullmatch`; the anchors are cosmetic. This is a deliberate choice — partial matches are a common source of "but I anchored it" bugs.

### Combining constraints

Constraints are checked in order. For `Annotated[float, Gt(0), Le(100)]`:

1. The base `FloatType` validates the type first.
2. `Gt(0)` runs next; `0.0` fails.
3. `Le(100)` runs last; `101.0` fails.

Every constraint reports its own error. A value that fails two constraints produces two errors, both with the same path.

---

## 8. Registration-time behavior

`build_capability(fn, ...)` runs the full check:

1. `inspect_capability(fn)` — structural checks (variadics, async, unbound methods, non-callables).
2. `_maybe_transform_pydantic(info)` — if `logiq_pydantic` is importable, transform model annotations into `PydanticType`.
3. `find_unsupported_annotations(info)` — aggregate every annotation problem into a single error message.
4. `infer_input_schema(info.parameters)` — build the input `ObjectType`.
5. `infer_output_schema(info.return_annotation)` — build the output `Type` or `None`.
6. Construct the `Capability` dataclass.

A registration failure produces one error message listing every problem:

```text
TypeError: cannot register capability 'create_user':
  parameter 'name': missing annotation
  parameter 'tags': unsupported annotation: set
  return: unsupported annotation: dict
```

The aggregated form is much better than failing on the first problem, because the developer fixes all issues in one round.

---

## 9. What changes when `logiq_pydantic` is installed

Registration is unchanged from the user's perspective, but a few things behave differently under the hood:

- Pydantic models in signatures are accepted. `PydanticType` replaces the raw model annotation during `_maybe_transform_pydantic`.
- `Annotated` constraints on a model are dropped. The `Annotated` wrapper is unwrapped to the model; use `Field(...)` inside the model for constraints.
- Nested models are wrapped recursively. `list[Model]`, `dict[str, Model]`, `Optional[Model]` all become `ListType(PydanticType)`, `DictType(PydanticType)`, `UnionType((PydanticType, NoneType))`.
- `Type.walk` traverses into model fields. A `$ref` into a step whose output is a Pydantic model resolves through `PydanticType.walk`. Its return value is normalized to a `dict` before storage, so `$ref` traversal at runtime also works.
- If `logiq_pydantic` is not installed, a Pydantic model in a signature is rejected with `"unsupported annotation: ModelName"`. The error message names the model, not the adapter; the developer has to know that the fix is `pip install "logiq[pydantic]"`. This is documented in `docs/pydantic.md`.

---

## 10. The type system in one sentence

Every annotation either has a faithful JSON Schema representation that Logiq enforces at runtime, or is rejected at registration with a clear error — there is no silent weakening, no coercion, and no implicit acceptance of types that cannot be round-tripped through JSON.
