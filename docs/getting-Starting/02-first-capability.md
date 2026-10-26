# 02 — Your First Capability

Register a Python function as a capability, see the schema ExecGate derives, and watch it reject bad input while accepting good input.

**Time:** 5 minutes.

---

## A capability is just a function

Create a file named `hello_logiq.py`:

```python
from execgate import Logix

logix = Logix()


@logix.capability
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


print(add(2, 3))
```

Run it:

```bash
python hello_logiq.py
```

Output:

```text
5
```

That's the first important fact: `add` is still a normal function. The decorator registered it, but did not wrap it. Your unit tests, your direct calls, and your IDE's "go to definition" all still work.

---

## Run it through ExecGate

Add this to `hello_logiq.py`:

```python
result = logix.run({"call": "add", "with": {"a": 2, "b": 3}})
print(result.ok)
print(result.value)
```

Run it:

```bash
python hello_logiq.py
```

Output:

```text
5
True
5
```

Two ways to call the function:

- Direct: `add(2, 3)` → `5`.
- Through ExecGate: `logix.run(...)` → a `Result` whose `.value` is `5`.

Both are correct. The direct call bypasses the pipeline. The `logix.run()` call goes through it.

---

## See the schema

Add:

```python
import json

print(json.dumps(logix.tools.format("json"), indent=2))
```

Run:

```bash
python hello_logiq.py
```

Abbreviated output:

```json
[
  {
    "name": "add",
    "description": "Add two integers.",
    "input_schema": {
      "type": "object",
      "properties": {
        "a": {"type": "integer"},
        "b": {"type": "integer"}
      },
      "required": ["a", "b"],
      "additionalProperties": false
    },
    "output_schema": {"type": "integer"},
    "effects": null,
    "approval": null,
    "schema_version": "1"
  }
]
```

Two things happened that you didn't write:

- The input schema was derived from the `a: int` and `b: int` annotations.
- The output schema was derived from the `-> int` return annotation.

The description came from the docstring. This is the schema an AI would see. It's the same schema the verifier enforces at execution time — the catalog and the validator cannot disagree.

---

## Watch it reject bad input

Add this to `hello_logiq.py`:

```python
bad = logix.run({"call": "add", "with": {"a": "two", "b": 3}})
print(bad.ok)
print(bad.errors)
```

Output:

```text
False
(Error(code='SCHEMA_VALIDATION_FAILED',
       message="expected int, got str",
       path='with.a', details={}),)
```

Three things to notice:

- `ok=False` — the plan failed verification.
- `code='SCHEMA_VALIDATION_FAILED'` — a stable error code. Switch on this, not on the message.
- `path='with.a'` — the specific argument that failed.

The handler was never invoked. ExecGate validated the plan, found that `"two"` is not an `int`, and rejected the plan before running `add("two", 3)`.

Try more bad input:

```python
print(logix.run({"call": "add", "with": {"a": True, "b": 3}}).errors)
print(logix.run({"call": "add", "with": {"a": 1}}).errors)
print(logix.run({"call": "add", "with": {"a": 1, "b": 2, "c": 3}}).errors)
```

Expected behavior:

- `{"a": True, "b": 3}` → `SCHEMA_VALIDATION_FAILED`: expected `int`, got `bool`. `True` is not `1` in ExecGate.
- `{"a": 1}` → `SCHEMA_VALIDATION_FAILED`: missing required field `b`.
- `{"a": 1, "b": 2, "c": 3}` → `SCHEMA_VALIDATION_FAILED`: unknown argument `c`.

The last one is important. Silently ignoring extra fields is a way for a model to smuggle state past validation. `add`'s schema has `"additionalProperties": false`, so the extra `c` is rejected rather than silently ignored.

---

## Watch it reject the dict return

Try registering a capability that returns a bare `dict`:

```python
@logix.capability
def get_customer(customer_id: int) -> dict:
    """Retrieve a customer."""
    return {"id": customer_id}
```

Expected error:

```text
TypeError: cannot register capability 'get_customer':
  return: unsupported annotation: dict
```

A bare `dict` is not a schema. It says "returns a dict with arbitrary keys and values." ExecGate cannot validate that. Use `dict[str, int]` or a Pydantic model.

Fix it:

```python
@logix.capability
def get_customer(customer_id: int) -> dict[str, int]:
    """Retrieve a customer."""
    return {"id": customer_id}
```

Now it registers. The output schema is:

```json
{
  "type": "object",
  "additionalProperties": {
    "type": "integer"
  }
}
```

This represents a dictionary whose values must all be integers.

This is the **"reject rather than weaken"** rule. If ExecGate accepted a bare `dict`, it would silently skip output validation for that capability. That's worse than a clear error.

---

## Try an unsupported annotation

```python
@logix.capability
def tag(x: set) -> int:
    return 0
```

Expected error:

```text
TypeError: cannot register capability 'tag':
  parameter 'x': unsupported annotation: set
```

`set` is not JSON-representable. ExecGate rejects it at registration rather than silently accepting something it can't validate.

The error aggregates every problem at once. If three parameters have problems, all three appear in the message. You fix them in one round.

---

## What's in the registry

Inspect the registered capabilities:

```python
for cap in logix.registry:
    print(cap.name, "->", cap.output_schema.to_json_schema())
```

Expected output, assuming `add` and `get_customer` are registered:

```text
add -> {'type': 'integer'}
get_customer -> {'type': 'object', 'additionalProperties': {'type': 'integer'}}
```

The `Capability` dataclass has:

- `name`, `description`, `handler`
- `input_schema`, `output_schema`
- `effects`, `requires_approval`, `idempotent`

You'll use most of these later.

---

## What you've learned

- A capability is your Python function, unchanged. `add(2, 3)` still works.
- The decorator infers schemas from annotations. No manual schema authoring is needed for these examples.
- Bad input is rejected before the handler runs.
- Bare `dict`, bare `list`, `set`, and `Any` are rejected at registration. This is the "reject rather than weaken" rule.
- Errors are structured: `code` + `message` + `path`.

You now have **Level 1 — ExecGate as a schema-enforcing dispatcher**.

The next file goes further: multi-step plans with references between steps.

→ [03 — First Plan](03-first-plan.md)
