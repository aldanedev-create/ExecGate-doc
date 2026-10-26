# Production Guide

Deployment considerations, observability, limits, and the honest boundary of what Logiq's guarantees cover. Read this before running Logiq against real users.

---

## 1. What You're Deploying

Logiq is a **verification and execution boundary** between untrusted plans and trusted handlers. In production, that means:

- **The trust boundary is a real boundary.** A plan that fails verification does not reach a handler. The core guarantee is structural, not conventional.
- **The semantic layer is engineered minimization, not proof.** Grounding stops model-typed sensitive values. Invariants check live state. Approvals gate sensitive actions. None of these prove the model's intent is correct.
- **The handler is the application's responsibility.** Logiq does not prove the handler is correct, that external services behave, or that business rules hold.

Before production, read `docs/security.md`, particularly the section titled **"What Logiq does not protect against"**, and make sure your application addresses each gap.

---

## 2. Deployment Topology

Logiq runs in-process. There is no separate service, no network hop, and no background daemon.

### Single Process (Default)

```python
# app.py
from logiq import Logix

logix = Logix()

@logix.capability
def get_order(order_id: int) -> dict[str, int]:
    ...
```

Serve the application over your framework of choice, such as FastAPI or Flask.

- Use one `Logix` engine per process.
- The core `src/logiq/` package has zero third-party runtime dependencies.
- Memory footprint is small — a few hundred kilobytes for the engine and its registries.

### Multiple Workers

Each worker has its own `Logix` instance with its own registry. The registries are populated at import time through module-level decorators, so each worker sees the same capabilities.

The default `InMemoryIdempotencyStore` is per-worker. Two workers processing the same idempotent call will each invoke the handler. For production idempotency, implement a durable store (see [Section 6: Durable Idempotency](#6-durable-idempotency)).

### Multi-Tenant

Create one engine per tenant when registries or policies differ:

```python
tenants: dict[str, Logix] = {
    tenant_id: make_engine(tenant_id)
    for tenant_id in load_tenants()
}
```

Each engine has isolated state. A policy attached to one engine does not affect another. A `VerifiedPlan` from one engine is not accepted by another because the snapshot hashes differ.

**Cost:** Memory grows with the number of tenants. For hundreds of tenants, this may be fine. For tens of thousands, consider one engine with tenant-scoped invariants that read `ctx.tenant`.

### Co-Located With the AI

Logiq runs in the same process as the AI client. The `run()` call typically sits between receiving the model's response and returning the result to the model.

The engine holds no provider handle; the application owns the AI call.

---

## 3. Configuration

### Limits

Defaults are defined in `PlanLimits`:

- Maximum plan size: 64 KB
- Maximum steps: 32
- Maximum depth: 8
- Maximum invocations: 64

Override them per engine:

```python
from logiq.plans import PlanLimits

logix = Logix(
    limits=PlanLimits(
        max_bytes=32_000,
        max_steps=10,
        max_depth=6,
    )
)

# Or adjust later:
logix.limits(max_steps=10)
```

Lower limits reduce the cost of adversarial or runaway plans. Higher limits accommodate legitimate multi-step workflows.

Do not raise the limits without reviewing the invariant checks accordingly. A bigger plan is a bigger attack surface.

### Policies and Approval

Configure policies and approval requirements once, at engine construction or during startup:

```python
def refund_policy(args, ctx):
    ...

logix.authorize(issue_refund, check=refund_policy)
logix.require_approval(issue_refund)
logix.grounding(require_ref_for=["issue_refund.amount"])
```

Configuration is synchronous and does not block. Configure the engine at import time or in a startup hook, before handling concurrent requests.

### HandlerMode (Pydantic)

If `logiq_pydantic` is installed, the handler mode is module-global:

```python
from logiq_pydantic import HandlerMode, set_handler_mode

set_handler_mode(HandlerMode.VALUES)  # or MODEL (default)
```

Configure it at startup. Reads are not synchronized with writes, so changing the mode at runtime affects subsequent executions but is not thread-safe.

See `docs/pydantic.md`, Section 5.

### Audit Hook

```python
class AuditLog:
    def on_step(self, event):
        # event: {
        #   execution_id, step_id, capability,
        #   status, duration_ms, error_code
        # }
        logger.info("step", extra=event)

    def on_result(self, event):
        # event: {
        #   execution_id, plan_version, ok, error_code
        # }
        logger.info("result", extra=event)

logix.audit(AuditLog())
```

The hook receives safe metadata only — no raw arguments, handler returns, or model prompts.

Exceptions from the hook are swallowed so a broken auditor does not block legitimate actions. Log from within the hook; do not assume the pipeline will log on your behalf.

---

## 4. Observability

### Trace

Every `Result` has a trace:

```python
result = logix.run(plan, context=ctx)

if result.trace:
    for step in result.trace.steps:
        print(
            step.step_id,
            step.capability,
            step.status,
            step.duration_ms,
        )
```

Trace fields include:

- `execution_id`
- `plan_version`
- `verification_duration_ms`
- Per-step `StepTrace` entries

Traces do not contain raw argument values, handler return values, or model prompts.

### Error Codes

`Result.errors` is a tuple of `Error` objects with stable codes. Error codes are part of the contract; see `docs/api-reference.md`, Section 14.

Applications should branch on `Error.code`, not on the human-readable message.

### Metrics to Track

| Metric | Why It Matters |
|---|---|
| `logiq.run.success` / `logiq.run.failure` | Overall success rate |
| Failure counts by `Error.code` | Identifies which layer rejects most often |
| `verification_duration_ms` | Measures verification overhead |
| `step.duration_ms` | Measures handler latency |
| `APPROVAL_REQUIRED` rate | Shows whether approvals are slowing operations |
| `POLICY_REJECTED` rate | Helps identify overly strict invariants or potential attacks |
| `IDEMPOTENCY_CONFLICT` rate | Helps identify callers reusing keys with different arguments |

A sudden increase in `SCHEMA_VALIDATION_FAILED` after a model update suggests the model is emitting plans that the schema rejects. Either the schema is too strict or the model needs better tool descriptions.

A sudden increase in `POLICY_REJECTED` suggests an invariant change or a possible attack.

### Logging

Log `Result.trace` and error codes. Do not log raw arguments, raw handler returns, or model prompts. The trace is safe by construction; raw values are not.

If you need to log arguments for debugging in a staging environment, do so explicitly and understand that they may contain personally identifiable information (PII).

---

## 5. Security Checklist Before Production

### Required

- [ ] **Do not expose `logix.run()` directly to the internet.** The model's proposal must come from the application's AI call, not from an untrusted HTTP request. An endpoint that runs arbitrary submitted plans bypasses the purpose of Logiq.
- [ ] **Treat handler code as trusted code.** Every function decorated with `@logix.capability` should be written and reviewed like any other handler in your application.
- [ ] **Use safe subprocess practices.** Use `shell=False`, list-based arguments, and timeouts for any handler that shells out. Logiq does not sanitize string arguments.
- [ ] **Keep credentials out of argument values.** `ExecutionContext` carries identity; capability arguments should not contain API keys, passwords, or session tokens.
- [ ] **Make invariants read live state.** A cached authorization check is not a live authorization check.
- [ ] **Issue approval tokens only from trusted code.** Never issue them from a request body, model output, or URL parameter.
- [ ] **Keep verification and execution under application control.** Call `logix.verify()` and `logix.execute()` only from the application. Treat `VerifiedPlan` as an internal artifact: do not send it to the model or accept it from an untrusted source.

### Recommended

- [ ] **Use idempotency for side-effecting capabilities.** Even if a handler is naturally idempotent, marking it `idempotent=True` can help catch accidental double invocation.
- [ ] **Install an audit hook for every engine.** The trace helps with debugging; the audit log helps with compliance.
- [ ] **Tune limits to the workload.** Defaults are conservative but may be too generous for a simple capability.
- [ ] **Use structured logging for `Error.code`.** Codes are stable; messages are not.
- [ ] **Alert on `POLICY_REJECTED` rates.** A sudden spike may indicate an incident, not a routine fluctuation.

### Known Limitations to Document

- [ ] **MCP approval limitation.** Capabilities with `requires_approval=True` are unreachable over MCP server mode in version `0.1.0`. Document this if you expose capabilities over MCP.
- [ ] **MCP multi-step limitation.** Capabilities with grounding rules that require `$ref` cannot be satisfied over MCP in version `0.1.0`.
- [ ] **Idempotency scope.** The default store is per-process. Document that cross-process duplicates require a durable store.
- [ ] **Sensitive result values.** `Result.value` may contain PII. The handler's return value is the raw value; if it contains sensitive data, the application must not log it.

---

## 6. Durable Idempotency

The default `InMemoryIdempotencyStore` is a single-process, thread-safe store. It:

- Does not survive restarts.
- Does not coordinate across processes.
- Cannot guarantee "at most once" beyond its single-worker scope.

For payment, order submission, or any side effect where double execution is unacceptable, implement a durable store.

The following is an illustrative PostgreSQL-backed implementation:

```python
from logiq.semantic import IdempotencyResult, IdempotencyStatus


class PostgresIdempotencyStore:
    def __init__(self, conn):
        self._conn = conn

    def check_and_reserve(
        self,
        key: str,
        args_hash: str,
    ) -> IdempotencyResult:
        with self._conn.transaction():
            row = self._conn.execute(
                """
                SELECT state, args_hash, result
                FROM idempotency
                WHERE key = %s
                FOR UPDATE
                """,
                (key,),
            ).fetchone()

            if row is None:
                self._conn.execute(
                    """
                    INSERT INTO idempotency (key, state, args_hash)
                    VALUES (%s, 'reserved', %s)
                    """,
                    (key, args_hash),
                )
                return IdempotencyResult(IdempotencyStatus.RESERVED)

            state, stored_hash, result = row

            if stored_hash != args_hash:
                return IdempotencyResult(
                    IdempotencyStatus.CONFLICT,
                    detail="args hash mismatch",
                )

            if state == "reserved":
                return IdempotencyResult(
                    IdempotencyStatus.CONFLICT,
                    detail="in flight",
                )

            return IdempotencyResult(
                IdempotencyStatus.REPLAY,
                cached_value=result,
            )

    def commit(self, key: str, result) -> None:
        with self._conn.transaction():
            self._conn.execute(
                """
                UPDATE idempotency
                SET state = 'committed', result = %s
                WHERE key = %s
                """,
                (result, key),
            )

    def release(self, key: str) -> None:
        with self._conn.transaction():
            self._conn.execute(
                """
                DELETE FROM idempotency
                WHERE key = %s AND state = 'reserved'
                """,
                (key,),
            )
```

Configure the engine with the durable store:

```python
logix = Logix(
    idempotency_store=PostgresIdempotencyStore(db_conn)
)
```

**Exactly-once execution still requires cooperation from the external service.**

Logiq can deduplicate handler invocations within the scope of its store. It cannot guarantee that a payment processor charged once if the network dropped the response and Logiq's store shows `committed`. That is a distributed-systems problem, not a Logiq-specific guarantee.

The specification's page 14 caveat applies: do not claim exactly-once behavior without the required infrastructure.

---

## 7. Scaling

### Throughput

A single Logiq engine on a single core handles thousands of `logix.run()` calls per second for simple plans. Verification is measured in microseconds; handler execution dominates.

If verification is your bottleneck, you have an unusual workload, such as millions of no-op plans. Add more workers or profile the specific cost.

**Treat these figures as workload-dependent expectations, not universal benchmark guarantees.** Measure your actual application before making capacity decisions.

### Latency

The `logix.run()` latency consists of:

- Parsing
- Verification
- Rechecking
- Handler execution
- Output validation

For realistic plans, the pipeline is stated to be under 1 ms; handler latency depends on the handler. Invariants that read live state add their own latency.

Measure pipeline overhead separately from handler latency. If you see a slowdown, inspect the handler and live-state reads before assuming verification is responsible.

### Memory

Per-engine memory is dominated by:

- The capability registry, with one `Capability` per registered function.
- The idempotency store, which grows with unique keys.

For long-running processes, monitor the idempotency store's size. Implement a TTL or bounded store if keys accumulate.

### Multi-Region

The default engine has no cross-region coordination. If a plan needs shared idempotency across regions, each region must coordinate through a durable store backed by a shared database or equivalent coordination mechanism.

---

## 8. Upgrades and Versioning

### API Stability

`docs/api-reference.md` marks each API as stable, experimental, or reserved:

- **Stable:** Part of the `0.1` contract. Breaking changes require a major version.
- **Experimental:** May change between minor versions. Pin your version.
- **Reserved:** The name is fixed, but semantics are deferred. Do not rely on it.

The core guarantee — a plan that fails verification does not reach a handler — is stable. It will not be weakened in a minor or patch release.

### Error Code Stability

Error codes are part of the stable contract:

- Adding a code is a minor release.
- Renaming or removing a code is a major release.

Application code that switches on `Error.code` is intended to remain safe across minor versions.

### Adapter Versioning

Adapters (`logiq_pydantic`, `logiq_ai`, and `logiq_mcp`) are versioned together with the core in version `0.1.0`. Future releases may decouple them; for now, the version numbers match.

### `VerifiedPlan` Compatibility

A `VerifiedPlan` produced by Logiq `0.1.x` may not be accepted by Logiq `0.1.y` if the `verification_hash` algorithm changes.

In practice, this should not be a concern because plans are short-lived: verification and execution normally occur in the same request. If you persist `VerifiedPlan` objects for later execution, re-verify them after upgrades.

---

## 9. Incident Response

### Symptom: Unexpected Increase in `POLICY_REJECTED`

**Likely causes:**

- An invariant change was deployed.
- An attack is attempting to bypass a policy.
- A live-state dependency is stale or degraded.

**Check:** Inspect `Result.errors[].details["code"]` for the denial code. Compare it with recent deployments and the invariant's logic.

### Symptom: Unexpected Increase in `SCHEMA_VALIDATION_FAILED`

**Likely causes:**

- A capability's schema was tightened.
- The model was updated and now proposes different argument shapes.
- An adapter started emitting a different shape.

**Check:** Inspect `Result.errors[].path` to identify the argument that failed. Compare it with the catalog sent to the model.

### Symptom: High `APPROVAL_REQUIRED` Rate

Approval requirements are expected for sensitive operations. If the rate is unexpectedly high, either:

1. The approval flow is failing to issue tokens.
2. Calls are reaching sensitive capabilities without going through the expected approval path.

**Check:** Inspect the `Error.details` for `APPROVAL_REQUIRED`. Does it identify the expected capability or an unexpected one?

### Symptom: `IDEMPOTENCY_CONFLICT`

**Likely causes:**

- A caller is reusing an idempotency key with different arguments.
- Two concurrent calls are racing; the second call conflicts.
- An in-flight call is stuck after a crash before commit or release.

**Check:** Inspect the store's contents for the conflicting key. If a key remains permanently reserved, the handler may have crashed during execution and the reservation was not released. This may indicate a handler error or process crash.

### Symptom: An Idempotent Capability Ran Twice

This should not happen within the scope of a correctly configured store. If it does:

- Check that the capability is marked `idempotent=True` in the `@logix.capability` decorator.
- Check that the store is passed to `Logix(idempotency_store=...)`.
- Check that the handler does not clear the store.

Double execution can happen across processes when using the default per-process store. Implement a durable store (see [Section 6](#6-durable-idempotency)) or accept that cross-process double execution is possible.

### Symptom: The Model Does Not Respond Well to the Catalog

This is not necessarily a Logiq bug. The model sees JSON Schema; if it produces plans that the schema rejects, the descriptions may be too terse or the schema too strict.

Options:

- Add more descriptive `__doc__` strings to handlers.
- Add description overrides to `@logix.capability`.
- Loosen schemas, such as by using fewer constraints or `Union` for ambiguous types, while recognizing that this weakens validation.
- Use the local JSON-mode prompt builder for more detailed instructions.
- Compare behavior across models. Some models handle the same catalog better than others.

This may be a model's tool-calling limitation rather than a Logiq issue.

---

## 10. What to Monitor in Production

A minimal monitoring set:

### Per Process (Sampled)

```text
logiq.run.total                    (counter)
logiq.run.success                  (counter)
logiq.run.failure_by_code{code}    (counter)
logiq.verify.duration_ms           (histogram)
logiq.step.duration_ms{capability} (histogram)
```

### Per Engine (Sampled)

```text
logiq.registry.size      (gauge)
logiq.idempotency.size   (gauge)
```

### Business-Level Metrics

```text
approval_requests.rate   (counter)
approval_grants.rate     (counter)
approval_denials.rate    (counter)
```

### Alerts

- Alert when `logiq.run.failure_by_code{code="POLICY_REJECTED"}` rises above baseline.
- Alert when `logiq.run.failure_by_code{code="IDEMPOTENCY_CONFLICT"}` rises above zero; this usually indicates a bug or conflicting calls that need investigation.
- Alert when `logiq.verify.duration_ms` p99 exceeds your SLO; this may indicate slow invariants or other verification overhead.
- Alert when `logiq.idempotency.size` grows without bound; the store may need a TTL or cleanup policy.

---

## 11. What Logiq Is Not

Logiq is not:

- **A workflow engine:** No orchestration, scheduling, or durable workflow state.
- **A task queue:** No persistence or retry daemon.
- **A database:** The idempotency store can be backed by one, but Logiq does not provide one.
- **A distributed system:** The core is single-process.
- **An AI provider:** No model calls or provider SDK.
- **A security proxy:** It enforces what the application declares; it does not infer authorization or scan for prompt injection.
- **A business rule engine:** Invariants are code the application writes; business logic remains the application's responsibility.
- **A guarantee that any specific action is safe:** See [Section 1](#1-what-youre-deploying).

The honest scope: Logiq is a verification and execution boundary. It makes a plan's transition from "the model said this" to "the handler ran with these arguments" auditable, testable, and structurally impossible to bypass.

Everything else — the model, the handlers, the business rules, and the external services — remains the application's responsibility.

---

## 12. Where to Go Next

- `docs/security.md` — The full threat model.
- `docs/semantic-layer.md` — The runtime checks that make this boundary real.
- `docs/mcp.md` — Guidance for deploying over MCP.
- `docs/api-reference.md` — API documentation and stability markers.
- `CHANGELOG.md` — What's stable versus experimental in your version.
