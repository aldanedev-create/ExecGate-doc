# ADR-0005: Grounding via `$ref`-Required Policy

**Status:** Accepted  
**Date:** 2026-10-25  
**Supersedes:** —  
**Related:** ADR-0003, `docs/plan-format.md` §4, `docs/semantic-layer.md`

---

## Context

Schema validation ensures an argument is the right *type*. It does not ensure the argument is the right *value*. This is a well-known gap in every schema-based validator, and it is a real problem for AI-driven applications:

- A model says `{"amount": 50.0}`. Schema-valid. But 50.0 was hallucinated; the actual refundable amount is 30.0.
- A model says `{"order_id": 502}`. Schema-valid. But 502 belongs to another customer.
- A model says `{"tracking_id": "1Z999AA10123456784"}`. Schema-valid. The tracking number is fabricated.

The naive framing is: "Schema validation doesn't catch this." That is true, but incomplete. The correct framing is: **the model is asserting a fact (this is the amount, this is the order, this is the tracking number) that it has no way to know.** It has not read the order. It has not called the shipping API. It is typing a plausible value.

Grounding is the discipline of forcing the model to source such values from a validated prior step. A `$ref` to a prior step's output is a grounded value: it comes from a handler that fetched it. A literal is an ungrounded value: it comes from the model.

---

## Decision

**The application can declare, per capability per argument, that the argument must be `$ref`-sourced rather than literal.**

```python
logix.grounding(require_ref_for=["issue_refund.amount"])
```

With this policy, a plan whose `issue_refund.amount` argument is a literal (e.g., `50.0`) is rejected with `GROUNDING_REQUIRED`. The plan must instead supply a `$ref` to an earlier step's output:

```json
{
  "$ref": "o.remaining_refundable"
}
```

### 1. The policy is applied at verify time, before the verifier

Grounding is a static property of the plan — a literal is a literal, regardless of what it validates against. Checking it before the verifier produces a specific error message (`GROUNDING_REQUIRED: argument 'issue_refund.amount' must be sourced from a $ref`) rather than a generic schema failure.

### 2. `literal_allowlist` provides an escape hatch for known-safe literals

Some arguments are sensitive but may legitimately be user-supplied (a user-provided identifier, a value the application has already validated before constructing the plan). Those go on the allowlist:

```python
logix.grounding(
    require_ref_for=["issue_refund.amount"],
    literal_allowlist=["get_order.order_id"],  # user picks the order
)
```

### 3. The policy is capability-scoped, not global

The path is `"<capability>.<argument>"`. Different capabilities can have different grounding rules. A refund amount must be grounded; a search query is a legitimate literal. The rule follows the semantics of the argument, not a blanket policy.

### 4. The policy is optional

Applications that do not use grounding are unaffected. An application that wants to accept literal amounts (because the user is manually choosing a refund amount, for example) simply does not configure grounding for that capability.

### 5. The policy composes with invariants

Grounding says, "This value must come from a prior step." Invariants say, "This value must be permitted in the current state." Both are needed:

- Grounding prevents the model from inventing values.
- Invariants prevent grounded values from being acted on when the live state doesn't permit it.

An application might configure both:

```python
logix.grounding(require_ref_for=["issue_refund.amount"])
logix.authorize(issue_refund, check=refund_policy)
```

A plan must (a) source the amount from a prior step, and (b) that step's value must pass the invariant's live-state check.

---

## Consequences

### Positive

- The "hallucinated amount" attack is closed at the plan-shape level, before any handler runs. A model that tries to write `{"amount": 50.0}` is rejected with `GROUNDING_REQUIRED`.
- The rule is *structural*, not prompt-based. It does not rely on the model's good behavior or on a system prompt telling it "don't invent numbers." It is enforced in code.
- Combined with invariants, it forces the "fetch then act" pattern: the model must call `get_order` first, then `issue_refund` referencing its output. There is no path to "issue a refund without having read the order."
- The policy is fine-grained: per-argument, per-capability, with an allowlist override. Different capabilities can have different rules.

### Negative

- **The model must produce multi-step plans.** Grounding cannot be satisfied with a single-call plan (`{"call": "issue_refund", ...}`) — there is no earlier step to reference. The plan must be multi-step: one step fetches, the next references. This is a bigger plan-shape requirement than a schema check.
- **Requires MCP multi-step support.** A capability with grounding cannot be exposed via `LogixMCPServer` in 0.1.0 (which only exposes single-call plans). See `docs/mcp.md` §"What MCP clients do not see".
- **The rule is per-argument, not per-value.** If `get_order` returns `{"total": 50.0}` and the model wants to refund a partial amount (`50.0 * 0.5`), it cannot — the model cannot compute. The application must expose a capability that computes the partial refund, or accept the full amount as the only grounded option.
- **Grounding is not a substitute for authorization.** A grounded refund that exceeds the tenant's budget is still rejected by the invariant. Grounding and authorization are layers; both must be configured where they apply.

---

## Alternatives Considered

### Prompt engineering: "Always reference prior tool results"

Rejected. Prompts are advisory. A model can ignore them, especially under adversarial conditions or when a different model is used. Grounding enforced in code cannot be prompted around.

### Numeric ranges on the argument (`Le(1000)`)

Considered. A range check catches some hallucinated values, but not values within the range that don't correspond to reality. If the model writes `50.0` and the actual refundable amount is `30.0`, `Le(1000)` accepts `50.0`. Range checks are useful in their own right (they catch "obviously absurd" values); they are not a substitute for grounding.

### A whitelist of allowed values

Considered. Enumerating allowed values works for small, fixed sets (a country code, a status). For an open-ended value like a refund amount, the whitelist would need to be computed per-call from live state — at which point you have re-invented `$ref`.

### Always require `$ref` for every argument

Rejected. Some arguments legitimately come from the user or the application (a search query, a user ID). Requiring `$ref` for everything would force absurd plans ("fetch the query, then search for it"). Grounding is opt-in per-argument because the semantics are per-argument.

### A signed plan from the AI

Rejected. The AI cannot sign anything; signing would need a key held by the model. Not a meaningful security property.

### Trust the model's assertion that it "read" the value

Rejected. This is exactly what a hallucination looks like from the outside: a confident assertion that a value was retrieved when it wasn't.
