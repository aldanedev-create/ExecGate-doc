# Getting Started with Logiq

Logiq is a verification boundary between an AI's proposed action and the trusted Python function that executes it. The model emits a JSON plan; Logiq validates it against your registered capabilities, schemas, policies, references, and live state. Only plans that pass reach a handler.

This path takes you from "I just heard about Logiq" to "I have an AI proposing actions that run through Logiq's pipeline."

**Estimated time: 15 minutes.**

---

## Who This Is For

A Python developer who:

- Has a function or service that could be called by an AI.
- Is currently calling that function directly from model output.
- Wants the model's proposal to go through a verification boundary before it runs.

If you don't have an AI and just want a schema-enforcing dispatcher, Level 1 below is still useful — and `getting-started/02-first-capability.md` covers it.

If you've already integrated Logiq and want deeper coverage, jump to `docs/lessons/`.

---

## The Path

Five files, in order. Each builds on the previous one.

| File | What You'll Do |
|---|---|
| [`01-install.md`](01-install.md) | Install Logiq and verify that it imports |
| [`02-first-capability.md`](02-first-capability.md) | Register a Python function, inspect its schema, and watch it reject bad input |
| [`03-first-plan.md`](03-first-plan.md) | Run a single-call plan, then a multi-step plan with references |
| [`04-with-an-ai.md`](04-with-an-ai.md) | Send the catalog to a model and run its proposal through Logiq |
| [`05-what-now.md`](05-what-now.md) | Choose the next path for your use case |

Read them in order. Each file assumes the previous one worked.

---

## What You'll Have at the End

- A **working example** where an AI proposes a JSON plan and it runs through Logiq's verification pipeline.
- The **core mental model**: developer declares, AI proposes, Logiq verifies, handler executes.
- A **starting point** for the two paths that follow:
  - **Production agent** — ground, authorize, and approve. See `docs/lessons/01-refund-workflow.md`.
  - **MCP integration** — expose or proxy capabilities. See `docs/mcp.md`.

You will **not** have a production-ready application. That's what `docs/production-guide.md` is for. This path is about understanding the boundary, not hardening it.

---

## The Three Levels

Logiq is designed so that a simple integration stays simple, while production capabilities are available when you need them.

### Level 1 — Logiq as a Dispatcher

```python
result = logix.run({
    "call": "add",
    "with": {"a": 1, "b": 2},
})
```

No AI is involved. Logiq is a schema-enforcing dispatcher. This is useful on its own — in scripts, tests, CLI tools, and webhook handlers.

**Reached at:** `getting-started/02-first-capability.md`.

### Level 2 — Logiq With an AI

```python
catalog = logix.tools.format("openai")
plan = adapter.parse_proposal(ai_response)
result = logix.run(plan, context=ctx)
```

The AI proposes, Logiq verifies, and your handler runs. This is what most applications need.

**Reached at:** `getting-started/04-with-an-ai.md`.

### Level 3 — Logiq in Production

```python
report = logix.verify(plan, context=ctx)
approval = ask_human(report.verified_plan)

result = logix.execute(
    report.verified_plan,
    context=ctx,
    approval=approval,
)
```

Full control: separate verification from execution, insert human approval gates, attach live-state invariants, and bound retries.

**Reached at:** `docs/lessons/01-refund-workflow.md`.

---

## The One Guarantee

Everything else in the documentation builds on this:

> **A plan that fails Logiq's required verification checks does not reach normal handler execution.**

That is what "verification boundary" means. It covers mechanical failures — invented capabilities, wrong argument types, malformed plans, dangling references, static policy rejections, missing approvals, and live-state rejections. Each is backed by a test in `tests/security/`.

It does **not** mean:

- The model's claims are true.
- A permitted action is harmless.
- A verified handler produces correct results.
- External services behave as expected.

Those are your application's responsibility. Logiq shrinks the surface where a model's mistake can become an action; it does not prove that every permitted action is correct.

This precision is intentional. "Eliminates hallucinations" is untestable; "a plan that fails verification cannot reach a handler" is not.

---

## Prerequisites

- **Python 3.11 or later**
- `pip` (any recent version)
- **An editor and a terminal**

You do **not** need:

- An AI provider account (until file 04).
- An API key (until file 04).
- Pydantic, FastMCP, or any third-party package (until you opt into an extra).

The core installs with **zero third-party runtime dependencies**.

---

## Conventions

Throughout this path:

- Commands starting with `$` are shell commands.
- Code blocks are Python unless stated otherwise.
- `logiq` (lowercase) is the package name.
- `Logix` (capital L) is the class.
- `logix` (lowercase, used as a variable) is the engine instance you create: `logix = Logix()`.

For example:

```python
from logiq import Logix  # Package: logiq; class: Logix

logix = Logix()          # Variable: logix
```

You'll see all three spellings in the same code block. That's correct.

---

## What You're Building Toward

A small application that:

1. Exposes a set of trusted Python functions as capabilities.
2. Publishes a JSON Schema catalog for an AI.
3. Accepts the AI's proposal as JSON.
4. Verifies it — schema, references, and live state.
5. Executes it — the handler runs and its output is validated.

The rest of `docs/` covers how to harden each step. The lessons cover how to build real applications with Logiq.

When you're ready, continue to [`01-install.md`](01-install.md).
