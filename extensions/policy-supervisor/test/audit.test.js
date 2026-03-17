import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { writeAuditEvent } from "../src/audit.js";

test("writeAuditEvent appends JSONL records", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "policy-supervisor-audit-"));
  const file = path.join(dir, "audit.jsonl");

  const record = await writeAuditEvent(file, { stage: "test", decision: "allow" });
  const content = await readFile(file, "utf8");

  assert.equal(record.stage, "test");
  assert.match(content, /"stage":"test"/);
});
