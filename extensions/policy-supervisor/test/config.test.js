import test from "node:test";
import assert from "node:assert/strict";

import { resolvePluginConfig } from "../src/config.js";

test("resolvePluginConfig uses workspace-relative defaults", () => {
  const cfg = resolvePluginConfig({
    config: { agents: { defaults: { workspace: "/tmp/workspace" } } },
    pluginConfig: {},
  });

  assert.equal(cfg.workspaceDir, "/tmp/workspace");
  assert.equal(cfg.rulesPath, "/tmp/workspace/policies/SUPERVISOR_RULES.md");
  assert.equal(cfg.auditLogPath, "/tmp/workspace/logs/policy-supervisor.jsonl");
  assert.equal(cfg.mode, undefined);
  assert.equal(cfg.modeExplicit, false);
  assert.equal(cfg.redactSecrets, true);
  assert.equal(cfg.failClosedTools.has("exec"), true);
});

test("resolvePluginConfig resolves supervisor api key from env", () => {
  process.env.TEST_SUPERVISOR_KEY = "secret-key";
  const cfg = resolvePluginConfig({
    config: { agents: { defaults: { workspace: "/tmp/workspace" } } },
    pluginConfig: {
      mode: "enforce",
      supervisor: {
        enabled: true,
        baseUrl: "https://example.test/v1/",
        model: "test-model",
        apiKeyEnv: "TEST_SUPERVISOR_KEY",
        maxTokens: 512,
      },
    },
  });

  assert.equal(cfg.mode, "enforce");
  assert.equal(cfg.modeExplicit, true);
  assert.equal(cfg.supervisor.enabled, true);
  assert.equal(cfg.supervisor.baseUrl, "https://example.test/v1");
  assert.equal(cfg.supervisor.apiKey, "secret-key");
  assert.equal(cfg.supervisor.maxTokens, 512);

  delete process.env.TEST_SUPERVISOR_KEY;
});
