
# Usage Model: Developer, AI, and the Boundary

Who does what. This is the contract the implementation preserves. If a
feature lets the AI do something listed as "developer owns" below, that
feature is wrong.

For the pipeline stages, see `system-design.md`. For the API surface,
see `api-reference.md`. This document is about *roles*.

---

## 1. The three parties

| Party | Owns | Trust |
|---|---|---|
| **Developer** | capabilities, schemas, policies, approvals, provider choice | trusted |
| **AI** | which capability, which args, what order | untrusted data |
| **ExecGate** | the boundary between them | trusted, deterministic |

The developer never hands the AI a function reference or a `ExecGate`
handle. The AI never receives `execute()`, the registry, or handler
source. The *application* sits between them and only ever passes the
AI's raw proposal to ExecGate.

The three-party split is the whole point. A library that lets the AI
call handlers directly is a tool-calling framework. A library that lets
the developer call handlers through a verified boundary is ExecGate.

---

## 2. What the developer does

The developer's work has five steps. Most applications stop at step 3.

### Step 1 — Create a runtime and register capabilities

```python
from execgate import Logix

logix = Logix()

@logix.capability
def get_order(order_id: int) -> dict[str, int]:
    "Retrieve an order by its ID."
    return db.orders.get(order_id)

@logix.capability(effects="write")
def issue_refund(order_id: int, amount: float) -> dict[str, int]:
    "Issue a refund for an order."
    return payments.refund(order_id, amount)
```

The developer writes ordinary Python. The decorator:

- Infers the input schema from annotations.
- Infers the output schema from the return annotation.
- Extracts the description from the docstring.
- Registers the capability in the engine's registry.
- Returns the original function (still callable for unit tests).

Registration fails at import time if any annotation is unsupported.
That's the point — silent weakening is worse than a loud error.

### Step 2 — Declare policies

Live-state authorization:

```python
from execgate import Allow, Deny

def refund_policy(args, ctx):
    order = db.orders.get(args["order_id"])
    if order["owner"] != ctx.principal:
        return Deny("NOT_OWNER", "caller does not own this order")
    if order["state"] != "delivered":
        return Deny("NOT_DELIVERED", "order is still in transit")
    return Allow()

logix.authorize(issue_refund, check=refund_policy)
```

Approval:

```python
logix.require_approval(issue_refund)
```

Grounding:

```python
logix.grounding(require_ref_for=["issue_refund.amount"])
```

Each policy is a small, composable piece. The developer declares what is
permitted; ExecGate enforces it at execute time.

### Step 3 — Get the catalog for the AI

```python
catalog = logix.tools.format("json")   # or "openai", "anthropic", "gemini", "local"
```

The catalog is what the AI sees. It contains:

- Capability names.
- Descriptions.
- Input schemas (JSON Schema).
- Output schemas.
- `effects` (`read` / `write`).
- `approval` (`required` / `principal_bound` / `null`).

It does **not** contain:

- The Python function.
- The database credentials.
- The application's internal state.
- The policy code.
- The handler's source.

### Step 4 — Send the catalog and receive a proposal

The developer's application owns the AI call:

```python
from execgate_ai import get_adapter

adapter = get_adapter("openai")

response = openai_client.chat.completions.create(
    model="gpt-4o",
    messages=messages,
    tools=adapter.format_tools(logix.tools.describe()),
)

plan = adapter.parse_proposal(response)
```

The AI's response, after the adapter extracts the tool call, is a
plain dict — a *plan*:

```json
{"call": "get_order", "with": {"order_id": 502}}
```

or, for multi-step:

```json
{"version": "1", "steps": [
  {"id": "o", "call": "get_order", "with": {"order_id": 502}},
  {"id": "r", "call": "issue_refund",
   "with": {"order_id": {"$ref": "o.id"},
            "amount": {"$ref": "o.total"}}}
]}
```

This is the only data the AI produces. It is untrusted. It goes through
the full pipeline.

### Step 5 — Own the application loop

The developer writes the loop that:

- Sends the catalog to the AI.
- Receives a proposal.
- Runs it through ExecGate.
- Returns the result to the AI.
- Handles failures.
- Inserts approval gates (optionally).

```python
def handle(user_msg, principal):
    ctx = logix.context(principal=principal)
    catalog = logix.tools.format("openai")

    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": user_msg}],
        tools=catalog,
    )
    plan = adapter.parse_proposal(response)
    result = logix.run(plan, context=ctx)

    if result.ok:
        return format_success(result.value)
    return format_errors(result.errors)
```

ExecGate does not own this loop. The application owns the model call, the
conversation state, the retry policy, and the user-facing output. ExecGate
owns the boundary the plan crosses.

---

## 3. What the AI does

The AI does exactly three things.

### 1. Read the catalog

The AI receives the catalog (JSON Schema). It learns:

- Which capabilities exist.
- What arguments each accepts.
- What shape each returns.
- Whether an operation is `read` or `write`.
- Whether approval is required.

It does **not** learn how anything is implemented. It does not learn
which database, which external service, or which internal object the
handler uses.

### 2. Propose a plan

The AI produces JSON. Nothing else. The JSON describes what it wants to
do:

- For a single action: `{"call": name, "with": {args}}`.
- For a multi-step plan: `{"version": "1", "steps": [...]}` with `$ref`
  for dependencies.

The AI's output never includes:

- A verification result.
- An approval token.
- A reference to the handler.
- A reference to the registry.
- A reference to `ExecGate` itself.

If a model tries to include those, the parser rejects them as unknown
top-level fields. The AI cannot bypass the boundary by asserting the
boundary was crossed.

### 3. Interpret the structured result

ExecGate returns a `Result`:

```json
{"ok": true, "value": {...}}
```

or

```json
{"ok": false, "errors": [
  {"code": "POLICY_REJECTED", "message": "caller does not own this order",
   "path": "with.order_id"}
]}
```

The AI uses this to:

- Answer the user on success.
- Propose a corrected plan on failure — which goes through verification
  again.
- Explain the failure to the user.

The AI never sees:

- The exception stack trace.
- The handler's raw return value if it fails output validation.
- The raw arguments if the plan was rejected pre-execution.
- The approval token.
- The `ExecutionContext`.

It sees only the safe, structured serialization.

---

## 4. The interaction, end to end

Here is a refund request that crosses all layers:

```
User: "Refund $50 on order 502."

  App ──[catalog]──► AI
  AI  ──[proposal JSON]──► App            (untrusted)

  App ──► logix.run(proposal, context=alice)

          parse      → valid multi-step
          grounding  → amount is a $ref (o.total); ok
          verify     → schemas ok, refs type-check, deps computed
          → VerifiedPlan

          execute:
            step o: get_order(502) → {"id": 502, "total": 50.0}
            step r (recheck window):
              invariants → refund_policy({"order_id": 502, "amount": 50.0}, alice)
                           → Allow
              approval   → token? (see below)
              idempotency → not configured for issue_refund
              → PROCEED
            step r: issue_refund(502, 50.0) → {"refunded": true}
          → Result.success({"o": {...}, "r": {...}})

  App ──[result]──► AI
  AI  ──► User: "Done — $50 refunded on order 502."
```

If the plan was rejected at any point, the flow stops:

```
          parse      → INVALID_PLAN (if malformed)
          grounding  → GROUNDING_REQUIRED (if amount is a literal)
          verify     → UNKNOWN_CAPABILITY / SCHEMA_VALIDATION_FAILED /
                       INVALID_REFERENCE / DEPENDENCY_CYCLE
          → Result.failure(errors)

  App ──[errors]──► AI
  AI  ──► User: "I couldn't do that — <explanation based on error codes>."
```

Or if the recheck window denies:

```
          recheck    → POLICY_REJECTED (invariant denied)
          → Result.failure(errors)
```

In every failure case, the handler was either not invoked (parse,
verify, grounding) or was invoked after the specific recheck passed
(recheck, execute). The `Result.trace` shows which steps ran and which
failed.

### With an approval gate

For `requires_approval=True` capabilities, the application can insert a
human decision between verification and execution:

```
  App ──► logix.verify(plan, context=alice)
          → VerificationReport.ok, verified_plan

  App ──► ask_human("Approve refund of $50 on order 502?")
          → true (human approves)

  App ──► logix.approval.issue(capability="issue_refund",
                                args={"order_id": 502, "amount": 50.0},
                                context=alice,
                                issuer="human:alice")
          → ApprovalToken

  App ──► logix.execute(verified_plan, context=alice, approval=token)
          → Result.success(...)
```

The AI has no path to `ask_human` or `issue`. The approval token is
constructed from application code, bound to the exact args and
principal. A model that proposes a $9999 refund after a $50 approval
gets `APPROVAL_REQUIRED` because the `args_hash` doesn't match.

---

## 5. What the developer may do, and what the AI may not

| Developer may | AI may **not** |
|---|---|
| Add and remove capabilities | Invent capability names |
| Change policies and approvals | Set an approval boolean |
| Read the catalog | Read handler code or internal state |
| Call `verify()` and `execute()` | Call `execute()` at all |
| Inspect `VerifiedPlan` | Construct or mutate a `VerifiedPlan` |
| Choose the AI provider | Bypass verification via a repair attempt |
| Read `ExecutionContext` | Supply or read the context |
| Attach audit hooks | Read the audit log |
| Add new capabilities after startup | Add capabilities by naming them in a plan |
| Change limits | Exceed the limits via plan size |

These are not restrictions imposed by convention. They are structural:

- The AI cannot call `execute()` because `execute()` is not on its
  output channel — it returns JSON, not function calls.
- The AI cannot invent capability names because the registry is exact.
- The AI cannot set approval because approval is a token, not a field.
- The AI cannot bypass verification because the executor accepts only a
  `VerifiedPlan`.

A feature that lets the AI do any of the right-column things would
break the model. If you ever find yourself adding one, the answer is
almost always "put the logic on the developer's side."

---

## 6. The AI's information boundary

Concretely, the AI sees and does not see:

| The AI sees | The AI does not see |
|---|---|
| `logix.tools.format(...)` — JSON Schema catalog | The handler's source code |
| `Result.to_dict()` — safe serialization | The database / external services |
| `Error` codes and messages | The approval token |
| The capability's `description` field | The `ExecutionContext` |
| `effects` and `approval` flags in the catalog | The policy code |
| Whatever the app chooses to send | The registry internals |
| | The `VerifiedPlan` |
| | The handler's raw return value (on failure) |
| | The exception stack trace |
| | The raw arguments (on rejection) |

The catalog is what an AI needs to propose actions. Everything else is
trust-side, and every one of those omissions is deliberate.

---

## 7. The five places where the developer inserts a decision

ExecGate's boundary is a pipeline. There are five points where the
developer can insert application-specific behavior:

| Point | Mechanism | What it does |
|---|---|---|
| Registration | `@logix.capability` | Adds a capability |
| Static policy | (not user-facing in 0.1.0) | Constrains the plan shape |
| Grounding | `logix.grounding(...)` | Requires `$ref` for sensitive args |
| Recheck — invariants | `logix.authorize(...)` | Live-state authorization |
| Recheck — approval | `logix.require_approval(...)` | Human approval required |
| Pre-execution (external) | `logix.verify()` + app gate | Human approval before `execute()` |

The first five are ExecGate concepts. The sixth is the application's choice
to split `verify()` and `execute()` for a human gate. ExecGate supports it
by providing both methods, but it does not implement the human gate —
that's the application's job.

---

## 8. The three levels of complexity

ExecGate offers three levels of use. Each adds controls without changing
the core programming model.

### Level 1 — no AI yet

```python
logix = Logix()

@logix.capability
def add(a: int, b: int) -> int:
    return a + b

result = logix.run({"call": "add", "with": {"a": 1, "b": 2}})
```

ExecGate is a schema-enforcing dispatcher. Useful on its own for scripts,
CLI tools, and webhook handlers. No AI involved.

### Level 2 — AI tool-calling

```python
catalog = logix.tools.format("openai")
response = ai_client.chat(...tools=catalog...)
plan = adapter.parse_proposal(response)
result = logix.run(plan)
```

The common case. The AI proposes, the application runs the plan through
ExecGate.

### Level 3 — production agent

```python
report = logix.verify(plan, context=ctx)
if not report.ok:
    return handle_errors(report.errors)

# Application-specific gate — the AI has no path here.
approval = ask_human(report.verified_plan)

result = logix.execute(report.verified_plan, context=ctx, approval=approval)
```

Full control. Human approval gates, live-state invariants, grounding
rules, bounded retry. The advanced API, for production agents.

The advanced API does not require rewriting the Level 1 or Level 2
code. The same `@logix.capability` functions, the same registry, the
same catalog. Level 3 adds control, not a different programming model.

---

## 9. The one-sentence summary

> The developer declares what is possible and what is permitted. The AI
> chooses what to attempt. ExecGate decides what actually happens.

The developer's job is capability and policy. The AI's job is intent.
ExecGate's job is the boundary between them — and that boundary never
trusts the AI's output, only verifies it.

---

## 10. What "the AI" means here

In this document, "the AI" is the model whose output becomes a plan. It
could be:

- A hosted model (OpenAI, Anthropic, Gemini).
- A local model (Ollama, llama.cpp, vLLM).
- A hand-written script.
- A human typing JSON into a REPL.
- Another service producing plan-shaped data.

The trust model is identical for all of them. The AI is *whatever
produces an untrusted plan*. ExecGate does not know or care which model
produced it.

This matters because it tells you when ExecGate is useful and when it
isn't. If the plan comes from a trusted source that constructs it
correctly, ExecGate is a schema-enforcing dispatcher (useful, but you don't
need the AI integration). If the plan could be malformed, adversarial,
or hallucinated, ExecGate is the boundary that makes the transition from
untrusted data to trusted execution safe.

---

## 11. Where to go next

- `docs/system-design.md` — the pipeline stages and the trust boundary.
- `docs/security.md` — the threat model and the test checklist.
- `docs/api-reference.md` — the API surface.
- `docs/semantic-layer.md` — grounding, invariants, approval, idempotency.
- `docs/mcp.md` — if the AI is an MCP client.
- `docs/ai-integration.md` — provider-neutral catalog and adapter model.
```

---
