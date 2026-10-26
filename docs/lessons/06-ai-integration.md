## Lesson 06 (full replacement)

Below is the full updated file. The changes are concentrated in Step 2 (client setup) and Step 3 (model selection), plus a new note on free models.

```markdown
# Lesson 06 — AI Integration

Make a real AI propose plans. By the end, you'll have a working agent
loop that sends the catalog to a model, receives a plan, runs it through
Logiq, feeds the result back, and handles failures with bounded retry.

This lesson uses **OpenRouter** by default — one API key, access to
OpenAI, Anthropic, Google, and open-weight models through the same
endpoint. You can swap to a direct provider or a local model later; the
Logiq side does not change.

**Time:** 45 minutes. **You will build:** ~120 lines of application code,
~60 lines of tests. **You will understand:** the five-step loop, multi-turn
conversation with tool calls, error recovery, the `RepairLoop`, and the
provider swap.

---

## The gap this lesson closes

Lessons 01–05 all used hand-written plans:

```python
plan = {"call": "add", "with": {"a": 2, "b": 3}}
result = logix.run(plan)
```

That's the right way to test the boundary. But you don't have a hand
writing plans in production — you have a model. This lesson wires a real
model into the loop.

The good news: **the pipeline doesn't change.** A plan from an OpenAI
function call is a plan. A plan from an Anthropic tool-use block is a
plan. A plan from a hand-written dict is a plan. All three flow through
the same parser, verifier, recheck window, and executor.

The only thing that changes is how you *get* the plan.

---

## What you're building

A support agent that can:

- Answer questions about orders (read-only capabilities).
- Issue refunds (write capability, with invariants).
- Handle multi-turn conversations.
- Recover from rejected plans.
- Bound retries with the `RepairLoop`.

The model is **real**. You will send actual API calls through OpenRouter.

---

## Setup

```bash
mkdir -p logiq-lessons/06-ai-integration && cd logiq-lessons/06-ai-integration
touch agent.py
pip install "logiq[ai]" openai
export OPENROUTER_API_KEY="sk-or-v1-..."
```

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys). Free models are available; many support tool calling . Check the model page for tool support before relying on a specific model.

No other SDK is needed. OpenRouter is OpenAI-compatible, so `pip install openai` is the whole install .

---

## Step 1 — The domain and capabilities

Same shape as Lesson 01, but simpler.

```python
from logiq import Logix, Allow, Deny

logix = Logix()

ORDERS: dict[int, dict] = {
    502: {"id": 502, "owner": "alice", "state": "delivered", "total": 50.0},
    777: {"id": 777, "owner": "bob",   "state": "shipped",   "total": 900.0},
}
REFUNDED: set[int] = set()


@logix.capability(effects="read")
def get_order(order_id: int) -> dict[str, float]:
    "Retrieve an order by its ID."
    order = ORDERS[order_id]
    return {"id": float(order["id"]), "total": order["total"]}


@logix.capability(effects="read")
def list_my_orders() -> list[int]:
    "List all order IDs."
    return list(ORDERS.keys())


@logix.capability(effects="write")
def refund_order(order_id: int) -> dict[str, float]:
    "Issue a full refund for an order (fetches total internally)."
    order = ORDERS[order_id]
    REFUNDED.add(order_id)
    return {"refunded": float(order_id), "amount": order["total"]}


def refund_policy(args, ctx):
    order = ORDERS[args["order_id"]]
    if order["owner"] != ctx.principal:
        return Deny("NOT_OWNER", "caller does not own this order")
    if order["state"] != "delivered":
        return Deny("NOT_DELIVERED", "order is not refundable")
    return Allow()

logix.authorize(refund_order, check=refund_policy)
```

Note: `refund_order` takes only `order_id`. The amount is computed by
the handler from `ORDERS[order_id]["total"]`. This is the **composite
capability** pattern — it makes grounding unnecessary because the model
never types a sensitive amount. See Step 5 for why this matters with
function-calling models.

---

## Step 2 — The OpenRouter client

```python
import openai

client = openai.OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.environ["OPENROUTER_API_KEY"],
)
```

That's it. The `openai` SDK talks to OpenRouter because OpenRouter
exposes the OpenAI chat completions API .

Optional headers for OpenRouter attribution (useful for their rankings,
not required):

```python
client = openai.OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.environ["OPENROUTER_API_KEY"],
    default_headers={
        "HTTP-Referer": "https://your-app.example.com",
        "X-Title": "Logiq Lesson 06",
    },
)
```

---

## Step 3 — Choose a model

```python
from logiq_ai import get_adapter

adapter = get_adapter("openai")   # OpenRouter uses OpenAI's tool shape

# Pick a model that supports tool calling. Examples:
MODEL = "openai/gpt-4o"                    # paid, reliable
# MODEL = "anthropic/claude-sonnet-4.5"    # paid, different provider
# MODEL = "qwen/qwen3.6-plus:free"         # free tier, tool calling 
# MODEL = "meta-llama/llama-3.3-70b-instruct:free"  # free tier 

catalog = adapter.format_tools(logix.tools.describe())
print(json.dumps(catalog, indent=2)[:500])
```

**If you're using a free model**, check its model page for tool-calling
support. Not every free endpoint supports `tools` . The
models listed above support it; `qwen/qwen3.6-plus:free` and
`meta-llama/llama-3.3-70b-instruct:free` are good starting points
.

---

## Step 4 — A single-turn call

```python
import json
import os

def ask(user_message: str) -> dict:
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": (
                "You are a support agent. Use the available tools to "
                "answer questions and take actions. Always call a tool "
                "when you need information — do not guess."
            )},
            {"role": "user", "content": user_message},
        ],
        tools=adapter.format_tools(logix.tools.describe()),
        tool_choice="auto",
    )

    msg = response.choices[0].message

    if not msg.tool_calls:
        return {"ok": True, "answer": msg.content}

    plan = adapter.parse_proposal(response)
    print(f"[model proposed]: {plan}")

    result = logix.run(plan, context=logix.context(principal="alice"))
    print(f"[logiq result]: {result.ok} {result.errors if not result.ok else result.value}")

    return {"ok": result.ok, "plan": plan, "result": result.to_dict()}
```

Run:

```python
ask("What is the total on order 502?")
```

Output (approximately):

```
[model proposed]: {'call': 'get_order', 'with': {'order_id': 502}}
[logiq result]: True {'id': 502.0, 'total': 50.0}
```

**The model proposed a plan. Logiq verified and executed it.** The
`openai` SDK sent the request to OpenRouter; OpenRouter routed it to the
model you chose; the model returned a tool call in OpenAI's format;
`adapter.parse_proposal` extracted the plan; `logix.run` ran it.

---

## Step 5 — The multi-turn loop

Same as before, but the model is now real.

```python
def chat_turn(messages: list[dict], user_message: str, principal: str = "alice") -> list[dict]:
    messages = messages + [{"role": "user", "content": user_message}]
    ctx = logix.context(principal=principal)

    while True:
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=adapter.format_tools(logix.tools.describe()),
            tool_choice="auto",
        )
        msg = response.choices[0].message

        if not msg.tool_calls:
            messages.append({"role": "assistant", "content": msg.content})
            print(f"\n[assistant]: {msg.content}\n")
            return messages

        plan = adapter.parse_proposal(response)
        print(f"[model proposed]: {plan}")

        result = logix.run(plan, context=ctx)
        print(f"[logiq result]: {result.ok}")

        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in msg.tool_calls
            ],
        })

        if result.ok:
            tool_result = {"ok": True, "value": result.value}
        else:
            tool_result = {"ok": False, "errors": [e.to_dict() for e in result.errors]}

        messages.append({
            "role": "tool",
            "tool_call_id": msg.tool_calls[0].id,
            "content": json.dumps(tool_result),
        })
```

Try:

```python
messages = []
messages = chat_turn(messages, "What is the total on order 502?")
messages = chat_turn(messages, "List all my orders.")
```

Expected output (approximate, model-dependent):

```
[model proposed]: {'call': 'get_order', 'with': {'order_id': 502}}
[logiq result]: True

[assistant]: Order 502 has a total of $50.00.

[model proposed]: {'call': 'list_my_orders', 'with': {}}
[logiq result]: True

[assistant]: You have 2 orders: 502 and 777.
```

---

## Step 6 — Error recovery and the grounding trap

Try a refund:

```python
messages = []
messages = chat_turn(messages, "Refund order 502.", principal="alice")
```

With `refund_order(order_id)` (the composite capability), this should
work in one turn:

```
[model proposed]: {'call': 'refund_order', 'with': {'order_id': 502}}
[logiq result]: True

[assistant]: I've issued a full refund for order 502, refunding $50.00.
```

**If you had used `issue_refund(order_id, amount)` instead**, the model
would have proposed `{"amount": 50.0}` as a literal. With grounding
configured, that would be rejected with `GROUNDING_REQUIRED` — but the
model has no way to know what `$ref` is, because function-calling
produces single-call plans. It would retry and fail.

This is the **grounding trap** with function-calling models. Grounding
is a multi-step concept; the tool schema is single-call. The fix is a
composite capability: the model passes `order_id`, the handler computes
the amount. The invariant still runs. Grounding is not needed because
the sensitive value never appears in the plan.

---

## Step 7 — The repair loop

```python
from logiq.semantic import RepairLoop, RepairRefused

def agent_turn(messages, user_message, principal="alice"):
    messages = messages + [{"role": "user", "content": user_message}]
    ctx = logix.context(principal=principal)
    loop = RepairLoop(max_attempts=3, registry=logix.registry)

    for attempt in range(loop.max_attempts):
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=adapter.format_tools(logix.tools.describe()),
            tool_choice="auto",
        )
        msg = response.choices[0].message

        if not msg.tool_calls:
            messages.append({"role": "assistant", "content": msg.content})
            return messages

        plan = adapter.parse_proposal(response)
        capabilities = [plan.get("call")] if "call" in plan else []

        try:
            loop.assert_proposal(capabilities)
        except RepairRefused as e:
            messages.append({"role": "assistant", "content": f"I can't do that — {e}"})
            return messages

        result = logix.run(plan, context=ctx)
        loop.record_outcome(result.errors)

        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in msg.tool_calls
            ],
        })

        tool_result = (
            {"ok": True, "value": result.value} if result.ok
            else {"ok": False, "errors": [e.to_dict() for e in result.errors]}
        )
        messages.append({
            "role": "tool",
            "tool_call_id": msg.tool_calls[0].id,
            "content": json.dumps(tool_result),
        })

    messages.append({"role": "assistant", "content": "I wasn't able to complete that after several attempts."})
    return messages
```

Test the reroute refusal: alice tries to refund bob's order 777.

```python
messages = []
messages = agent_turn(messages, "Refund order 777.", principal="alice")
```

The invariant denies with `POLICY_REJECTED` (`NOT_OWNER`). On the next
attempt, if the model tries `refund_order` again (or any other write
capability), `RepairLoop` refuses with `RepairRefused`. The user sees a
clear rejection.

---

## Step 8 — Swap providers without changing Logiq

**Anthropic via OpenRouter** — change the model string:

```python
MODEL = "anthropic/claude-sonnet-4.5"
```

The adapter (`get_adapter("openai")`) stays the same. OpenRouter
normalizes the tool-call format to OpenAI's shape . Nothing
else changes.

**Direct OpenAI** — remove `base_url`, use `OPENAI_API_KEY`:

```python
client = openai.OpenAI()   # uses OPENAI_API_KEY
MODEL = "gpt-4o"
```

Same adapter, same loop.

**Direct Anthropic SDK** — use `get_adapter("anthropic")` and the
Anthropic client. Different `format_tools` / `parse_proposal`, same
`logix.run(plan)`.

**Local model (Ollama)** — `get_adapter("local")` and
`prompt_json_mode.build(...)`. No API key needed; see
`docs/ai-integration.md §7`.

---

## Step 9 — Complete file

```python
"""Lesson 06: AI integration via OpenRouter."""

import json
import os

import openai

from logiq import Logix, Allow, Deny
from logiq.semantic import RepairLoop, RepairRefused
from logiq_ai import get_adapter


logix = Logix()

ORDERS = {
    502: {"id": 502, "owner": "alice", "state": "delivered", "total": 50.0},
    777: {"id": 777, "owner": "bob",   "state": "shipped",   "total": 900.0},
}
REFUNDED = set()


@logix.capability(effects="read")
def get_order(order_id: int) -> dict[str, float]:
    "Retrieve an order by its ID."
    order = ORDERS[order_id]
    return {"id": float(order["id"]), "total": order["total"]}


@logix.capability(effects="read")
def list_my_orders() -> list[int]:
    "List all order IDs."
    return list(ORDERS.keys())


@logix.capability(effects="write")
def refund_order(order_id: int) -> dict[str, float]:
    "Issue a full refund for an order."
    order = ORDERS[order_id]
    REFUNDED.add(order_id)
    return {"refunded": float(order_id), "amount": order["total"]}


def refund_policy(args, ctx):
    order = ORDERS[args["order_id"]]
    if order["owner"] != ctx.principal:
        return Deny("NOT_OWNER", "caller does not own this order")
    if order["state"] != "delivered":
        return Deny("NOT_DELIVERED", "order is not refundable")
    return Allow()

logix.authorize(refund_order, check=refund_policy)


client = openai.OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.environ["OPENROUTER_API_KEY"],
)
adapter = get_adapter("openai")
MODEL = "openai/gpt-4o"


def chat_turn(messages, user_message, principal="alice"):
    messages = messages + [{"role": "user", "content": user_message}]
    ctx = logix.context(principal=principal)
    loop = RepairLoop(max_attempts=3, registry=logix.registry)

    for _ in range(loop.max_attempts):
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=adapter.format_tools(logix.tools.describe()),
            tool_choice="auto",
        )
        msg = response.choices[0].message

        if not msg.tool_calls:
            messages.append({"role": "assistant", "content": msg.content})
            return messages

        plan = adapter.parse_proposal(response)
        caps = [plan.get("call")] if "call" in plan else []

        try:
            loop.assert_proposal(caps)
        except RepairRefused as e:
            messages.append({"role": "assistant", "content": f"I can't do that — {e}"})
            return messages

        result = logix.run(plan, context=ctx)
        loop.record_outcome(result.errors)

        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in msg.tool_calls
            ],
        })
        messages.append({
            "role": "tool",
            "tool_call_id": msg.tool_calls[0].id,
            "content": json.dumps(
                {"ok": True, "value": result.value} if result.ok
                else {"ok": False, "errors": [e.to_dict() for e in result.errors]}
            ),
        })

    messages.append({"role": "assistant", "content": "I wasn't able to complete that after several attempts."})
    return messages


if __name__ == "__main__":
    messages = []
    messages = chat_turn(messages, "What is the total on order 502?")
    messages = chat_turn(messages, "List all my orders.")
    messages = chat_turn(messages, "Refund order 502.")
```

Run:

```bash
python agent.py
```

---

## What to try next

**1. Try a free model.** Change `MODEL` to
`qwen/qwen3.6-plus:free` or `meta-llama/llama-3.3-70b-instruct:free`.
Compare tool-calling quality. Free models vary; some handle the catalog
well, some propose invalid arguments more often. That variance is the
model's tool-calling quality, not Logiq's.

**2. Try a wrong-provider model.** Change `MODEL` to
`anthropic/claude-sonnet-4.5` via OpenRouter. The adapter stays
`"openai"`. Confirm the loop still works.

**3. Add a reroute attempt.** Register `issue_refund` (the version with
a literal amount) *alongside* `refund_order`. See if the model tries
`issue_refund` after `refund_order` is denied, and whether `RepairLoop`
refuses it.

**4. Add an approval gate.** Call `logix.require_approval(refund_order)`.
The model will get `APPROVAL_REQUIRED`. Modify `chat_turn` to issue a
token after a stub "approval" and re-execute. This is Lesson 01's
pattern applied to the AI loop.

---

## Where to read more

- [`docs/ai-integration.md`](../ai-integration.md) — the five steps,
  provider adapters, the repair loop.
- [`docs/lessons/01-refund-workflow.md`](01-refund-workflow.md) — the
  full approval + grounding flow (Level 3).
- [`docs/mcp.md §3.1`](../mcp.md) — why approval over MCP is limited in
  0.1.0.
- [`openrouter.ai/docs`](https://openrouter.ai/docs) — OpenRouter's own
  docs: model catalog, tool calling, structured outputs .

  [← return to index](lessons/index.md)

```
