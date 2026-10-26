# ADR-0002: Verified IR Is Immutable and Unforgeable

**Status:** Accepted  
**Date:** 2026-10-25  
**Supersedes:** None  
**Related:** ADR-0001, ADR-0004, `docs/system-design.md` §11

---

## Context

The executor accepts a `VerifiedPlan` and runs the handlers it names.

The security guarantee that an unverified plan cannot reach a handler depends on one rule:

**The executor accepts only `VerifiedPlan` objects produced through the verification process.**

If `execute()` accepted a plain dictionary, a caller could attempt to bypass verification:

```python
# This must never be accepted as a verified plan.
logix.execute({
    "call": "delete_all_users",
    "with": {},
    "verified": True,
})
```

The `"verified": True` marker proves nothing. Any model or caller could add it.

The executor needs a structural check, not a conventional marker. A verified plan must be a distinct Python type, not merely a dictionary that looks verified.

## Decision

`VerifiedPlan` is immutable, has no public constructor, and is created through a private construction function used by the verifier.

The implementation follows these rules:

1. **No public constructor.** `VerifiedPlan` uses `@dataclass(frozen=True, init=False)`. Calling `VerifiedPlan(...)` raises `TypeError`.

2. **Private construction.** The module-private `_construct_verified_plan(...)` function creates the object using `object.__new__` and initializes its fields with `object.__setattr__`. It is not exported and is called by `verifier.verify_plan`.

3. **Executor type check.** `execute_verified()` rejects anything that is not a `VerifiedPlan`:

   ```python
   if not isinstance(verified_plan, VerifiedPlan):
       raise TypeError(
           "execute() accepts only a VerifiedPlan produced by verify(); "
           f"got {type(verified_plan).__name__}"
       )
   ```

4. **Immutable fields.** Once constructed, a `VerifiedPlan` cannot be modified through normal attribute assignment. Its `steps` collection is a tuple, and each `VerifiedStep.arguments` mapping is a `MappingProxyType`. Attempts to mutate these structures raise `FrozenInstanceError` or `TypeError`.

5. **Content verification hash.** `verification_hash` is a SHA-256 digest of the canonical plan, dependency order, and capability snapshot hash. Identical inputs produce the same hash; changes to the hashed content produce a different hash.

6. **Registry snapshot.** The verifier records `Registry.snapshot_hash()` in the plan. Before execution, the executor compares that snapshot with the current registry. If the registry has changed, execution returns `POLICY_REJECTED` and the plan must be verified again.

7. **Required `single_call` field.** The private constructor requires `single_call` explicitly. Omitting it raises `TypeError` rather than silently producing a plan with the wrong result shape.

## Consequences

### Positive

- **Structural enforcement:** A plain dictionary cannot pass the `isinstance(x, VerifiedPlan)` check.
- **One verification path:** The executor requires a verified representation rather than relying on callers to remember to verify the plan.
- **Tamper detection:** The verification hash binds the plan content, dependency order, and registry snapshot.
- **Explicit testing:** Tests can use `_construct_verified_plan` when necessary, although calling `logix.verify(plan)` is preferable.

### Negative

- **More work for tests:** Tests must use `_construct_verified_plan` or, preferably, `logix.verify(plan)`. This friction is intentional.
- **Serialized plans require verification again:** `verified_plan.serialize()` produces a dictionary for auditing, but that dictionary cannot be passed directly to `execute()`. The application must verify the serialized plan again before execution.
- **No default pickling support:** A `VerifiedPlan` cannot be assumed to be safely transferable between processes through pickle. If durable or cross-process execution is added, a signed serialization format may be needed. This is outside the scope of version 0.1.0.

## Alternatives Considered

### A `verified: bool` marker

**Rejected.** Any caller or model could set the marker. It does not establish that verification occurred.

### A `type` field

For example:

```json
{
  "type": "VerifiedPlan"
}
```

**Rejected.** A caller could add or modify this field just as easily.

### A signed dictionary

**Rejected for version 0.1.0.** Signatures can provide a legitimate verification mechanism, but require key management, key rotation, and a trust anchor. These requirements are outside the scope of a library designed to work without additional setup.

The `VerifiedPlan` type provides a zero-setup structural boundary, although it is not a cryptographic security boundary against arbitrary code already running inside the Python process.

### A `__verify__` method called by handlers

**Rejected.** This approach puts the responsibility on handler authors, who could forget to verify before performing side effects. Requiring a `VerifiedPlan` at the executor boundary centralizes the check.

### A public `VerifiedPlan(...)` constructor with an internal hash check

**Rejected.** If arbitrary callers could construct `VerifiedPlan` objects, they could attempt to supply fabricated content or hashes. A private construction path makes the intended verification flow explicit.

---

**Implementation note:** Python privacy is conventional, not absolute. A module-private constructor and `isinstance` check prevent accidental or ordinary API-level bypasses, but they cannot stop malicious code with unrestricted access to the Python process from deliberately manipulating internal objects. The executor must continue to perform its runtime checks.