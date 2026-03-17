import test from "node:test";
import assert from "node:assert/strict";

import { simulatePolicyDecision } from "../src/simulate.js";

const cfg = {
  mode: 'audit',
  timeoutMs: 1500,
  supervisor: { enabled: true, timeoutMs: 1000 },
};

const rules = [
  { id: 'no-delete-without-confirm', enabled: true, stage: 'before_tool_call', mode: 'deterministic', tools: ['exec'] },
  { id: 'ask-when-ambiguous', enabled: true, stage: 'before_tool_call', mode: 'llm', tools: ['exec'] },
];

test('simulatePolicyDecision reports wouldExecute in audit mode', async () => {
  const result = await simulatePolicyDecision({
    cfg,
    rules,
    input: {
      stage: 'before_tool_call',
      toolName: 'exec',
      params: { command: 'rm -rf tmp/cache' },
      prompt: 'Delete the cache',
    },
    callSupervisorImpl: async () => ({
      decision: 'block',
      violatedRules: ['ask-when-ambiguous'],
      reason: 'Dangerous command',
    }),
  });

  assert.equal(result.mode, 'audit');
  assert.equal(result.finalDecision, 'block');
  assert.equal(result.wouldEnforce, false);
  assert.equal(result.wouldExecute, true);
  assert.ok(result.matchedRuleIds.includes('no-delete-without-confirm'));
  assert.ok(result.matchedRuleIds.includes('ask-when-ambiguous'));
});
