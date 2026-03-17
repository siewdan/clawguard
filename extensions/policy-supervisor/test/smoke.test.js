import test from "node:test";
import assert from "node:assert/strict";

import register from "../index.js";

test("plugin registers expected hooks", async () => {
  const calls = [];
  const api = {
    on(name, handler) {
      calls.push([name, handler]);
    },
  };

  register(api);

  const names = calls.map(([name]) => name);
  assert.deepEqual(names, [
    "llm_input",
    "llm_output",
    "before_tool_call",
    "after_tool_call",
    "message_sending",
  ]);
  for (const [, handler] of calls) {
    assert.equal(typeof handler, "function");
  }
});
