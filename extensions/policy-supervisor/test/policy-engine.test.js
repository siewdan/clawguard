import test from "node:test";
import assert from "node:assert/strict";

import { evaluatePolicyDecision, resolveEffectivePolicyConfig } from "../src/policy-engine.js";

const baseCfg = {
  mode: undefined,
  modeExplicit: false,
  timeoutMs: 1500,
  redactSecrets: true,
  supervisor: { enabled: true, timeoutMs: 1000 },
};

test("resolveEffectivePolicyConfig honors rules defaults mode and timeout", () => {
  const cfg = resolveEffectivePolicyConfig(baseCfg, { mode: 'enforce', onTimeout: { tool: 'confirm', outbound: 'revise' } });
  assert.equal(cfg.effectiveMode, 'enforce');
  assert.equal(cfg.onTimeout.tool, 'confirm');
  assert.equal(cfg.onTimeout.outbound, 'revise');
});

test("evaluatePolicyDecision skips supervisor when deterministic decision already blocks", async () => {
  let called = false;
  const result = await evaluatePolicyDecision({
    cfg: { ...baseCfg, mode: 'audit', modeExplicit: true },
    rules: [
      { id: 'no-delete-without-confirm', enabled: true, stage: 'before_tool_call', mode: 'deterministic', tools: ['exec'] },
      { id: 'ask-when-ambiguous', enabled: true, stage: 'before_tool_call', mode: 'llm', tools: ['exec'] },
    ],
    input: {
      stage: 'before_tool_call',
      toolName: 'exec',
      params: { command: 'rm -rf tmp/cache' },
      supervisorPayload: { toolName: 'exec', params: { command: 'rm -rf tmp/cache' } },
    },
    callSupervisorImpl: async () => { called = true; return { decision: 'allow', violatedRules: [] }; },
  });

  assert.equal(result.finalDecision, 'confirm');
  assert.equal(called, false);
});

test("evaluatePolicyDecision applies timeout policy for outbound in enforce mode", async () => {
  const result = await evaluatePolicyDecision({
    cfg: { ...baseCfg, mode: 'enforce', modeExplicit: true },
    rules: [
      { id: 'review-assistant-output', enabled: true, stage: 'message_sending', mode: 'llm', tools: [] },
    ],
    input: {
      stage: 'message_sending',
      content: 'hello',
      supervisorPayload: { content: 'hello' },
      rulesDefaults: { onTimeout: { outbound: 'revise' } },
    },
    callSupervisorImpl: async () => { throw new Error('timeout'); },
  });

  assert.equal(result.finalDecision, 'revise');
  assert.equal(result.wouldEnforce, true);
  assert.equal(result.supervisorError, 'timeout');
});
