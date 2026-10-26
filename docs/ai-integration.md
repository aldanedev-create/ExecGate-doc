# AI Integration

How a ExecGate engine talks to an AI, and why provider adapters are convenience — not a requirement.

The core guarantee: **the trust boundary does not know or care which model produced a proposal.** `logix.run(plan)` accepts any JSON-shaped plan. A hand-written dictionary, a plan from OpenAI, or a plan from a local model — they all flow through the identical pipeline. See `tests/integration/test_any_json_producer.py`.

---

## 1. The five steps

Every AI integration, regardless of provider, has the same shape:

1. **Register capabilities** — `@logix.capability` on trusted functions.
2. **Get the catalog** — `logix.tools.describe()` or `.format(provider)`.
3. **Send the catalog to the model** — via the provider's API.
4. **Receive the model's proposal** — usually as JSON.
5. **Run it through ExecGate** — `logix.run(plan, context=ctx)`.

Steps 1, 2, and 5 are ExecGate. Steps 3 and 4 belong to the application. The provider-specific part is the *shape* of the catalog sent (step 3) and the *shape* of the response (step 4). That's what `execgate_ai` handles.

---

## 2. The neutral catalog

`logix.tools.format("json")` returns a list of dictionaries:

```json
[
  {
    "name": "get_order",
    "description": "Retrieve an order by its ID.",
    "input_schema": {
      "type": "object",
      "properties": {
        "order_id": {
          "type": "integer"
        }
      },
      "required": ["order_id"],
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object"
    },
    "effects": "read",
    "approval": null,
    "schema_version": "1"
  }
]
```

That's it. Any client that can read JSON Schema can consume this. It is the guaranteed interface: `logix.tools.format("json")` requires no optional package and never raises.

The `input_schema` is the exact schema the verifier enforces. The catalog and the validator cannot disagree.

---

## 3. Provider adapters

`execgate_ai` provides provider-specific formatting. It is a leaf node (ADR-0006) and has zero runtime dependencies — it does no HTTP requests and imports no SDK. It only shapes JSON.

```python
from execgate_ai import get_adapter

adapter = get_adapter("openai")
tools = adapter.format_tools(logix.tools.describe())
# [{"type": "function", "function": {"name": "get_order", ...}}, ...]
```

Four providers ship in version 0.1.0:

| Provider | Adapter name | Shape |
|---|---|---|
| OpenAI | `"openai"` | `{"type": "function", "function": {...}}` |
| Anthropic | `"anthropic"` | `{"name": ..., "description": ..., "input_schema": ...}` |
| Gemini | `"gemini"` | `{"name": ..., "description": ..., "parameters": ...}` |
| Local (Ollama, llama.cpp, vLLM) | `"local"` | Neutral form plus prompt builder |

Unknown providers fall back to `"json"`. `logix.tools.format("some-new-provider")` returns the neutral catalog. It never raises.

---

## 4. ProviderAdapter: the entire contract

```python
class ProviderAdapter(Protocol):
    name: str

    def format_tools(self, specs: list[ToolSpec]) -> Any: ...
    def parse_proposal(self, raw: Any) -> dict[str, Any]: ...
```

Two methods:

- `format_tools` shapes the catalog for the API call.
- `parse_proposal` extracts a plan dictionary from the provider's response.

That is the entire interface. An adapter cannot call `verify`, cannot construct a `VerifiedPlan`, and cannot touch the registry. Its job is translation. See ADR-0006.

### `format_tools`

**Input:** A list of `ToolSpec` objects from `logix.tools.describe()`.

**Output:** Whatever the provider's SDK expects for its `tools=` argument.

### `parse_proposal`

**Input:** The provider's response object; its shape varies by provider.

**Output:** A plain dictionary such as `{"call": "...", "with": {...}}`, or an `AdapterError` if the response cannot be translated.

`parse_proposal` must not:

- Mark a plan as verified.
- Inject `"verified": true`.
- Resolve `$ref` expressions.
- Read or mutate the capability registry.

The returned dictionary is fed to `logix.run(...)`, which runs the full pipeline. If a buggy adapter returns a plan with `"verified": true`, the parser rejects it as an unknown top-level field.

The parser is the boundary; the adapter is convenience.

---

## 5. OpenAI end-to-end

```python
import json
import openai

from execgate import Logix
from execgate_ai import get_adapter


logix = Logix()


@logix.capability(effects="read")
def get_order(order_id: int) -> dict[str, int]:
    "Retrieve an order."
    return {"id": order_id, "status": 1}


adapter = get_adapter("openai")
client = openai.OpenAI()


def answer(user_msg: str, principal: str) -> str:
    ctx = logix.context(principal=principal)
    catalog = adapter.format_tools(logix.tools.describe())

    messages = [
        {"role": "system", "content": "You are a support agent."},
        {"role": "user", "content": user_msg},
    ]

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        tools=catalog,
    )

    msg = response.choices[0].message

    # No tool call: the model answered directly.
    if not msg.tool_calls:
        return msg.content or ""

    # The model proposed a tool. Parse and verify.
    plan = adapter.parse_proposal(response)
    result = logix.run(plan, context=ctx)

    # Feed the result back for the final answer.
    if result.ok:
        tool_result = {"ok": True, "value": result.value}
    else:
        tool_result = {
            "ok": False,
            "errors": [e.to_dict() for e in result.errors],
        }

    messages.append(msg)
    messages.append({
        "role": "tool",
        "tool_call_id": msg.tool_calls[0].id,
        "content": json.dumps(tool_result),
    })

    final = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
    )

    return final.choices[0].message.content or ""
```

Notice: the model receives `{"ok": false, "errors": [...]}` — not a traceback or an exception. `Result.to_dict()` is the safe serialization. That's what lets the model reason about failures and propose a corrected plan.

---

## 6. Anthropic end-to-end

The same shape, with a different API:

```python
import anthropic

from execgate_ai import get_adapter


adapter = get_adapter("anthropic")
client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    system="You are a support agent.",
    tools=adapter.format_tools(logix.tools.describe()),
    messages=[{"role": "user", "content": user_msg}],
)

plan = adapter.parse_proposal(response)  # Walks content blocks.
result = logix.run(plan, context=ctx)
```

Anthropic's input field is already a dictionary, so no JSON-string parsing is needed. The adapter's `parse_proposal` extracts the first `tool_use` block.

---

## 7. Local model (no native tool calling)

For Ollama, llama.cpp, or any local server that emits text but has no tool-calling API:

```python
from execgate_ai import get_adapter
from execgate_ai.prompt_json_mode import build


adapter = get_adapter("local")

system = build(
    logix.tools.describe(),
    system="You are a support agent.",
)

response = ollama.chat(
    model="llama3.1:70b",
    messages=[
        {"role": "system", "content": system},
        {"role": "user", "content": user_msg},
    ],
)

plan = adapter.parse_proposal(response)  # Parses the JSON text.
result = logix.run(plan, context=ctx)
```

`build(...)` produces a system prompt containing:

- Every capability's name, description, input schema, and output schema.
- Instructions to respond with exactly one `{"call": ..., "with": ...}` JSON object (strict mode), or to include one somewhere in the response (lenient mode).

`LocalAdapter.parse_proposal` accepts:

- A raw string (parses it as JSON).
- Ollama's `{"response": "..."}`.
- llama.cpp's `{"content": "..."}`.
- OpenAI-compatible `{"choices": [{"message": {"content": "..."}}]}`.
- vLLM's `{"text": "..."}`.

If the local server supports OpenAI-compatible tool calling, use `get_adapter("openai")` — the wire format is identical.

---

## 8. Writing your own adapter

Approximately 30 lines. See `docs/writing-an-adapter.md` for the full walkthrough.

The short version:

1. Create `src/execgate_ai/providers/<name>.py` with a class that implements `ProviderAdapter`.
2. Register it in `execgate_ai/registry.py::_PROVIDERS`.
3. Add `tests/adapters/test_<name>.py`, subclassing `AdapterContractMixin`.

The conformance mixin enforces:

- `format_tools([])` does not raise.
- `format_tools(SAMPLE_SPECS)` names every capability.
- `parse_proposal(sample)` returns a plain dictionary equal to the expected neutral plan.
- `parse_proposal` raises `AdapterError` on malformed input.
- The adapter exposes no trust-boundary attributes.

An adapter that cannot pass the conformance kit is not accepted, regardless of whether it "works" against a particular provider today.

---

## 9. The agent loop

The model call and the tool call form a loop. A single-shot plan is a special case. The general shape:

```python
import json

from execgate.semantic import RepairLoop, RepairRefused


loop = RepairLoop(max_attempts=3, registry=logix.registry)

for attempt in range(loop.max_attempts):
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        tools=catalog,
    )

    plan = adapter.parse_proposal(response)
    capabilities = [s.get("call") for s in _extract_calls(plan)]

    # Check before running.
    try:
        loop.assert_proposal(capabilities)
    except RepairRefused as e:
        return f"I can't do that — {e}"

    result = logix.run(plan, context=ctx)
    loop.record_outcome(result.errors)

    if result.ok:
        return result.value

    # Bounded retry with structured errors.
    messages.append({
        "role": "tool",
        "content": json.dumps([e.to_dict() for e in result.errors]),
    })

return "I couldn't complete that after several attempts."
```

Two properties matter:

**Bounded attempts.** `max_attempts` caps the total. A model that keeps proposing plans that fail does not grind forever.

**Reroute refusal.** After a `POLICY_REJECTED`, `AUTHORIZATION_FAILED`, or `APPROVAL_REQUIRED`, `RepairLoop` refuses proposals that touch the same capability or effect class. The model cannot route around a denial. See `docs/semantic-layer.md` §7.

---

## 10. What the model sees vs. what it doesn't

| The AI sees | The AI does not see |
|---|---|
| `logix.tools.format(...)` — JSON Schema catalog | The handler code |
| `Result.to_dict()` — safe serialization | The database |
| Error codes and messages | The approval token |
| The description on each capability | The `ExecutionContext` |
| Whatever the application chooses to send | The policy code |
| | The registry internals |
| | The `VerifiedPlan` |

The catalog is what an AI needs to propose actions. Everything else is trust-side.

---

## 11. Testing AI integration without an AI

The guarantee is testable with a hand-written plan:

```python
def test_handwritten_plan_gets_same_guarantees(logix):
    @logix.capability
    def add(a: int, b: int) -> int:
        return a + b

    # Any producer of the same logical plan gets the same result.
    plans = [
        {"call": "add", "with": {"a": 3, "b": 4}},
        '{"call": "add", "with": {"a": 3, "b": 4}}',
        NeutralJSONAdapter().parse_proposal({
            "call": "add",
            "with": {"a": 3, "b": 4},
        }),
        OpenAIAdapter().parse_proposal({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "add",
                            "arguments": '{"a": 3, "b": 4}',
                        }
                    }]
                }
            }]
        }),
    ]

    for plan in plans:
        result = logix.run(plan)
        assert result.ok and result.value == 7
```

`tests/integration/test_any_json_producer.py` formalizes this. It is the proof of the "works with any AI that emits JSON" claim.

---

## 12. What `execgate_ai` does not do

- **Does not make model calls.** The application has the SDK; the adapter shapes data.
- **Does not stream.** Tool calls arrive complete in a single response for all supported providers. Streaming is an application concern: collect the deltas, then call `parse_proposal` on the assembled response.
- **Does not handle multi-step proposals.** Every adapter's `parse_proposal` extracts one tool call and returns a single-step plan. Multi-step is the application's job — either the model emits a `{"version": "1", "steps": [...]}` object directly (via JSON mode), or the application loops.
- **Does not sanitize prompts or responses.** Content scanning is a separate concern (see `docs/mcp.md`).
- **Does not require any provider SDK.** There are zero runtime dependencies; the application imports its own SDK.