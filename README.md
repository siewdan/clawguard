# ClawGuard

ClawGuard is a compact policy-supervisor stack for OpenClaw. It combines:

- deterministic checks for obvious risky cases
- an optional supervisor LLM for ambiguous cases
- JSONL audit logging
- a simulator CLI/UI for safe policy testing
- a small web UI for reviewing live decisions

It is currently strongest as an **audit-first operator tool** rather than a full-blown policy platform.

## Install the plugin

The repo is designed to work against a live OpenClaw workspace.

### 1. Make the plugin available in the workspace

Typical local layout:

- repo checkout: `~/clawguard`
- live OpenClaw workspace: `~/.openclaw/workspace`

The simplest setup is to expose the plugin inside the workspace via symlink:

```bash
mkdir -p ~/.openclaw/workspace/extensions
ln -s ~/clawguard/extensions/policy-supervisor ~/.openclaw/workspace/extensions/policy-supervisor
```

### 2. Place the rules file where the plugin expects it

By default the plugin resolves rules relative to the OpenClaw workspace:

- default rules path: `./policies/SUPERVISOR_RULES.md`
- default audit log path: `./logs/policy-supervisor.jsonl`

Typical setup:

```bash
mkdir -p ~/.openclaw/workspace/policies
cp ~/clawguard/policies/SUPERVISOR_RULES.md ~/.openclaw/workspace/policies/SUPERVISOR_RULES.md
```

### 3. Enable/configure the plugin in OpenClaw

The plugin id is:

- `policy-supervisor`

Important config fields are defined in:

- `extensions/policy-supervisor/openclaw.plugin.json`

The most important ones are:

- `rulesPath`
- `auditLogPath`
- `mode`
- `supervisor.*`
- `checkToolCalls`
- `checkOutgoingMessages`

### 4. Run it in `audit` first

That is the intended rollout.

Even if rules return `confirm`, `revise`, or `block`, audit mode lets you inspect behavior before you start enforcing it.

---

## Where and how to write rules

Rules live in:

- `policies/SUPERVISOR_RULES.md`

The current MVP deliberately stores the machine-readable rules as a JSON block inside Markdown.

### Structure

The file has two parts:

1. `defaults`
2. `rules`

Example:

```json
{
  "version": 1,
  "defaults": {
    "mode": "enforce",
    "onTimeout": {
      "tool": "confirm",
      "outbound": "revise"
    }
  },
  "rules": [
    {
      "id": "no-delete-without-confirm",
      "enabled": true,
      "stage": "before_tool_call",
      "tools": ["exec", "write", "edit"],
      "mode": "deterministic",
      "action": "confirm",
      "severity": "high",
      "description": "Never delete or overwrite files without explicit confirmation."
    }
  ]
}
```

### What the main fields mean

- `defaults.mode`
  - baseline mode if plugin config does **not** set an explicit mode
  - typical values: `audit`, `enforce`

- `defaults.onTimeout.*`
  - fallback behavior when the supervisor LLM errors or times out
  - currently used stage families:
    - `tool`
    - `outbound`
    - `output`

- `stage`
  - where the rule applies
  - current practical values include:
    - `before_tool_call`
    - `message_sending`
    - `llm_output`

- `mode`
  - how the rule is evaluated
  - `deterministic` = code-based checks
  - `llm` = supervisor-model review

- `action`
  - intended policy outcome
  - one of:
    - `allow`
    - `revise`
    - `confirm`
    - `block`

- `tools`
  - optional tool filter for tool-call stages

### Important current limitation

The rules are only **partly declarative** right now.

They configure a lot, but some deterministic semantics still live in code paths such as `deterministic.js` by `rule.id`. So the rules are useful and compact, but they are not yet a fully generic policy DSL.

---

## How to test rules

You should test rules in three different ways.

### 1. Unit tests

```bash
cd ~/clawguard/extensions/policy-supervisor
node --test
```

This verifies the plugin/runtime behavior, shared policy engine, simulator behavior, and config handling.

### 2. CLI simulator

Useful for quick single cases:

```bash
node ~/clawguard/scripts/policy-supervisor-simulate.mjs \
  --tool exec \
  --command 'rm -rf tmp/cache' \
  --prompt 'Delete the cache directory'
```

You can also pipe JSON into it for larger suites:

```bash
echo '{"stage":"before_tool_call","toolName":"exec","params":{"command":"rm -rf tmp/cache"},"prompt":"Delete the cache directory"}' \
  | node ~/clawguard/scripts/policy-supervisor-simulate.mjs
```

### 3. Simulator UI

If the web service is running:

- `http://127.0.0.1:18891/web/policy-supervisor/simulate.html`

This is useful when you want to compare `finalDecision`, `wouldEnforce`, and `matchedRuleIds` without executing anything.

---

## What the status fields mean

The simulator reports several fields that answer different questions.

### `mode`
The **effective mode** for this evaluation.

Resolution order:
1. explicit plugin config
2. rules default (`defaults.mode`)
3. fallback `audit`

### `enforced`
Whether the current stage is an enforce-capable stage **and** the effective mode is `enforce`.

This is broader than the final decision itself. It tells you whether this path is generally operating as an enforcing path.

### `finalDecision`
The merged policy outcome after combining:

- deterministic result
- supervisor result, if any

Possible values:
- `allow`
- `revise`
- `confirm`
- `block`

### `wouldEnforce`
Whether this specific result would actually be enforced.

Examples:
- in `audit` mode, `finalDecision: block` can still have `wouldEnforce: false`
- in `enforce` mode on `before_tool_call`, `finalDecision: confirm` usually means `wouldEnforce: true`

### `wouldExecute`
Whether the underlying action would still go through.

This is effectively the operator-facing inverse of `wouldEnforce`.

- `wouldExecute: true` means the action would still proceed
- `wouldExecute: false` means ClawGuard would stop/alter it

### `deterministicDecision`
What the deterministic layer concluded.

This is important because ClawGuard now short-circuits: if deterministic already returns a non-`allow` decision, the supervisor is not called for that case.

### `supervisorDecision`
What the supervisor model concluded, if it was called.

If this is missing/`allow`, it can mean either:
- no matching LLM rule applied
- deterministic already decided the case
- or the supervisor allowed it

### `matchedRuleIds`
Which rules contributed to the result.

This is usually the fastest way to understand *why* a decision happened.

### `supervisorError`
If the supervisor failed or timed out, the error is surfaced here.

The final behavior in that case comes from `defaults.onTimeout.*`.

### `onTimeout`
The resolved timeout behavior that applied to this simulation.

This helps you verify fallback semantics directly instead of inferring them from config/rules by hand.

---

## Core decision model

Runtime plugin and simulator now use the same shared policy engine.

### Evaluation order

1. select matching rules for the current stage/tool
2. run deterministic checks first
3. if deterministic is already non-`allow`, stop there
4. otherwise call the supervisor LLM for matching LLM rules
5. merge to a final decision
6. enforce only when mode/stage allow enforcement

This removes the earlier drift between simulator and runtime.

### Audit vs enforce

A result like `block` or `confirm` does **not** automatically mean ClawGuard blocked anything.

You always need to read it together with:

- `mode`
- `wouldEnforce`
- `wouldExecute`

That is the difference between:
- “policy says this is bad”
- and “runtime would actually stop it”

---

## Web UI

Default local URLs:

- Logs UI: `http://127.0.0.1:18891/web/policy-supervisor/index.html`
- Simulator UI: `http://127.0.0.1:18891/web/policy-supervisor/simulate.html`

The browser pages prompt for the ClawGuard access token when needed, then store it in `localStorage` and send it automatically on later requests.

---

## Web security model

The web server is intentionally small and restrictive.

### Static routes

Only allowlisted static routes are served:

- `/`
- `/web/policy-supervisor/index.html`
- `/web/policy-supervisor/simulate.html`

### Protected routes

These require a bearer token when `POLICY_SUPERVISOR_WEB_TOKEN` is set:

- `/logs/policy-supervisor.jsonl`
- `/api/policy-supervisor/simulate`

### Other protections

- request body size limit
- simulator subprocess timeout
- default bind address in code is `127.0.0.1`

### Access token config

The example service reads:

- `~/.config/policy-supervisor-web.env`

Typical values:

```bash
POLICY_SUPERVISOR_WEB_BIND=0.0.0.0
POLICY_SUPERVISOR_WEB_PORT=18891
POLICY_SUPERVISOR_MAX_REQUEST_BYTES=65536
POLICY_SUPERVISOR_WEB_TOKEN=...
```

Do **not** commit the real token.

---

## Deploy / systemd

Example unit:

- `deploy/systemd-user/policy-supervisor-web.service`

Typical flow:

```bash
cp ~/clawguard/deploy/systemd-user/policy-supervisor-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now policy-supervisor-web.service
```

For manual launching, use:

```bash
~/clawguard/scripts/serve-policy-supervisor-web.sh
```

That launcher also loads `~/.config/policy-supervisor-web.env` when present.

---

## More detail

See `docs/policy-supervisor.md` for:

- stage semantics
- timeout semantics
- audit/enforce behavior
- deployment guidance
- current limitations

## License

MIT — see `LICENSE`.
