import test from "node:test";
import assert from "node:assert/strict";

import { __private__, callSupervisor } from "../src/supervisor-client.js";

test("extractJsonFromText handles fenced JSON", () => {
  const parsed = __private__.extractJsonFromText('```json\n{"decision":"allow"}\n```');
  assert.equal(parsed.decision, "allow");
});

test("callSupervisor parses OpenAI-compatible chat completions", async () => {
  const response = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            decision: "confirm",
            violatedRules: ["r1"],
            reason: "Needs confirmation",
            safeUserMessage: "Bitte bestätigen.",
            confidence: 0.9,
          }),
        },
      },
    ],
  };

  let capturedBody = null;
  const result = await callSupervisor({
    config: {
      enabled: true,
      baseUrl: "https://example.test/v1",
      model: "test-model",
      apiKey: "secret",
      timeoutMs: 1000,
      maxTokens: 512,
    },
    stage: "before_tool_call",
    payload: { hello: "world" },
    fetchImpl: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });

  assert.equal(result.decision, "confirm");
  assert.deepEqual(result.violatedRules, ["r1"]);
  assert.equal(result.safeUserMessage, "Bitte bestätigen.");
  assert.equal(capturedBody.max_tokens, 512);
});
