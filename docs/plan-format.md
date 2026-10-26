### Plan Format

A plan is untrusted data describing what an AI wants to do. It is JSON, never executable Python. ExecGate parses and verifies the plan before executing it.

This document defines the plan grammar, parser rules, and the limits of $ref.

For the pipeline, see [`system-design.md` §2](system-design.md). For the rationale behind grounding with $ref, see [ADR-0005](adr-0005.md).
1. Two forms
Single-call form
Use this form for a plan with one step:
{
  "call": "get_customer",
  "with": {"customer_id": 42}
}
- call (string, required): a capability name registered in the Registry.
- with (object, optional; defaults to {}): the capability's arguments.
Multi-step form
Use this form when steps depend on earlier steps:
{
  "version": "1",
  "steps": [
    {"id": "o", "call": "get_order", "with": {"order_id": 502}},
    {
      "id": "r",
      "call": "issue_refund",
      "with": {
        "order_id": {"$ref": "o.id"},
        "amount": {"$ref": "o.total"}
      }
    }
  ]
}
- version (string, optional; defaults to "1"): the plan format version. Version "1" is the only version accepted in 0.1.0.
- steps (array, required): the ordered list of steps.
- id (string, required): a unique step identifier. It must match [A-Za-z_][A-Za-z0-9_]*. Later steps may reference earlier step IDs with $ref.
- call (string, required): a capability name.
- with (object, optional; defaults to {}): the capability's arguments.
The two forms cannot be mixed. A plan containing both call and steps is rejected with INVALID_PLAN.

Both forms use the same parser, verifier, and executor. Internally, single-call plans receive the synthetic step ID __single__, which is not exposed to users.
2. What the parser enforces
Each violation below is rejected during parsing, before any handler is considered. The parser returns INVALID_PLAN with a specific message.
Structure
- The input must be a JSON object (Python dictionary). Lists, scalars, and invalid JSON strings are rejected.
- A JSON string is accepted and decoded with json.loads. Invalid JSON produces INVALID_PLAN: plan is not valid JSON.
- Unknown top-level fields are rejected. The only allowed fields are version, steps, call, and with. For example, {"verified": true} is rejected.
- In multi-step form, unknown step fields are rejected. The only allowed step fields are id, call, and with.
Sizes and limits
- max_bytes (default 64,000): the canonical serialized plan must not exceed this size.
- max_steps (default 32): the number of steps must not exceed this limit.
- max_depth (default 8): the nesting depth of the JSON tree.
These limits are configured through PlanLimits. Applications can override them per engine with logix.limits(...).
Identifier rules
- Step IDs must match [A-Za-z_][A-Za-z0-9_]*.
- Step IDs must be unique within a plan. Duplicates produce INVALID_PLAN: duplicate step id.
- call must be a non-empty string.
Forward references
A step may reference only a step that appears earlier in the steps list. A forward reference produces:
INVALID_PLAN: $ref points to a non-earlier step: <id>
This rule makes cycles impossible through normal parsing. See [`system-design.md` §2, Stage 1](system-design.md) and ADR-0005.
Version
version must be "1" or omitted (which defaults to "1"). Other versions produce INVALID_PLAN: unsupported plan version: <v>.
3. The $ref grammar
$ref is the only way for an argument to source a value from a prior step's output.
Syntax
{"$ref": "<step-id>"}
{"$ref": "<step-id>.<segment>"}
{"$ref": "<step-id>.<segment>.<segment>..."}
Examples:
{"$ref": "o"}
{"$ref": "o.id"}
{"$ref": "o.address"}
{"$ref": "o.address.city"}
{"$ref": "items.0"}
{"$ref": "items.0.name"}
These refer to the whole output of step o, fields such as id or address, a nested city field, or list elements such as index 0.
Grammar rules
- The step ID must match [A-Za-z_][A-Za-z0-9_]*.
- Each path segment must match [A-Za-z_][A-Za-z0-9_]* for dictionary keys or \d+ for list indices.
- Wildcards, expressions, and function calls are not supported. $ref is data, not code.
- A {"$ref": "..."} object must contain exactly one key. An object such as {"$ref": "...", "override": 1} is not treated as a reference; it is a plain object and is validated against the destination schema.
Resolution
At verification time, the verifier:
1. Parses the $ref.
2. Looks up the referenced step's declared output schema.
3. Walks the schema path with Type.walk to find the leaf type.
4. Checks whether the leaf type is assignable to the destination argument's declared type.
Assignability is strict: int → float is rejected (no widening), and Literal["a"] → str is rejected (no coercion). The application must declare the types it wants and supply values of those types, or use a capability with a suitable output schema. For example, dict[str, float] accepts floats, not ints.

At execution time, the executor resolves $ref against step_outputs, which contains validated outputs. If the referenced step has not run or the path does not exist in the actual output, ExecGate returns INVALID_REFERENCE and halts execution.

The verification-time type check and runtime path check are independent defenses: the first checks what the schema can prove; the second checks the actual data.
4. Grounding
Grounding is an application policy layered on top of the plan grammar. It does not change what makes a plan structurally valid; it restricts what certain arguments may contain.
logix.grounding(require_ref_for=["issue_refund.amount"])
With this policy, issue_refund.amount must be a $ref expression rather than a bare literal, unless the literal is on the literal_allowlist. This helps prevent a model from inventing a refund amount instead of sourcing it from a validated result.

The policy:
- Applies per capability and argument, addressed as "<capability>.<argument>".
- Runs at verification time, before the verifier.
- Returns GROUNDING_REQUIRED if an argument is a literal that is not on the literal_allowlist.
- Accepts values sourced from a $ref to an earlier step.
The literal_allowlist supports arguments that are sensitive but may legitimately come from the user, such as a user-provided identifier that the application has already validated. Add such arguments to the allowlist rather than weakening the rule globally.

See ADR-0005 for the design rationale.
5. What is not in a plan
A plan is data. It cannot:
- Name an unregistered capability. Every call must match a name in the Registry.
- Supply arguments outside the schema. Unknown arguments, wrong types, and missing required arguments are rejected.
- Execute code. There is no eval, exec, __import__, or shell execution on the plan path.
- Approve itself. The executor's approval_required_flag comes from the registered capability, not the plan. A field named approved does not satisfy an approval requirement.
- Skip invariants. Dynamic checks run in the recheck window regardless of what the plan contains.
- Create dependency cycles. Forward references are rejected, preventing cycles through normal parsing.
6. Versioning
The plan format is versioned by the top-level version field. Version "1" is the only version supported in 0.1.0.

Future versions:
- Will use distinct strings such as "2" or "2.1".
- Will be additive where possible, so a newer parser can accept version "1" plans unchanged.
- Will be rejected by older parsers with INVALID_PLAN: unsupported plan version.
The version field tells an AI client which format to emit. logix.tools.format(...) includes the schema version in each capability's ToolSpec (currently "1").
7. Examples
Minimal valid plans
{"call": "add", "with": {"a": 1, "b": 2}}
{"call": "ping", "with": {}}
{"call": "noop"}
{"version": "1", "steps": [{"id": "s", "call": "add", "with": {"a": 1, "b": 2}}]}
Invalid plans
Unknown top-level field:
{"call": "add", "with": {"a": 1, "b": 2}, "verified": true}
Expected error: INVALID_PLAN: unknown top-level fields: ['verified'].

Both forms used together:
{"call": "add", "steps": [...]}
Expected error: INVALID_PLAN: plan cannot have both 'call' and 'steps'.

Missing step ID:
{"steps": [{"call": "add"}]}
Expected error: INVALID_PLAN: steps[0].id must be a non-empty string.

Unsupported version:
{"version": "2", "steps": []}
Expected error: INVALID_PLAN: unsupported plan version: '2'.

Forward reference:
{
  "steps": [
    {"id": "a", "call": "x", "with": {"r": {"$ref": "b"}}},
    {"id": "b", "call": "y", "with": {}}
  ]
}
Expected error: INVALID_PLAN: $ref points to a non-earlier step: 'b'.
Multi-step plan with references
A canonical refund workflow:
{
  "version": "1",
  "steps": [
    {"id": "o", "call": "get_order", "with": {"order_id": 502}},
    {
      "id": "r",
      "call": "issue_refund",
      "with": {
        "order_id": {"$ref": "o.id"},
        "amount": {"$ref": "o.total"}
      }
    }
  ]
}
Step r references the id and total fields from step o. If grounding is configured for issue_refund.amount, a plan that supplies {"amount": 50.0} instead of {"amount": {"$ref": "o.total"}} is rejected with GROUNDING_REQUIRED.
8. Failure modes and error codes
The following table lists failures raised during parsing, before the verifier, except for the malformed $ref case, which uses INVALID_REFERENCE as specified.
Cause	Error code	Example message
Input is not an object	INVALID_PLAN	plan must be a JSON object, got list
Invalid JSON string	INVALID_PLAN	plan is not valid JSON: ...
Unknown top-level field	INVALID_PLAN	unknown top-level fields: ['verified']
Both call and steps	INVALID_PLAN	plan cannot have both 'call' and 'steps'
Neither call nor steps	INVALID_PLAN	plan must have either 'call' or 'steps'
Empty or non-string call	INVALID_PLAN	'call' must be a non-empty string
with is not an object	INVALID_PLAN	'with' must be an object
Step missing ID	INVALID_PLAN	'id' must be a non-empty string
Duplicate step ID	INVALID_PLAN	duplicate step id: 'a'
Invalid step ID format	INVALID_PLAN	invalid step id in $ref: '...'
Forward reference	INVALID_PLAN	$ref points to a non-earlier step: 'b'
Malformed $ref	INVALID_REFERENCE	reference must be of the form {'$ref': ...}
Unsupported version	INVALID_PLAN	unsupported plan version: '2'
max_bytes exceeded	INVALID_PLAN	plan exceeds max_bytes (...)
max_steps exceeded	INVALID_PLAN	plan exceeds max_steps (...)
max_depth exceeded	INVALID_PLAN	plan exceeds max_depth (...)
Serialization failure	INVALID_PLAN	plan could not be serialized: ...


Every listed failure stops the plan before any handler is considered.
9. Beyond 0.1.0
The following features are reserved for later versions and are not specified here:
- Computed references, such as amount = quantity * price. The model must rely on a capability that computes the value.
- Conditional steps (if/then). Plans are linear.
- Parallel branches. Execution is sequential.
- Iteration, such as mapping a step over a list.
These would extend the plan language, and each would require its own ADR.