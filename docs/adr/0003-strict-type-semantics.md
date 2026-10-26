
---

# ADR-0003: Strict type semantics; reject rather than weaken

**Status:** Accepted
**Date:** 2026-10-25
**Supersedes:** —
**Related:** ADR-0001, ADR-0005, `docs/schemas.md`

---

## Context

Logiq validates plans before handlers run. The validator's job is to
prove, as strongly as it can, that a handler will receive values of the
types it declared. "As strongly as it can" turns out to require two
uncomfortable choices:

1. **Strict types.** Python's type system is more permissive than a
   validator wants. `bool` is a subclass of `int`. `int` is silently
   promoted to `float` in some contexts. `Decimal` and `float` are not
   interchangeable. `True == 1`.

2. **Rejection over weakening.** Any validation library that tries to
   be helpful will eventually accept what it doesn't understand — falling
   back to `Any`, coercing a string to an int, ignoring an unknown
   annotation. That is how a validator stops being a validator.

Both choices are correct for Logiq because the whole product exists to
make a *testable* claim: **a plan that fails verification does not reach
a handler.** If the schema engine could silently accept what it doesn't
understand, the claim would become "a plan that fails the checks we
happen to implement doesn't reach a handler" — a weaker, untestable
claim.

---

## Decision

**1. Strict type semantics, no coercion.**

- `IntType` rejects `bool`. `True` is not `1`.
- `FloatType` rejects `int`. `5` is not `5.0`.
- `LiteralType` checks the type of each value. `Literal[1]` does not
  accept `True`.
- `ObjectType` requires `additionalProperties: false` by default.
- `UnionType` passes if **any** member validates; it does not coerce to
  the first match.

**2. Reject rather than weaken.**

- `describe_unsupported(annotation)` returns a list of every unsupported
  annotation in a signature.
- `infer_input_schema` and `infer_output_schema` raise
  `SchemaInferenceError` if `describe_unsupported` is non-empty.
- `build_capability` aggregates every annotation problem into a single
  `TypeError` before constructing the `Capability`.
- `mcp_schema_to_logix` (in `logiq_mcp`) rejects unsupported JSON Schema
  keywords at proxy startup rather than downgrading to `AnyType`.

**3. Document what is unsupported.**

- `docs/schemas.md §3` lists every rejected annotation with a rationale.
- An unsupported annotation produces a specific message
  (`unsupported annotation: set`), not a generic one.

**4. Aggregate errors.**

- A signature with three unsupported annotations reports all three at
  once, not the first one.

---

## Consequences

**Positive:**

- The schema engine's guarantees are provable: a plan that passes
  validation is one the handler can safely assume conforms to its
  declared types.
- No silent fallbacks. Every acceptance is deliberate.
- The strictness is self-documenting: `IntType().validate(True)` returning
  an error *teaches* the developer that `True` is not an int in Logiq's
  world.
- Test suite has a small set of "expected rejection" cases rather than a
  sprawling "coercion matrix."

**Negative:**

- **Every capability author meets the strictness.** A handler declared
  `def f(x: float)` will reject `{"x": 5}`. The author must either
  change the signature to `int | float` (which becomes `NumberType` via
  `UnionType`) or change the caller to send `5.0`. There is a moment of
  friction where they learn the rule.
- **`Annotated` is the only place to express constraints.** Constraints
  beyond what a type expresses must be declared explicitly. This is
  verbose compared to Pydantic's `Field(ge=0)` but consistent.
- **Cross-language integration is stricter.** A JSON plan coming from a
  JavaScript client with `{"x": 5}` for a `float` arg fails. `NumberType`
  is available via `Union[int, float]` for cases where both are
  acceptable, but it is opt-in.
- **No `Any` from inference.** `typing.Any` in a signature is rejected,
  not treated as "accept anything." If a developer needs an opaque
  payload, they must be explicit — for example, `dict[str, str]` with
  application-level serialization.

---

## Alternatives considered

**Accept `bool` where `int` is declared, matching Python's runtime
semantics.** Rejected. `{"x": true}` arriving at a handler that does
arithmetic on `x` produces `1 + ...` which is not obviously wrong until
it is. The cost of strictness is a clear error message; the cost of
permissiveness is a silent bug three layers deep.

**Coerce `int` to `float` when the destination declares `float`.**
Rejected. Logiq is a verification boundary, not a coercion layer. Silent
coercion means the schema a handler declares and the values it actually
receives can differ, which is exactly the property that makes schema
validation useful.

**Fall back to `Any` for unsupported annotations.** Rejected. This is
the pattern that produces validators that "work" until they don't. A
validator that accepts what it does not understand provides no
guarantee; the plan looks validated and isn't.

**Emit a warning for unsupported annotations, accept anyway.**
Rejected. Warnings in a validation library are how bugs get shipped.

**Aggregate errors into a single message vs. raise on first.** Rejected.
The developer fixes one thing at a time; aggregating saves time. Also,
`find_unsupported_annotations` returns a list of individual problems
which is useful for tooling (e.g., IDE integration).