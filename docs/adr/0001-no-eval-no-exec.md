
---

## `docs/adr/0001-no-eval-no-exec.md`

```markdown
# ADR-0001: Never evaluate model-supplied data as code

**Status:** Accepted
**Date:** 2026-10-25
**Supersedes:** —
**Related:** ADR-0003 (strict types), `docs/security.md` §1

---

## Context

A library that sits between an AI's proposal and a trusted handler has
one overriding temptation: treat the proposal as code. "The model said
`add(1, 2)` — let me call `add(1, 2)`." "The model sent a tool call —
let me dispatch it by name."

Both of those are ways to execute untrusted input. A sufficiently
motivated model can produce:

- a capability name that looks like a Python attribute
  (`__class__`, `__dict__`, `__globals__`),
- a string argument containing shell syntax,
- a plan that names `eval` or `__import__` as the capability,
- a `$ref` that resolves to an internal object attribute.

Every one of those must be inert data. None may become executable.

---

## Decision

**Logiq never `eval`s, `exec`s, or `__import__`s model-supplied data.**

Concretely:

1. **The plan is JSON.** It is parsed with `json.loads`. Its fields are
   accessed by dict lookup. There is no attribute dispatch on
   model-supplied names, no function call by string name, no expression
   parsing.

2. **Capability dispatch is a registry lookup.** `verifier._resolve_capability`
   calls `registry.get(step.capability)`. A name that is not registered
   raises `KeyError`, which becomes `UNKNOWN_CAPABILITY`. Python's
   attribute machinery is never consulted.

3. **String arguments are data.** A handler that takes a `str` gets the
   string as-is. If the handler passes it to a subprocess, the handler
   is responsible for `shell=False` and list-args — Logiq does not
   sanitize string contents. But Logiq also does not interpret them.

4. **`$ref` is data.** The grammar is parsed by `references.parse_reference`,
   which uses a small regex and a dotted-path splitter. `$ref` values
   are never passed to `getattr`, `eval`, or any expression evaluator.

5. **`default=str` in `json.dumps` is a serialization concern, not
   evaluation.** It converts non-JSON objects to strings for size
   estimation. It does not execute anything. A raising `__str__` is
   caught by the parser (see ADR-0002-adjacent hardening in
   `plans/parse.py`).

6. **The one exception is documented.** `schemas/infer.py::_resolve`
   evaluates *string annotations* using `eval` against an
   application-controlled namespace, at *registration* time. It is not
   on the plan-execution path. It is documented in
   `tests/security/test_no_eval_exec.py` and excluded from the AST scan.

---

## Consequences

**Positive:**

- The AST scan in `tests/security/test_no_eval_exec.py` is enforceable
  and reproducible.
- The property is testable with hostile-looking inputs.
- No category of "RCE via plan" exists.

**Negative:**

- **No dynamic capability naming.** A model cannot call `get_user_42` if
  the registry only has `get_user`. A capability that wants parameterized
  behavior must take parameters, not encode them in the name. This is
  correct but constraining.
- **No dynamic plan expansion.** A handler cannot return a "sub-plan" for
  the model to execute next. If that's needed, the model proposes a
  two-step plan up front, or the app runs a fresh `logix.run(...)`.
- **No expression language.** `$ref` can navigate, but not compute. If a
  plan needs to compute `amount * quantity`, the application must
  expose a capability that does the arithmetic.

These constraints are the point. Anything that would let the model
compute is a channel for the model to program. Logiq is a verification
boundary, not a runtime.

---

## Alternatives considered

**Sandboxed `eval` with a restricted `__builtins__`.** Rejected. Every
sandboxed evaluator is one bug away from a bypass. Logiq should not
carry that bug surface.

**Attribute dispatch with an allowlist.** Rejected. Even with an
allowlist, an attacker who controls the name string controls which
capability is called. Registry lookup by exact string is strictly
narrower.

**`getattr` on a dynamically-created module.** Rejected. Same problem as
attribute dispatch.

**`ast.literal_eval` on plan strings.** Rejected. Only works for
literal expressions; a model can still produce string arguments that a
handler might mishandle. Not a source of safety; gives a false sense of
one.