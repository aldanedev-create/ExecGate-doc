System Design — End to End
How a plan flows from an untrusted AI proposal to a trusted handler
invocation, and where every safety guarantee is enforced.

This document is the specification the implementation satisfies. When
the docs and the code disagree, the code is wrong.
1. The pipeline at a glance
                    ┌──────────────────────────────────┐
   AI / script ────► │  Application (owns the AI call)  │
                    └────────────────┬─────────────────┘
                                     │ raw proposal (dict)
                                     ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  Logiq (trusted)                                                 │
  │                                                                  │
  │  parse ─► grounding ─► verify ─► VerifiedPlan ─► execute         │
  │                          │                          │            │
  │                   ┌──────┴───────┐           ┌──────┴──────┐     │
  │                   │ schema       │           │ recheck     │     │
  │                   │ refs / cycles│           │ invariants  │     │
  │                   │ static policy│           │ approval    │     │
  │                   │ limits       │           │ idempotency │     │
  │                   └──────────────┘           └──────┬──────┘     │
  │                                                     │            │
  │  registry ◄── capabilities (@logiq.capability)      │            │
  │  context  ◄── principal / tenant / roles            │            │
  │  policies ◄── authorize(check=...)                  │            │
  └─────────────────────────────────────────────────────┼────────────┘
                                                        ▼
                                                trusted handlers
                                                (db, payments, ...)
Structural invariant: the executor accepts only VerifiedPlan. A
plain dict cannot pass isinstance(x, VerifiedPlan). See ADR-0002.

Authorization invariant: verification is not an authorization
grant. Every dynamic check re-runs at execute time. See ADR-0004.
2. The pipeline, stage by stage
Stage 0 — Input
- Input: Any (a dict from json.loads, or a JSON string).
- Trust: none.
- Guard: size limit is enforced before parsing
  (plans.parse_plan calls limits.check_bytes).
Stage 1 — Parse (plans/parse.py)
Normalizes the input into a CanonicalPlan.

Checks:
- Accepts a JSON string (parsed with json.loads) or a plain dict.
- Accepts {"call": ..., "with": ...} (single-call) or
  {"version": ..., "steps": [...]} (multi-step). Not both.
- Enforces max_bytes on the canonical serialization.
- Enforces max_depth on the JSON tree.
- Rejects unknown top-level fields ({"verified": true} is caught here).
- Rejects unknown step fields.
- Rejects step ids that are empty, duplicated, or contain invalid
  characters.
- Rejects non-string call, non-dict with.
- Rejects forward references — a step's $ref must point to an
  earlier step.
- Enforces max_steps.
Returns a CanonicalPlan (still untrusted data) or list[Error]. Never
raises. The parser is the only place structural error messages are
generated.
Stage 2 — Grounding (semantic/grounding.py)
Rejects plans whose sensitive arguments are bare literals.

Applied only if the application has configured
logix.grounding(require_ref_for=[...]). For each configured path
"<capability>.<argument>", the corresponding argument in the plan must
be a {"$ref": ...} expression, or on the literal_allowlist. Otherwise
GROUNDING_REQUIRED.

Runs before the verifier so the error names the argument, not a generic
schema failure. See ADR-0005.
Stage 3 — Verify (verifier.py)
Runs the static checks — every check that does not require live state.

Pass 1 — capability resolution. Every step's call is looked up in
the registry. Unknown names produce UNKNOWN_CAPABILITY with the
step's path.

Pass 2 — argument validation. For each step, every argument is
validated against the capability's input schema.
- Required fields must be present.
- Unknown fields are rejected (additionalProperties: false).
- Literal values are validated against Type.validate.
- $ref values are resolved against earlier steps' declared output
  schemas. The destination type is checked for assignability against the
  source leaf type. int → float is rejected (no widening). A $ref
  into a capability with no declared output schema is rejected (no way to
  type-check it).
Pass 3 — dependency graph. Edges are derived from $ref
expressions. Kahn's algorithm computes a topological order. Cycles
produce DEPENDENCY_CYCLE — this path is defensive, since the parser
rejects forward references.

Pass 4 — snapshot hash. The current registry.snapshot_hash() is
recorded in the resulting VerifiedPlan. If the registry changes between
verify and execute, the executor rejects the plan.

Pass 5 — construct the VerifiedPlan. A frozen dataclass with no
public constructor. Fields: plan_version, steps (tuple of
VerifiedStep), dependency_order, capability_snapshot_hash,
verification_hash, single_call. The verification hash binds the
canonical plan, the dependency order, and the snapshot hash into one
SHA-256 digest.

Returns (VerifiedPlan, []) or (None, errors). Never invokes a
handler.
Stage 4 — The verified IR (ir.py)
VerifiedPlan is immutable and unforgeable:
- @dataclass(frozen=True, init=False). Calling the class raises
  TypeError.
- The only constructor is _construct_verified_plan, a module-private
  function called only by the verifier.
- steps is a tuple; each VerifiedStep.arguments is a
  MappingProxyType.
- verification_hash detects content changes.
- capability_snapshot_hash detects registry changes.
executor.execute_verified accepts nothing else. A raw dict claiming
{"verified": true} fails the isinstance check. See ADR-0002.
Stage 5 — Execute (executor.py)
Runs steps in dependency_order. For each step:
1. Snapshot hash check (once, before any step). If
   registry.snapshot_hash() != verified_plan.capability_snapshot_hash,
   return POLICY_REJECTED and require re-verification.
2. Resolve $ref in arguments. Each $ref is resolved against
   step_outputs (which holds validated outputs from earlier steps, not
   raw handler returns). A reference to a step that has not yet run, or to
   a path that does not exist, produces INVALID_REFERENCE and halts
   execution.
3. Run the recheck window (see Stage 5b below). If it returns
   REPLAY, return the cached value without invoking the handler.
4. Prepare handler arguments. For Pydantic-typed parameters, the
   value is converted to a model instance (default HandlerMode.MODEL)
   or a plain dict (HandlerMode.VALUES). Non-model parameters pass
   through unchanged.
5. Invoke the handler. Exceptions produce HANDLER_FAILED with the
   exception type and message (redacted by construction — no handler
   locals, no stack frames, no argument values).
6. Validate and normalize the output. If the capability declares an
   output schema, the return value is validated; a mismatch produces
   OUTPUT_VALIDATION_FAILED. If output_schema has a
   prepare_output method (Pydantic), the value is normalized to a
   JSON-safe dict before being stored in step_outputs and returned in
   Result.value.
7. Commit idempotency. If the capability is idempotent=True and
   the store is present, commit(key, output) marks the reservation
   complete. On any failure path, release(key) frees the reservation
   so a retry can reuse it.
8. Record the trace. ExecutionRecorder.record_step appends a
   StepTrace (step_id, capability, status, duration_ms, error_code).
   The audit hook fires if one is attached.
Execution halts on the first step failure. Steps that already ran may
have produced side effects; the returned Result.trace shows which
steps succeeded and which failed.

The result:
- Single-call plans: Result.value is the handler's return value.
- Multi-step plans: Result.value is {step_id: output} for every step
  that ran successfully.
Stage 5b — The recheck window (semantic/recheck.py)
Every check that depends on live state runs here, immediately before
the handler invocation. This is the window that makes verification an
advisory check rather than a permanent authorization grant.
1. Context refresh (optional). If a context_refresher is supplied,
   the context is re-read; a principal change aborts with
   AUTHORIZATION_FAILED.
2. Live invariants. logix.authorize(cap, check=fn) attaches a
   check. It runs with the resolved arguments and the current context.
   - Allow → continue.
   - Deny(code, message) → POLICY_REJECTED.
   - RequireApproval(reason) → set approval_required_flag = True and
     continue to the approval check.
   - A crashing check → AUTHORIZATION_FAILED (never silently allows).
3. Approval. If the capability is requires_approval (from the
   registry — never from the plan), an ApprovalToken must be supplied
   and must matches(capability, args, context). A missing or
   mismatched token → APPROVAL_REQUIRED.
4. Idempotency. If the capability is idempotent=True, the store is
   checked with a key derived from (capability_name, canonical_args_hash).
   - Fresh key → reserve; proceed to handler.
   - Committed key, same args → REPLAY with cached value; do not invoke
     handler.
   - Committed key, different args → IDEMPOTENCY_CONFLICT.
   - In-flight key (reserved, not committed) → IDEMPOTENCY_CONFLICT.
See ADR-0004 for the reasoning behind the recheck window.
Stage 6 — Result
Result enforces its invariants at construction:
- ok=True and errors=() (success).
- ok=False and len(errors) >= 1 (failure).
Result.trace is a Trace with per-step StepTrace entries. No raw
argument values, no handler return values, no model prompts.

Result.to_dict() is the sanctioned serialization; it produces a
JSON-safe dict with error codes and messages.
3. The trust boundary, precisely
Where each guarantee is enforced, and the test that proves it. This is
the table that docs/security.md refers to. If a guarantee has no
matching test, the guarantee is not claimed.
#	Guarantee	Enforced at	Test file
1	No eval/exec/__import__ of model data	everywhere (no such call on the plan path)	tests/security/test_no_eval_exec.py
2	Unknown capability never invokes	verifier pass 1	tests/security/test_unknown_capability_never_invokes.py
3	Invalid input never invokes	verifier pass 2	tests/security/test_invalid_input_never_invokes.py
4	Ref cycles / forward refs rejected	parse + verifier pass 3	tests/security/test_ref_cycle_rejected.py
5	Schema validity ≠ authorization	execute, recheck window	tests/security/test_schema_validity_not_authorization.py
6	Approval not model-settable	recheck + token binding	tests/security/test_approval_not_model_settable.py
7	Output failure reported distinctly	execute stage 6	tests/security/test_output_failure_reported.py
8	Redaction	construction (Trace/Error shapes)	tests/security/test_redaction.py
9	Limits enforced	parse	tests/security/test_limits_enforced.py


Two additional structural guarantees:
#	Guarantee	Enforced at	Test file
10	VerifiedPlan unforgeable	ir.py (frozen, init=False, private constructor)	tests/core/test_ir_immutability.py
11	Adapters cannot touch verifier/executor	AST scan of src/logiq_mcp/, src/logiq_ai/, src/logiq_pydantic/	tests/mcp/test_leaf_node_boundary.py


4. Why verify and execute are separate
Logix.verify(plan) runs the static pipeline and returns a
VerificationReport. Logix.execute(verified_plan) runs the dynamic
checks and invokes the handlers.

The split exists because static facts can change between the two
calls:
- The user's session may expire.
- The order may be refunded by someone else.
- The tenant's plan may be downgraded.
- An approval may be revoked.
Verification cannot be a permanent authorization grant. execute()
re-runs every check that can be invalidated by live state.

run() is verify() + execute() with no gap. The recheck window runs
identically, so run() is not less safe. The gap is only created when
the application chooses to insert one — for a human approval step, for
example:
report = logix.verify(plan, context=ctx)
if not report.ok:
    return handle_errors(report.errors)

# Application-specific decision. The AI has no path here.
approval = ask_human(report.verified_plan)

result = logix.execute(report.verified_plan, context=ctx, approval=approval)
Even with the gap, execute() re-verifies dynamic state. See ADR-0004.
5. The recheck window: what and why
The recheck window runs per step, immediately before that step's
handler is invoked. It re-validates:
- Identity / context. If a context_refresher is supplied, the
  current principal is re-read. A change aborts.
- Dynamic authorization. authorize(check=...) reads live state.
- Live invariants. Semantic-layer checks (grounding is at verify
  time; invariants are at execute time).
- Approval token. Still valid, still bound to this exact action.
- Idempotency. No conflicting prior invocation.
Skipped at recheck: schema validation (static, cannot change), reference
resolution (static), dependency order (static). Those ran at verify and
their results are cached in the VerifiedPlan.

The recheck window is the only place live state is read. If a capability
has no dynamic policy and no approval requirement, its recheck is a
no-op beyond the snapshot-hash check — cheap.
6. Multi-step plans and grounding
A multi-step plan executes sequentially in topological order. Between
steps:
- The validated output of step N is stored in a step-results map.
- $ref in step N+1 resolves against that map.
- Grounding rule (semantic layer). Arguments declared as sensitive
  (via logix.grounding(require_ref_for=...)) must be $ref-sourced —
  not bare literals. A model cannot type a refund amount; it must
  reference an earlier step's validated output.
If step N fails, steps N+1..M do not run. The result reports which
steps already produced side effects.

If step N returns a value that fails output validation, that is
OUTPUT_VALIDATION_FAILED and the step is treated as failed. The
side effect may have occurred.
7. Failure taxonomy
Where each code is raised and what it implies.
Code	Stage	Handler ran?	Interpretation
INVALID_PLAN	parse	no	Structurally malformed input
UNKNOWN_CAPABILITY	verify	no	A capability name not in the registry
SCHEMA_VALIDATION_FAILED	verify	no	Argument shape wrong
INVALID_REFERENCE	verify or execute	no	$ref to a nonexistent path / incompatible type
DEPENDENCY_CYCLE	verify (defensive)	no	Circular $ref
POLICY_REJECTED	recheck (dynamic)	possibly earlier steps	An invariant returned Deny, or the snapshot hash changed
AUTHORIZATION_FAILED	recheck	possibly earlier steps	An invariant raised, or the principal changed
APPROVAL_REQUIRED	recheck	possibly earlier steps	Missing or mismatched approval token
IDEMPOTENCY_CONFLICT	recheck	no for this step	Same idempotency key, different args, or in-flight
RESOURCE_LIMIT_EXCEEDED	parse	no	max_bytes, max_steps, max_depth
HANDLER_FAILED	execute	yes, this step	Handler raised
OUTPUT_VALIDATION_FAILED	execute	yes, this step	Handler returned the wrong shape
GROUNDING_REQUIRED	verify (before verifier)	no	Sensitive argument is a literal
EXECUTION_CANCELLED	execute	possibly earlier steps	Unexpected internal error


The distinction that matters: "rejected before any handler ran"
(codes from parse / verify / grounding) vs "rejected after some handlers
ran" (codes from recheck / execute). The application uses this to decide
whether to retry, compensate, or report to the user.

Result.trace shows which steps succeeded (recorded) and which failed
(the one that halted execution). Steps after the failing step have no
trace entries because they never started.
8. Observability
Every execution produces a Trace:
- execution_id (a fresh UUID hex per call)
- plan_version
- verification_duration_ms
- per-step StepTrace: step_id, capability, status (ok /
  failed), duration_ms, error_code
Never present in the trace: raw argument values, handler return
values, model prompts, exceptions, or stack frames. This is by
construction — StepTrace has no field for any of those.

The audit hook (logix.audit(hook)) receives the same safe metadata. If
the hook raises, the exception is swallowed — a broken auditor must not
block legitimate actions. Audit systems that need raw values must
retrieve them from the handler's own logging.

The application can attach whatever logging/tracing it needs to the
Trace and to its own handler-level instrumentation. Logiq does not
require a logging framework.
9. Performance posture
- Schemas are derived once, at registration. build_capability
  runs infer_input_schema and infer_output_schema and stores the
  results in the Capability. Runtime validation uses the stored schema;
  no re-derivation per call.
- Capability descriptions are cached in the Registry. Adding or
  removing a capability invalidates the snapshot hash.
- Dependency order is computed at verify and stored in the
  VerifiedPlan. The executor walks the stored order; it does not
  re-derive it.
- verify() never re-parses a VerifiedPlan. The IR is already
  canonical.
- Sequential execution is the default. Parallel scheduling would
  require explicit dependency semantics, failure propagation rules, and
  cancellation — none of which are in scope for 0.1.0.
A VerifiedPlan is not proof of current authorization — it is proof
that the plan was structurally valid and statically permitted at verify
time. Execution re-earns the dynamic guarantees.

The core is stdlib-only. The hot path (parse_plan + verify_plan +
execute_verified) is microseconds-to-low-milliseconds for realistic
plans. Handler execution dominates any real workload; optimizing
verification further would be premature.
10. Where each concern lives
Concern	Module
Capability registration	capabilities.py
Annotation → schema	annotation_inspect.py → schemas/infer.py
Plan parsing	plans/parse.py
Reference grammar	plans/references.py
Resource limits	plans/limits.py
Static checks	verifier.py
Verified IR	ir.py, _internal/immutability.py
Dynamic checks	semantic/recheck.py, semantic/invariants.py
Approval	approval.py
Idempotency	semantic/idempotency.py
Execution	executor.py
Grounding	semantic/grounding.py
Repair loop bounds	semantic/repair_loop.py
Results / trace	results.py, observability.py
Redaction	_internal/redaction.py
AI catalog	tools.py, logiq_ai/
MCP integration	logiq_mcp/


11. The structural guarantee
The executor accepts only VerifiedPlan. VerifiedPlan is
constructible only by the verifier. The verifier is the only stage
that reads static policy. The recheck window is the only stage that
reads live state. Handlers are the only code that touches the outside
world.

Everything else — adapters, the AI, application glue — sits outside this
loop. Adapters can feed data in and read results out, but they have no
reference to verifier, executor, or ir. A bug in an adapter cannot
bypass verification because the adapter has no path to it.

This is what makes "a plan that fails verification cannot reach a
handler" a structural guarantee rather than a conventional one. The
guarantee is enforced by the shape of the code, not by the discipline of
its authors.