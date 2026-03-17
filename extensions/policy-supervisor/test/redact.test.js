import test from "node:test";
import assert from "node:assert/strict";

import { redactText, truncateText } from "../src/redact.js";

test("redactText hides common secret patterns", () => {
  const redacted = redactText("token=sk-abc1234567890 and OPENAI_API_KEY=shhh");
  assert.equal(redacted.includes("[REDACTED]"), true);
  assert.equal(redacted.includes("sk-abc1234567890"), false);
});

test("truncateText shortens long text", () => {
  const truncated = truncateText("x".repeat(50), 10);
  assert.match(truncated, /truncated/);
});
