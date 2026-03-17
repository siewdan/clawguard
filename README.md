# ClawGuard

A policy-supervisor plugin stack for OpenClaw that audits and simulates prompts, tool calls, outputs, and outgoing messages against a compact rule set.

## What is included

- `extensions/policy-supervisor/` — plugin source + tests
- `policies/SUPERVISOR_RULES.md` — rule definitions
- `web/policy-supervisor/index.html` — log viewer UI
- `web/policy-supervisor/simulate.html` — simulation UI
- `scripts/policy-supervisor-simulate.mjs` — CLI simulator
- `scripts/policy-supervisor-web-server.py` — local web/API server
- `deploy/systemd-user/policy-supervisor-web.service` — user systemd service example

## Features

- Deterministic checks for common risky operations
- Supervisor-LLM review for fuzzy policy decisions
- JSONL audit logging
- Live log viewer with filtering and adjustable columns
- Safe simulation mode for larger test suites

## Audit mode vs enforce mode

The intended rollout starts in **audit** mode.

That means a result like `block` or `confirm` reflects what the supervisor **would** do, not necessarily what it **enforced**. The simulator makes this explicit via:

- `finalDecision`
- `wouldEnforce`
- `wouldExecute`

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

## Live integration notes

The repo is self-contained, but the simulator and log viewer are designed to inspect a live OpenClaw installation by default.

By default they expect:

- OpenClaw config at `~/.openclaw/openclaw.json`
- live audit log at `~/.openclaw/workspace/logs/policy-supervisor.jsonl`

You can override these with environment variables where supported.

## Web UI

- Logs UI: `http://127.0.0.1:18891/web/policy-supervisor/index.html`
- Simulator UI: `http://127.0.0.1:18891/web/policy-supervisor/simulate.html`

## Security note

The default web server has no authentication. Anyone who can reach the port can read logs and use the simulator API.

## License

MIT — see `LICENSE`.
