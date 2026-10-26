# ADR-0004: Verification is not authorization; recheck at execute

**Status:** Accepted
**Date:** 2026-10-25
**Supersedes:** —
**Related:** ADR-0002, ADR-0005, `docs/system-design.md §4–§5`

---

## Context

The most natural shape for a verification library is "check once, run
once." `verify(plan)` returns a boolean; `run(plan)` returns a result.

That shape is unsafe for a plan that will *ever* be executed some time
after it was verified. Time passes between the two events:

- A user's session may expire.
- An order's state may change (delivered → refunded by someone else).
- A tenant's plan may be downgraded.
- An approval granted ten minutes ago may be revoked.
- A user's role may be removed.

If verification is the only check, the plan that was valid five minutes
ago is executed against a state where it is no longer valid. The
guarantee "a plan that fails verification does not reach a handler" is
true in the sense that verification was a check that ran; it is not
true in the sense that anything meaningful was verified.

That is exactly the failure mode Logiq is designed to prevent.

---

## Decision

**1. `verify()` returns a `VerifiedPlan`, not an authorization grant.**

The `VerifiedPlan` proves: the plan is structurally valid, statically
permitted, and its references type-check against the schemas at verify
time. It does not prove anything about live state.

`VerifiedPlan` has no field named `authorized` or `permitted`. The type
name says "verified" — the past-tense state of having been checked. The
docs never call a `VerifiedPlan` "authorized."

**2. `execute()` re-runs every dynamic check.**

Before the handler is invoked for each step, `execute()` runs the
**recheck window** (see `docs/system-design.md §5`):

- Refresh context if a refresher is supplied.
- Run live invariants (`authorize(check=...)`).
- Validate the approval token against the current args and context.
- Check idempotency against the current store state.

Only if all pass is the handler invoked.

**3. `run()` is `verify()` + `execute()` with no gap; still safe.**

`run()` is the convenience API. It calls `verify()` then `execute()`
immediately. The recheck window runs identically, so a plan that would
fail the recheck at execute time fails just as it would have if the two
were called separately.

The gap only exists when the application *chooses* to insert one — e.g.,
for a human approval step. Even then, `execute()` re-verifies.

**4. The snapshot hash detects registry changes.**

`verify()` records `registry.snapshot_hash()` in the `VerifiedPlan`.
`execute()` compares it against the current hash. If they differ (a
capability was registered or unregistered between verify and execute),
the plan is rejected with `POLICY_REJECTED` and must be re-verified.
This is a coarse check (add/remove invalidates all plans; changes to a
capability's contract invalidate all plans for that capability) but it
is what catches the most common live-state drift.

**5. The `run()` result is what the application returns to the AI.**

A `Result` includes `trace`, which shows which steps ran and which
failed. The application can feed the trace back to the AI for a repair
attempt — but the repair plan goes through `verify()` again.

---

## Consequences

**Positive:**

- The guarantee is honest. A "verified" plan that is executed five
  minutes later is not run on stale state; it is checked against current
  state.
- Applications can safely separate planning from execution — human
  approval gates, batch workflows, two-phase commits are all supported
  without weakening the guarantee.
- Registry changes invalidate outstanding plans; a "verified" plan from
  before a capability's contract changed does not run under the new
  contract.

**Negative:**

- **Handler invocation is more expensive.** Each step incurs the cost of
  the recheck window. In practice this is microseconds; the live-state
  reads inside invariants are the same reads the handler would do
  anyway.
- **`VerifiedPlan` is not a durable artifact.** It cannot be stored and
  replayed hours later. Every execution re-verifies. This is correct
  but means the application cannot treat a `VerifiedPlan` as a signed
  authorization blob.
- **The `snapshot_hash` check is conservative.** Adding a capability
  invalidates every outstanding plan, even ones that don't touch the
  new capability. A finer-grained check (per-capability version) could
  be added later; 0.1.0 chooses simplicity.
- **Context refresh is opt-in.** If a `context_refresher` is not
  supplied, the principal is assumed unchanged. Applications that need
  freshness must supply one. This is documented but easy to miss.

---

## Alternatives considered

**Check once, run many times (verification as authorization).**
Rejected. This is the failure mode the whole product exists to prevent.
A `VerifiedPlan` that can be replayed hours later is an authorization
token; authorization tokens are a different product (and a much larger
one).

**Snapshot the world at verify time; check only the diff at execute.**
Rejected for 0.1.0. Producing a complete snapshot of the world (all
rows, all invariants' inputs, all roles) at verify time is expensive
and application-specific. Invariants reading live state inside the
recheck window is cheaper and correct.

**A signed `VerifiedPlan`.** Rejected. Signature verification requires
key management, rotation, and a trust anchor — none of which belong in a
zero-setup library. If durable execution is added later, a signed
serialization format with an explicitly-managed key is a reasonable
follow-up.

**Re-verify everything (including schemas) at execute time.** Rejected.
Schema validation is deterministic on the plan and the registry snapshot;
re-running it is redundant. The snapshot hash catches the only way it
could change.

**Only re-check invariants, not approval.** Rejected. An approval token
that was valid at issue time may be for arguments that have since
changed (because a `$ref` resolved to a different value), or for a
principal who has since been removed. Token validation against the
current args and context is cheap; skipping it means a stale token
executes.

**`execute()` without recheck window.** Rejected. That would make
`execute()` accept untrusted plans without verification, which is the
whole thing Logiq prevents.