
# Lessons

Build-along tutorials. Each lesson is a complete application you write by
following the steps, ending with working code you can copy, paste, and
run.

These are not reference docs. For "what does `logix.authorize` do?", see
`docs/api-reference.md`. For "how do I deploy this?", see
`docs/production-guide.md`. These are for "I want to build X, and I'll
learn Logiq by doing it."

---

## What "worked through" means

Every lesson:

- **Starts from zero.** Fresh file. `from logiq import Logix` at the top.
- **Builds in visible steps.** Each step adds one concept. You see the
  code grow.
- **Shows the output.** After each step, the exact expected output is
  shown.
- **Ends with a complete working file.** The full code, ready to copy.
  A `tests/` file proves it works.
- **Suggests variations.** After the code works, "What to try next"
  gives you small experiments to deepen understanding.

If a lesson step doesn't match the output shown, that's a documentation
bug. File it.

---

## The six lessons

| # | Lesson | What you build | Concepts | Time |
|---|---|---|---|---|
| 01 | [Refund Workflow](01-refund-workflow.md) | A refund application with grounding, live-state authorization, human approval, and audit | `grounding`, `authorize`, `require_approval`, `issue`, `audit` | ~40 min |
| 02 | [Multi-Tenant](02-multi-tenant.md) | One application serving multiple tenants with isolated engines and per-tenant policies | `ExecutionContext(tenant=...)`, per-engine state, `authorize` for tenancy | ~30 min |
| 03 | [Custom Adapter](03-custom-adapter.md) | A provider adapter for a fictional AI SDK, passing the conformance kit | `ProviderAdapter`, `AdapterContractMixin`, `tools.format(provider)` | ~30 min |
| 04 | [MCP Proxy](04-mcp-proxy.md) | A verified proxy in front of an untrusted MCP server | `LogixMCPProxy`, `startup()`, `FakeMCPClient`, `authorize` on wrapped tools | ~35 min |
| 05 | [Pydantic Models](05-pydantic-models.md) | A capabilities file built from existing Pydantic domain models | `PydanticType`, `HandlerMode`, `$ref` into model outputs | ~30 min |
| 06 | [AI Integration](06-ai-integration.md) | A working agent loop where a real model (via OpenRouter) proposes plans, Logiq verifies, errors feed back for bounded repair | The five-step loop, multi-turn tool calls, `RepairLoop`, the grounding trap | ~45 min |

Read them in the order that fits your situation. Lesson 01 is the
recommended starting point — it exercises the whole semantic layer in
one coherent application. The others each focus on one specific
integration.

---

## Two paths through the lessons

There are two natural orderings depending on what you're building.

### Path 1 — "I want to build a production agent"

You have an AI proposing actions. You need live authorization,
approval, and the ability to swap providers.

1. **Lesson 01 — Refund Workflow.** The semantic layer end to end.
2. **Lesson 06 — AI Integration.** The agent loop with a real model.
3. **Lesson 02 — Multi-Tenant.** If your agent serves multiple customers.

### Path 2 — "I want to expose or proxy capabilities over MCP"

You're integrating with Claude Desktop, Cursor, or an untrusted upstream.

1. **Lesson 04 — MCP Proxy.** The verification layer in front of an
   untrusted upstream.
2. **Lesson 02 — Multi-Tenant.** If each MCP client is a different
   tenant.
3. **Lesson 01 — Refund Workflow.** If the capabilities have side
   effects that need approval.

### The two "adjacent" lessons

**Lesson 03 — Custom Adapter** and **Lesson 05 — Pydantic Models** are
independent of the paths above. Read them when the situation calls for
them:

- **Lesson 03** if your AI provider isn't OpenAI/Anthropic/Gemini/local,
  or if you want to understand how `logix_ai` works under the hood.
- **Lesson 05** if you already have Pydantic domain models and want them
  as capability schemas without re-declaring constraints.

Neither is required to build a working application. Both deepen the
model.

---

## Prerequisites

Before any lesson:

- Python 3.11+ installed.
- `pip install logiq` completed.
- The `docs/getting-started/` path read (about 15 minutes).

The lessons assume you know:

- How `@logix.capability` works (`getting-started/02-first-capability.md`).
- How `logix.run(plan)` works (`getting-started/02-first-capability.md`).
- How `$ref` in multi-step plans works (`getting-started/03-first-plan.md`).
- How `logix.tools.format(...)` works (`getting-started/04-with-an-ai.md`).

**Only Lesson 06 requires an API key.** It uses OpenRouter
(`OPENROUTER_API_KEY`), which gives access to OpenAI, Anthropic, Google,
and open-weight models through one endpoint — including free models.
The other five lessons are entirely self-contained.

---

## Working directory

Each lesson creates its own directory. Pick a workspace:

```bash
mkdir logiq-lessons && cd logiq-lessons
```

Then for each lesson, create a directory:

```bash
mkdir 01-refund && cd 01-refund
```

You'll copy code into files as you go. Nothing is installed beyond
`logiq` (plus the extras a specific lesson names — Pydantic for Lesson
05, FastMCP for Lesson 04, `openai` and `logiq_ai` for Lesson 06).

---

## What each lesson proves

Each lesson ends with a `test_*.py` file. The tests aren't decoration —
they're the proof that the lesson works. If a test fails on your
checkout, something is wrong (in the code or in the environment).

| Lesson | Tests | What they prove |
|---|---|---|
| 01 | 6 | Grounding, ownership, delivery state, approval binding, "approval does not bypass authorization" |
| 02 | 6 | Engine isolation, per-tenant invariants, cross-engine `VerifiedPlan` rejection |
| 03 | 10 | Adapter conformance: format, parse, error handling, no trust-boundary attributes |
| 04 | 5 | Unknown-tool rejection, schema rejection, policy forwarding, startup failure on unsupported schemas |
| 05 | 8 | Pydantic validation, `$ref` into model output, `list[Model]` limitation, `HandlerMode` |
| 06 | not shipped — see below | The lesson ends with a working `chat_turn()` you can exercise interactively |

**Lesson 06 does not ship a test file.** Testing a real model call is
brittle — the model can respond differently each run, and the lesson
would fail in CI without an API key. Instead, the lesson ends with
runnable code you exercise manually:

```bash
python agent.py
```

That code sends real requests, gets real plans, runs them through real
Logiq. If you want to see the boundary working with a fixture model, use
Lesson 01's hand-written plans (which are exactly the same shape).

---

## Conventions

Same as `docs/getting-started/`:

- **`logiq`** (lowercase) is the package.
- **`Logix`** (capital L) is the class.
- **`logix`** (lowercase) as a variable is your engine instance.
- Shell commands start with `$`.
- Code blocks are Python unless stated otherwise.

One more, specific to the AI lessons:

- **`adapter`** (lowercase) is the `ProviderAdapter` instance from
  `logiq_ai.get_adapter(...)`. It shapes the catalog for the model and
  parses the model's response back into a neutral plan.

---

## After the lessons

Where to go once you've built the lessons that fit your situation:

- **Production deployment** — `docs/production-guide.md`.
- **MCP integration reference** — `docs/mcp.md`.
- **Writing a real adapter** — `docs/writing-an-adapter.md`.
- **The threat model** — `docs/security.md`.
- **Every API** — `docs/api-reference.md`.
- **The design rationale** — `docs/adr/`.

If you've worked through Lessons 01 and 06, you've exercised the whole
pipeline: catalog → model proposal → parse → verify → recheck → execute
→ feed result back. That's the loop. Every other lesson expands one
aspect of it.

If you've worked through all six, you've exercised every major feature
of Logiq. The reference docs will make a lot more sense now.
```

---
