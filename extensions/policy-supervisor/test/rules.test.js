import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { extractRulesBlock, loadRules, parseRulesMarkdown } from "../src/rules.js";
import { selectRules } from "../src/selectors.js";

const sampleMarkdown = `# Rules\n\n\
\`\`\`json supervisor-rules
{ "version": 1, "rules": [{ "id": "r1", "stage": "before_tool_call", "mode": "deterministic" }] }
\`\`\`
`;

test("extractRulesBlock finds the machine-readable JSON block", () => {
  const block = extractRulesBlock(sampleMarkdown);
  assert.match(block, /"version": 1/);
});

test("parseRulesMarkdown normalizes rules", () => {
  const parsed = parseRulesMarkdown(sampleMarkdown);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0].enabled, true);
  assert.equal(parsed.rules[0].id, "r1");
});

test("loadRules reads the workspace policy file", async () => {
  const filePath = path.resolve("/home/raspi/.openclaw/workspace/policies/SUPERVISOR_RULES.md");
  const loaded = await loadRules(filePath);
  assert.ok(loaded.rules.length >= 3);
});

test("selectRules filters by stage, tool and mode", () => {
  const rules = [
    { id: "a", enabled: true, stage: "before_tool_call", mode: "deterministic", tools: ["exec"] },
    { id: "b", enabled: true, stage: "message_sending", mode: "deterministic", tools: [] },
    { id: "c", enabled: true, stage: "before_tool_call", mode: "llm", tools: ["write"] },
  ];

  const selected = selectRules(rules, { stage: "before_tool_call", toolName: "exec" });
  assert.deepEqual(selected.map((rule) => rule.id), ["a"]);

  const llmSelected = selectRules(rules, { stage: "before_tool_call", mode: "llm", toolName: "write" });
  assert.deepEqual(llmSelected.map((rule) => rule.id), ["c"]);
});
