# 04 — With an AI

Send the catalog to a model, receive its proposal, run it through Logiq, and return the result.

**Time:** 5 minutes.

---

## The five steps

Every AI integration, regardless of provider, has the same shape:

1. **Get the catalog** — `logix.tools.format(...)`.
2. **Send it to the model** — via the provider's API.
3. **Receive the proposal** — a JSON plan.
4. **Parse it** — via an adapter (`logiq_ai`) or hand-written code.
5. **Run it through Logiq** — `logix.run(plan, context=ctx)`.

Steps 1 and 5 are Logiq's responsibility. Steps 2, 3, and 4 belong to the application. This file shows all five.

---

## The catalog is what the AI sees

```python
import json

from logiq import Logix

logix = Logix()


@logix.capability(effects="read")
def get_order(order_id: int) -> dict[str, float]:
    """Retrieve an order by its ID."""
    return {"id": float(order_id), "total": 50.0}


@logix.capability(effects="write")
def issue_refund(order_id: float, amount: float) -> dict[str, float]:
    """Issue a refund for an order."""
    return {"refunded": order_id, "amount": amount}


catalog = logix.tools.format("json")
print(json.dumps(catalog, indent=2))
```

Example output (abbreviated):

```json
[
  {
    "name": "get_order",
    "description": "Retrieve an order by its ID.",
    "input_schema": {
      "type": "object",
      "properties": {
        "order_id": {"type": "integer"}
      },
      "required": ["order_id"],
      "additionalProperties": false
    },
    "output_schema": {"type": "object"},
    "effects": "read",
    "approval": null,
    "schema_version": "1"
  },
  {
    "name": "issue_refund",
    "...": "...",
    "effects": "write"
  }
]
```

The catalog is JSON Schema. Any client that can read JSON Schema can consume it. `tools.format("json")` requires no optional package — it's the neutral format behind the claim that Logiq works with any AI that emits JSON.

For a specific provider, use `tools.format(provider)`:

```python
openai_catalog = logix.tools.format("openai")
# Example shape:
# [{"type": "function", "function": {"name": "get_order", ...}}, ...]
```

This requires the optional AI integration:

```bash
pip install "logiq[ai]"
```

`tools.format("json")` is always available; provider-specific formats are conveniences.

---

## A minimal loop

You need two pieces beyond Logiq:

- A way to call the model with the catalog.
- An adapter to extract the plan from the response.

Both are outside Logiq. Here's the shape:

```python
from logiq import Logix
from logiq_ai import get_adapter  # pip install "logiq[ai]"

logix = Logix()

# Register capabilities as shown above.

adapter = get_adapter("openai")  # Or "anthropic", "gemini", "local"


def handle(user_message: str) -> str:
    ctx = logix.context(principal="alice")
    catalog = adapter.format_tools(logix.tools.describe())

    # Step 2: Send the catalog to the model.
    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": "You are a support agent."},
            {"role": "user", "content": user_message},
        ],
        tools=catalog,
    )

    # Steps 3 and 4: Extract the plan from the model's response.
    plan = adapter.parse_proposal(response)

    # Step 5: Run it through Logiq.
    result = logix.run(plan, context=ctx)

    if result.ok:
        return f"Done: {result.value}"

    return f"I couldn't do that: {[e.message for e in result.errors]}"
```

The five steps are visible. `openai_client` is your OpenAI client — Logiq does not import it, make the API call, or hold an API key.

---

## Try the failure modes

The value of the boundary shows up on failure paths. Here are three worth seeing.

### 1. The model proposes an invented capability

```python
# The model invents "delete_all_users", a capability that doesn't exist.
bad_plan = {"call": "delete_all_users", "with": {"user_id": 1}}

result = logix.run(bad_plan, context=ctx)
print(result.errors[0].code)
```

Output:

```text
UNKNOWN_CAPABILITY
```

The handler was never considered. Logiq rejected the capability name before any handler could run.

### 2. The model proposes incorrect argument types

```python
bad_plan = {
    "call": "get_order",
    "with": {"order_id": "five-oh-two"},
}

result = logix.run(bad_plan, context=ctx)
print(result.errors[0].code, result.errors[0].path)
```

Output:

```text
SCHEMA_VALIDATION_FAILED with.order_id
```

The path, `with.order_id`, tells you and the model exactly what went wrong.

### 3. The model proposes a valid plan with a bad value

Without grounding configured:

```python
bad_plan = {
    "version": "1",
    "steps": [
        {"id": "o", "call": "get_order", "with": {"order_id": 502}},
        {
            "id": "r",
            "call": "issue_refund",
            "with": {
                "order_id": {"$ref": "o.id"},
                "amount": 9999.0,  # Literal, potentially fabricated
            },
        },
    ],
}

result = logix.run(bad_plan, context=ctx)
print(result.ok)
```

Output:

```text
True
```

This succeeds. The schema says `amount: float`; `9999.0` is a float. Without grounding, Logiq cannot know that the amount is fabricated.

With grounding:

```python
logix.grounding(require_ref_for=["issue_refund.amount"])

result = logix.run(bad_plan, context=ctx)
print(result.errors[0].code)
```

Output:

```text
GROUNDING_REQUIRED
```

Now it fails. The model must source `amount` from an earlier step's validated output.

This is the **hallucination gap**. Schema validation alone does not close it. Grounding helps close it for the sensitive arguments you configure.

---

## Feeding the result back

On success, the application can return the value to the model for a final answer. On failure, it can return structured errors instead of raw exception text.

```python
def format_result_for_model(result):
    if result.ok:
        return {"ok": True, "value": result.value}

    return {
        "ok": False,
        "errors": [
            {"code": e.code, "message": e.message, "path": e.path}
            for e in result.errors
        ],
    }
```

This is the shape the model reads. `Result.to_dict()` produces it directly:

```python
serialized = result.to_dict()
```

The model can propose a corrected plan based on the error, but the corrected plan goes through verification again. The model cannot skip the boundary by proposing a "fixed" plan; the pipeline runs both times.

---

## What the model does not see

| Model sees | Model does not see |
|---|---|
| `logix.tools.format(...)` — the catalog | Your handler's source code |
| `Result.to_dict()` — safe serialization | Your database or external services |
| Error codes and messages | Your policy code |
| The description on each capability | Your `ExecutionContext` |
| `effects` and approval flags | The `ApprovalToken` |
| | The `VerifiedPlan` |
| | Your `Logix` instance |

The catalog is what the model needs to propose actions. Everything else stays on the trusted side unless your application explicitly shares it.

---

## "Works with any AI that emits JSON"

Not just hosted models. A hand-written script, a local model, another service — anything that produces a plan dictionary can flow through the same pipeline.

```python
import json

# A script — no AI involved.
plan = {"call": "get_order", "with": {"order_id": 502}}
result = logix.run(plan, context=ctx)

# A local model that emits JSON text.
plan = json.loads(local_model_output)
result = logix.run(plan, context=ctx)

# A hosted model whose proposal was parsed by an adapter.
plan = adapter.parse_proposal(response)
result = logix.run(plan, context=ctx)
```

The boundary doesn't know or care which producer created the plan. That's why `logiq_ai` is a convenience: it translates the catalog for a provider and parses that provider's response. The pipeline works without it.

---

## What you've learned

- The catalog is JSON Schema. `logix.tools.format("json")` works without an optional integration; provider-specific formats are optional.
- The five steps are: get the catalog, send it to the model, receive the proposal, parse it, and run it through Logiq.
- Logiq does not call the model. Your application owns that call.
- Failures return structured errors. The model can propose a repair, but the repaired plan is verified again.
- The pipeline works without AI. A hand-written dictionary is treated the same as an AI's proposal at the boundary.

You now have **Level 2 — Logiq with an AI in the loop**. The next file points you toward Level 3 (production) and the rest of the documentation.

→ [05 — What Now?](05-what-now.md)
