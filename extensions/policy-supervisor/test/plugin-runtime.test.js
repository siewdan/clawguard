import test from "node:test";
import assert from "node:assert/strict";

import { createPluginRuntime } from "../src/plugin.js";

function createHarness(overrides = {}) {
  const hooks = {};
  const audits = [];
  const supervisorCalls = [];
  const api = {
    logger: {
      warn() {},
      info() {},
      debug() {},
    },
    on(name, handler) {
      hooks[name] = handler;
    },
  };

  const config = {
    workspaceDir: "/tmp/workspace",
    rulesPath: "/tmp/workspace/policies/SUPERVISOR_RULES.md",
    auditLogPath: "/tmp/workspace/logs/policy-supervisor.jsonl",
    mode: "enforce",
    redactSecrets: true,
    checkLlmInput: true,
    checkLlmOutput: true,
    checkToolCalls: true,
    checkOutgoingMessages: true,
    failClosedTools: new Set(["exec", "write", "edit", "sessions_send"]),
    maxContextChars: 6000,
    timeoutMs: 1500,
    supervisor: {
      enabled: true,
      baseUrl: "https://example.test/v1",
      model: "test-model",
      apiKey: "secret",
      headers: {},
      timeoutMs: 1000,
    },
    ...(overrides.config ?? {}),
  };

  const rules = overrides.rules ?? {
    version: 1,
    defaults: {},
    rules: [
      {
        id: "no-delete-without-confirm",
        enabled: true,
        stage: "before_tool_call",
        mode: "deterministic",
        tools: ["exec", "write", "edit"],
      },
      {
        id: "ask-when-ambiguous",
        enabled: true,
        stage: "before_tool_call",
        mode: "llm",
        tools: ["exec"],
      },
      {
        id: "protect-private-context",
        enabled: true,
        stage: "message_sending",
        mode: "deterministic",
      },
      {
        id: "review-assistant-output",
        enabled: true,
        stage: "llm_output",
        mode: "llm",
      },
    ],
  };

  const runtime = createPluginRuntime(api, {
    resolvePluginConfig: () => config,
    loadRules: async () => rules,
    callSupervisor: async (payload) => {
      supervisorCalls.push(payload);
      if (typeof overrides.callSupervisor === "function") {
        return await overrides.callSupervisor(payload);
      }
      return { decision: "allow", violatedRules: [], reason: "", safeUserMessage: "" };
    },
    writeAuditEvent: async (_path, event) => {
      audits.push(event);
      return event;
    },
  });

  runtime.register();
  return { api, hooks, audits, supervisorCalls, config };
}

test("before_tool_call blocks deterministic destructive commands in enforce mode", async () => {
  const { hooks } = createHarness();

  const result = await hooks.before_tool_call(
    { toolName: "exec", params: { command: "rm -rf tmp/cache" }, runId: "run-1" },
    { sessionKey: "main", sessionId: "sess-1" },
  );

  assert.equal(result.block, true);
  assert.match(result.blockReason, /destruktiv|wirklich/i);
});

test("before_tool_call allows deterministic violations in audit mode", async () => {
  const { hooks } = createHarness({ config: { mode: "audit" } });

  const result = await hooks.before_tool_call(
    { toolName: "exec", params: { command: "rm -rf tmp/cache" }, runId: "run-1" },
    { sessionKey: "main", sessionId: "sess-1" },
  );

  assert.equal(result, undefined);
});

test("llm_input stores run context and supervisor can review an ambiguous tool call", async () => {
  const { hooks, supervisorCalls } = createHarness({
    callSupervisor: async () => ({
      decision: "confirm",
      violatedRules: ["ask-when-ambiguous"],
      reason: "Ambiguous destructive intent.",
      safeUserMessage: "Bitte bestätige diesen riskanten Schritt.",
    }),
  });

  await hooks.llm_input({
    runId: "run-42",
    sessionId: "sess-1",
    provider: "openai",
    model: "gpt-5.4",
    prompt: "Räum mal auf, aber sei vorsichtig.",
    historyMessages: [{ role: "user", content: "Räum mal auf" }],
  });

  const result = await hooks.before_tool_call(
    { toolName: "exec", params: { command: "chmod 644 notes.txt" }, runId: "run-42" },
    { sessionKey: "main", sessionId: "sess-1" },
  );

  assert.equal(result.block, true);
  assert.equal(supervisorCalls.length, 1);
  assert.match(JSON.stringify(supervisorCalls[0].payload), /Räum mal auf/);
});

test("message_sending revises obvious secret leakage", async () => {
  const { hooks } = createHarness();

  const result = await hooks.message_sending(
    { to: "chat", content: "OPENAI_API_KEY=secret and path /home/raspi/.openclaw/workspace/MEMORY.md" },
    { channelId: "telegram", conversationId: "chat" },
  );

  assert.equal(typeof result.content, "string");
  assert.match(result.content, /nicht senden|private Informationen/i);
});

test("llm_output triggers supervisor audit", async () => {
  const { hooks, supervisorCalls } = createHarness({
    callSupervisor: async () => ({
      decision: "revise",
      violatedRules: ["review-assistant-output"],
      reason: "Looks risky",
      safeUserMessage: "",
    }),
  });

  await hooks.llm_input({
    runId: "run-7",
    sessionId: "sess-7",
    provider: "openai",
    model: "gpt-5.4",
    prompt: "User prompt",
    historyMessages: [],
  });

  await hooks.llm_output({
    runId: "run-7",
    sessionId: "sess-7",
    provider: "openai",
    model: "gpt-5.4",
    assistantTexts: ["Hier ist eine Antwort."],
  });

  assert.equal(supervisorCalls.length, 1);
  assert.equal(supervisorCalls[0].stage, "llm_output");
});
