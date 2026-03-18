# Policy Supervisor: Semantics, Rollout, and Security

This document describes the current behavior of the ClawGuard policy-supervisor stack as implemented in the shared runtime/simulator engine.

## 1. Stages

The stack currently reasons about multiple OpenClaw stages:

- `llm_input`
- `llm_output`
- `before_tool_call`
- `after_tool_call`
- `message_sending`

Not every stage is equally enforceable.

### Enforce-capable vs audit-only

- `before_tool_call` — enforce-capable
- `message_sending` — enforce-capable
- `llm_output` — currently audit-oriented; useful for review/logging, but not a strong enforcement point by itself
- `llm_input` / `after_tool_call` — primarily context capture / audit

## 2. Shared decision engine

Both the runtime plugin and the simulator use the same shared policy engine.

That engine is responsible for:

- selecting applicable rules
- evaluating deterministic rules
- calling the supervisor LLM only when needed
- merging deterministic + supervisor decisions
- resolving effective mode defaults
- applying timeout defaults

This removes the earlier drift where simulator and runtime could behave differently on the same input.

## 3. Decision order

For an enforce-capable stage such as `before_tool_call`:

1. load rules
2. select rules for stage/tool
3. run deterministic checks
4. if deterministic result is already non-`allow`, stop
5. otherwise call supervisor if matching LLM rules exist
6. merge to final decision
7. enforce only if effective mode is `enforce`

### Why the short-circuit matters

If a destructive command is already caught deterministically, the supervisor is no longer asked to second-guess it. This improves:

- runtime/simulator parity
- cost
- latency
- predictability

## 4. Effective mode resolution

The effective mode is resolved in this order:

1. explicit plugin config mode
2. rule defaults (`defaults.mode` in `SUPERVISOR_RULES.md`)
3. fallback to `audit`

This lets rules define a baseline without forcing every deployment to duplicate the setting in config.

## 5. Timeout and supervisor-failure semantics

Rules can define stage-family timeout behavior:

- `defaults.onTimeout.tool`
- `defaults.onTimeout.outbound`
- `defaults.onTimeout.output`
- optional generic fallback

Examples:

- tool timeout → `confirm`
- outbound timeout → `revise`
- output timeout → `allow`

### Important normalization

For tool calls, `revise` is normalized to `confirm`.

Reason: a tool call cannot be rewritten safely in the same way as an outgoing text message.

## 6. Audit vs enforce

### Audit mode

In `audit` mode, ClawGuard still computes rich policy decisions:

- `allow`
- `revise`
- `confirm`
- `block`

But these are advisory unless the stage is enforce-capable **and** the effective mode is `enforce`.

### Enforce mode

In `enforce` mode:

- tool calls can be blocked or forced into an explicit-confirm path
- outgoing messages can be replaced with a safer confirmation/revision prompt

## 7. Simulator output fields

The simulator exposes the fields most useful for rollout decisions:

- `mode`
- `enforced`
- `wouldEnforce`
- `wouldExecute`
- `deterministicDecision`
- `supervisorDecision`
- `finalDecision`
- `matchedRuleIds`
- `supervisorError`
- `onTimeout`

These are meant to answer slightly different questions:

- what policy concluded
- what layer concluded it
- whether the runtime would actually stop/alter the action
- what would happen if the supervisor timed out or failed

## 8. Web server security

The bundled web server is intentionally narrow.

### Static content

Only allowlisted routes are served:

- `/`
- `/web/policy-supervisor/index.html`
- `/web/policy-supervisor/simulate.html`

### Protected routes

These require a bearer token when `POLICY_SUPERVISOR_WEB_TOKEN` is set:

- `/logs/policy-supervisor.jsonl`
- `/api/policy-supervisor/simulate`

### Limits

- request body size limit
- simulator subprocess timeout
- safer default bind address (`127.0.0.1` in code)

## 9. Suggested deployment pattern

For personal or small-team use:

1. start in `audit`
2. inspect logs and simulator output for a while
3. tighten deterministic rules first for obvious high-confidence cases
4. only then consider `enforce` for selected paths
5. keep the web UI behind a token and preferably behind Tailscale/LAN rather than open Internet exposure

## 10. Current limitations

ClawGuard is materially stronger than the initial MVP, but some earlier review criticisms still apply:

- the deterministic layer is still mostly heuristics/regex-driven, not deep semantic parsing
- the supervisor is still prompt-based rather than backed by a typed policy IR or proofs
- `llm_output` supervision is useful but not a full, hard enforcement boundary
- this is still better framed as a compact operator/audit layer than as a state-of-the-art policy platform
