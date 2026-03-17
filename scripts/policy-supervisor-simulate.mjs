#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolvePluginConfig } from '../extensions/policy-supervisor/src/config.js';
import { loadRules } from '../extensions/policy-supervisor/src/rules.js';
import { simulatePolicyDecision } from '../extensions/policy-supervisor/src/simulate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const openclawConfigPath = process.env.OPENCLAW_CONFIG || path.join(os.homedir(), '.openclaw', 'openclaw.json');

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function buildInput(args, stdinJson) {
  if (stdinJson) return stdinJson;
  const params = args.params ? JSON.parse(args.params) : {};
  if (args.command) params.command = args.command;
  if (args.path) params.path = args.path;
  return {
    stage: args.stage || 'before_tool_call',
    toolName: args.tool || 'exec',
    params,
    content: args.content || '',
    prompt: args.prompt || '',
  };
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const stdinRaw = process.stdin.isTTY ? '' : await readStdin();
  const stdinJson = stdinRaw.trim() ? JSON.parse(stdinRaw) : null;
  const input = buildInput(args, stdinJson);

  const openclawConfig = JSON.parse(await fs.readFile(openclawConfigPath, 'utf8'));
  const pluginConfig = openclawConfig?.plugins?.entries?.['policy-supervisor']?.config || {};
  const cfg = resolvePluginConfig({ config: openclawConfig, pluginConfig });
  const ruleset = await loadRules(path.join(repoRoot, 'policies', 'SUPERVISOR_RULES.md'));

  const result = await simulatePolicyDecision({
    cfg: { ...cfg, rulesPath: path.join(repoRoot, 'policies', 'SUPERVISOR_RULES.md') },
    rules: ruleset.rules,
    input,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
