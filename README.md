# ClawGuard

ClawGuard is a compact policy-supervisor stack for OpenClaw. It audits and simulates prompts, tool calls, model outputs, and outgoing messages against a small rule set, with a deterministic layer for obvious cases and an optional supervisor LLM for ambiguous ones.

## What is included

- `extensions/policy-supervisor/` — plugin source + tests
- `policies/SUPERVISOR_RULES.md` — rule definitions and defaults
- `web/policy-supervisor/index.html` — log viewer UI
- `web/policy-supervisor/simulate.html` — simulator UI
- `scripts/policy-supervisor-simulate.mjs` — CLI simulator
- `scripts/policy-supervisor-web-server.py` — local web/API server
- `scripts/serve-policy-supervisor-web.sh` — convenience launcher
- `deploy/systemd-user/policy-supervisor-web.service` — user systemd service example
- `docs/policy-supervisor.md` — semantics, rollout, security, and deployment notes

## Current status

ClawGuard is currently strongest as an **audit-first operator tool**:

- inspect decisions in live logs
- simulate policy outcomes safely
- roll out in `audit` before switching any path to `enforce`

The current live rollout is intentionally **audit-first**.

## Core decision model

For each stage, ClawGuard evaluates rules in a single shared engine used by both the runtime plugin and the simulator.

### Evaluation order

1. Select rules for the current stage/tool
2. Run deterministic checks first
3. If deterministic already returns a non-`allow` decision, stop there
4. Only call the supervisor LLM for still-ambiguous cases
5. Merge to a final decision

This means simulator and runtime now have the same short-circuit behavior.

### Effective mode

The effective mode comes from:

1. explicit plugin config, if set
2. otherwise rule defaults in `SUPERVISOR_RULES.md`
3. otherwise `audit`

### Timeout / supervisor-failure behavior

Rules can provide stage-aware defaults such as:

- `onTimeout.tool`
- `onTimeout.outbound`
- `onTimeout.output`

These defaults are applied by the shared policy engine, so simulator and runtime now handle supervisor failures consistently.

For tool calls, `revise` is normalized to `confirm`, because a tool call cannot be silently rewritten the way an outgoing message can.

### Audit vs enforce

A reported `finalDecision` is not the same thing as actual enforcement.

The simulator exposes the most important fields directly:

- `finalDecision` — the merged policy result
- `wouldEnforce` — whether that result would be enforced in the current mode/stage
- `wouldExecute` — whether the underlying action would still run
- `deterministicDecision` — deterministic layer result
- `supervisorDecision` — supervisor result, if any
- `matchedRuleIds` — rules that contributed to the result

In `audit` mode, `block` / `confirm` / `revise` still appear in logs and simulator output, but they represent what ClawGuard **would** do, not necessarily what it **did** enforce.

## Quick start

### Run tests

```bash
cd extensions/policy-supervisor
node --test
```

### Run the simulator from CLI

```bash
node scripts/policy-supervisor-simulate.mjs \
  --tool exec \
  --command 'rm -rf tmp/cache' \
  --prompt 'Delete the cache directory'
```

### Run the local web server

```bash
./scripts/serve-policy-supervisor-web.sh
```

## Web UI

Default local URLs:

- Logs UI: `http://127.0.0.1:18891/web/policy-supervisor/index.html`
- Simulator UI: `http://127.0.0.1:18891/web/policy-supervisor/simulate.html`

The browser pages prompt for the ClawGuard access token when needed, then store it in `localStorage` and attach it automatically on later requests.

## Web security model

The web server is now intentionally small and restrictive:

- only allowlisted static routes are served
- `/logs/policy-supervisor.jsonl` requires a bearer token
- `/api/policy-supervisor/simulate` requires a bearer token
- request bodies are size-limited
- simulator subprocesses are timeout-limited
- code defaults to binding `127.0.0.1`

### Access token

The example systemd service loads configuration from:

- `~/.config/policy-supervisor-web.env`

Typical settings:

```bash
POLICY_SUPERVISOR_WEB_BIND=0.0.0.0
POLICY_SUPERVISOR_WEB_PORT=18891
POLICY_SUPERVISOR_MAX_REQUEST_BYTES=65536
POLICY_SUPERVISOR_WEB_TOKEN=...
```

Do **not** commit the real token.

## Live integration notes

By default, the simulator and web server expect a live OpenClaw installation at:

- OpenClaw config: `~/.openclaw/openclaw.json`
- live audit log: `~/.openclaw/workspace/logs/policy-supervisor.jsonl`
- live policy workspace: `~/.openclaw/workspace`

These can be overridden through environment variables where supported.

## Deploy / systemd

Install or update the user service from:

- `deploy/systemd-user/policy-supervisor-web.service`

Typical flow:

```bash
cp deploy/systemd-user/policy-supervisor-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now policy-supervisor-web.service
```

For manual launching, `scripts/serve-policy-supervisor-web.sh` also loads `~/.config/policy-supervisor-web.env` when present.

## More detail

See `docs/policy-supervisor.md` for:

- stage semantics
- timeout semantics
- audit/enforce behavior
- web deployment and exposure guidance
- current known limitations

## License

MIT — see `LICENSE`.
