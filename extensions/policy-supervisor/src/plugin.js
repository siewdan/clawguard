import { resolvePluginConfig } from "./config.js";
import { loadRules } from "./rules.js";
import { selectRules } from "./selectors.js";
import { evaluateDeterministicDecision } from "./deterministic.js";
import { callSupervisor } from "./supervisor-client.js";
import { writeAuditEvent } from "./audit.js";
import { redactText, truncateText } from "./redact.js";

function safeSerialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeRules(rules) {
  return rules.map((rule) => ({
    id: rule.id,
    action: rule.action,
    severity: rule.severity,
    description: rule.description,
  }));
}

function decisionToToolResult(decision) {
  if (!decision || decision.decision === "allow") return undefined;
  return {
    block: true,
    blockReason:
      decision.safeUserMessage || decision.reason || "Policy supervisor blocked this tool call.",
  };
}

function decisionToOutgoingResult(decision) {
  if (!decision || decision.decision === "allow") return undefined;
  if (decision.decision === "block") {
    return {
      content:
        decision.safeUserMessage ||
        "I can't send this message as-is because it may violate the active policy rules.",
    };
  }
  if (decision.decision === "confirm" || decision.decision === "revise") {
    return {
      content:
        decision.safeUserMessage ||
        "I'm not confident I should send this as-is. Do you want me to proceed?",
    };
  }
  return undefined;
}

function normalizeDecisionForTool(decision) {
  if (!decision) return null;
  if (decision.decision === "revise") {
    return { ...decision, decision: "confirm" };
  }
  return decision;
}

function makeSafeText(text, cfg, maxChars = cfg.maxContextChars) {
  const asString = typeof text === "string" ? text : safeSerialize(text);
  const maybeRedacted = cfg.redactSecrets ? redactText(asString) : asString;
  return truncateText(maybeRedacted, maxChars);
}

function pickFirstString(obj, names) {
  for (const name of names) {
    const value = obj?.[name];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function extractToolAuditFields(toolName, params, cfg) {
  const command = pickFirstString(params, ["command"]);
  const path = pickFirstString(params, ["path", "file_path"]);
  const target = pickFirstString(params, ["url", "to", "label", "sessionKey", "sessionId"]);
  const content = pickFirstString(params, ["content", "newText", "new_string"]);
  const oldText = pickFirstString(params, ["oldText", "old_string"]);
  const serializedParams = makeSafeText(safeSerialize(params ?? {}), cfg, 20000);

  return {
    toolName,
    toolContext: makeSafeText(command || path || target || toolName, cfg, 4000),
    command: command ? makeSafeText(command, cfg, 20000) : undefined,
    path: path ? makeSafeText(path, cfg, 4000) : undefined,
    target: target ? makeSafeText(target, cfg, 4000) : undefined,
    contentPreview: content ? makeSafeText(content, cfg, 1500) : undefined,
    contentLength: typeof content === "string" ? content.length : undefined,
    oldTextLength: typeof oldText === "string" ? oldText.length : undefined,
    toolParamsJson: serializedParams,
  };
}

function extractResultAuditFields(result, cfg) {
  if (result == null) {
    return { resultPreview: undefined, resultJson: undefined };
  }
  const serialized = makeSafeText(safeSerialize(result), cfg, 20000);
  return {
    resultPreview: makeSafeText(serialized, cfg, 1500),
    resultJson: serialized,
  };
}

export function createPluginRuntime(api, deps = {}) {
  const resolveConfigImpl = deps.resolvePluginConfig ?? resolvePluginConfig;
  const loadRulesImpl = deps.loadRules ?? loadRules;
  const selectRulesImpl = deps.selectRules ?? selectRules;
  const evaluateDeterministicImpl = deps.evaluateDeterministicDecision ?? evaluateDeterministicDecision;
  const callSupervisorImpl = deps.callSupervisor ?? callSupervisor;
  const writeAuditEventImpl = deps.writeAuditEvent ?? writeAuditEvent;
  const cfg = resolveConfigImpl(api);

  const state = {
    rulesPromise: null,
    runContextByRunId: new Map(),
  };

  async function ensureRules() {
    if (!state.rulesPromise) {
      state.rulesPromise = loadRulesImpl(cfg.rulesPath).catch((error) => {
        api.logger?.warn?.(`policy-supervisor: failed to load rules (${error.message})`);
        return { version: 1, defaults: {}, rules: [] };
      });
    }
    return await state.rulesPromise;
  }

  async function audit(event) {
    try {
      await writeAuditEventImpl(cfg.auditLogPath, event);
    } catch (error) {
      api.logger?.warn?.(`policy-supervisor: failed to write audit event (${error.message})`);
    }
  }

  function pruneRunCache() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [runId, value] of state.runContextByRunId) {
      if ((value?.ts ?? 0) < cutoff) {
        state.runContextByRunId.delete(runId);
      }
    }
  }

  function storeRunContext(event) {
    if (!event?.runId) return;
    pruneRunCache();
    state.runContextByRunId.set(event.runId, {
      ts: Date.now(),
      prompt: makeSafeText(event.prompt ?? "", cfg, 8000),
      historyMessages: makeSafeText(safeSerialize(event.historyMessages ?? []), cfg, 20000),
      sessionId: event.sessionId,
      provider: event.provider,
      model: event.model,
    });
  }

  function buildToolPayload(event, ctx, runContext, rules) {
    return {
      toolName: event.toolName,
      params: cfg.redactSecrets
        ? redactText(safeSerialize(event.params ?? {}))
        : safeSerialize(event.params ?? {}),
      runContext,
      sessionKey: ctx?.sessionKey,
      sessionId: ctx?.sessionId,
      rules: summarizeRules(rules),
    };
  }

  function buildOutputPayload(event, runContext, rules) {
    return {
      assistantTexts: Array.isArray(event.assistantTexts)
        ? event.assistantTexts.map((value) => makeSafeText(value, cfg, 8000))
        : [],
      runContext,
      provider: event.provider,
      model: event.model,
      rules: summarizeRules(rules),
    };
  }

  function buildOutgoingPayload(event, ctx, rules) {
    return {
      content: makeSafeText(event.content ?? "", cfg, 8000),
      to: event.to,
      channelId: ctx?.channelId,
      conversationId: ctx?.conversationId,
      rules: summarizeRules(rules),
    };
  }

  return {
    register() {
      if (cfg.checkLlmInput) {
        api.on("llm_input", async (event) => {
          storeRunContext(event);
          await audit({
            stage: "llm_input",
            runId: event.runId,
            sessionId: event.sessionId,
            provider: event.provider,
            model: event.model,
            prompt: makeSafeText(event.prompt ?? "", cfg, 8000),
            historyMessages: makeSafeText(safeSerialize(event.historyMessages ?? []), cfg, 20000),
          });
        });
      }

      if (cfg.checkLlmOutput) {
        api.on("llm_output", async (event) => {
          const ruleset = await ensureRules();
          const rules = selectRulesImpl(ruleset.rules, { stage: "llm_output", mode: "llm" });
          const runContext = state.runContextByRunId.get(event.runId);
          let supervisorDecision = null;

          if (rules.length > 0) {
            try {
              supervisorDecision = await callSupervisorImpl({
                config: {
                  ...cfg.supervisor,
                  enabled: cfg.supervisor.enabled && rules.length > 0,
                  timeoutMs: cfg.supervisor.timeoutMs ?? cfg.timeoutMs,
                },
                stage: "llm_output",
                payload: buildOutputPayload(event, runContext, rules),
              });
            } catch (error) {
              supervisorDecision = { decision: "allow", reason: `supervisor error: ${error.message}` };
            }
          }

          await audit({
            stage: "llm_output",
            runId: event.runId,
            sessionId: event.sessionId,
            provider: event.provider,
            model: event.model,
            decision: supervisorDecision?.decision ?? "allow",
            reason: supervisorDecision?.reason ?? "",
            matchedRuleIds: supervisorDecision?.violatedRules ?? [],
            assistantTexts: Array.isArray(event.assistantTexts)
              ? event.assistantTexts.map((value) => makeSafeText(value, cfg, 8000))
              : [],
            prompt: runContext?.prompt,
            historyMessages: runContext?.historyMessages,
            usage: event.usage ?? undefined,
          });
        });
      }

      if (cfg.checkToolCalls) {
        api.on("before_tool_call", async (event, ctx) => {
          const ruleset = await ensureRules();
          const allRules = selectRulesImpl(ruleset.rules, {
            stage: "before_tool_call",
            toolName: event.toolName,
          });
          const runContext = event.runId ? state.runContextByRunId.get(event.runId) : undefined;
          const toolAudit = extractToolAuditFields(event.toolName, event.params ?? {}, cfg);

          const deterministicDecision = evaluateDeterministicImpl({
            stage: "before_tool_call",
            event,
            rules: allRules,
          });

          if (deterministicDecision.decision !== "allow") {
            await audit({
              stage: "before_tool_call",
              decisionSource: "deterministic",
              runId: event.runId,
              toolCallId: event.toolCallId,
              sessionId: ctx?.sessionId,
              sessionKey: ctx?.sessionKey,
              reason: deterministicDecision.reasons.join(" "),
              decision: deterministicDecision.decision,
              matchedRuleIds: deterministicDecision.matchedRuleIds,
              prompt: runContext?.prompt,
              historyMessages: runContext?.historyMessages,
              ...toolAudit,
            });
            if (cfg.mode === "enforce") {
              return decisionToToolResult(deterministicDecision);
            }
          }

          const llmRules = selectRulesImpl(allRules, { mode: "llm" });
          if (llmRules.length === 0) {
            return undefined;
          }

          try {
            const supervisorDecision = normalizeDecisionForTool(
              await callSupervisorImpl({
                config: {
                  ...cfg.supervisor,
                  enabled: cfg.supervisor.enabled,
                  timeoutMs: cfg.supervisor.timeoutMs ?? cfg.timeoutMs,
                },
                stage: "before_tool_call",
                payload: buildToolPayload(event, ctx, runContext, llmRules),
              }),
            );

            await audit({
              stage: "before_tool_call",
              decisionSource: "supervisor",
              runId: event.runId,
              toolCallId: event.toolCallId,
              sessionId: ctx?.sessionId,
              sessionKey: ctx?.sessionKey,
              decision: supervisorDecision?.decision ?? "allow",
              reason: supervisorDecision?.reason ?? "",
              matchedRuleIds: supervisorDecision?.violatedRules ?? [],
              safeUserMessage: supervisorDecision?.safeUserMessage ?? "",
              rulesChecked: summarizeRules(llmRules),
              prompt: runContext?.prompt,
              historyMessages: runContext?.historyMessages,
              ...toolAudit,
            });

            if (cfg.mode === "enforce") {
              return decisionToToolResult(supervisorDecision);
            }
          } catch (error) {
            await audit({
              stage: "before_tool_call",
              decisionSource: "supervisor",
              runId: event.runId,
              toolCallId: event.toolCallId,
              sessionId: ctx?.sessionId,
              sessionKey: ctx?.sessionKey,
              decision: "error",
              reason: error.message,
              matchedRuleIds: llmRules.map((rule) => rule.id),
              rulesChecked: summarizeRules(llmRules),
              prompt: runContext?.prompt,
              historyMessages: runContext?.historyMessages,
              ...toolAudit,
            });
            if (cfg.mode === "enforce" && cfg.failClosedTools.has(event.toolName)) {
              return {
                block: true,
                blockReason: "I'm not confident this risky step is safe yet. Please confirm it explicitly.",
              };
            }
          }

          return undefined;
        });

        api.on("after_tool_call", async (event, ctx) => {
          const toolAudit = extractToolAuditFields(event.toolName, event.params ?? {}, cfg);
          const resultAudit = extractResultAuditFields(event.result, cfg);
          const runContext = event.runId ? state.runContextByRunId.get(event.runId) : undefined;
          await audit({
            stage: "after_tool_call",
            runId: event.runId,
            toolCallId: event.toolCallId,
            sessionId: ctx?.sessionId,
            sessionKey: ctx?.sessionKey,
            durationMs: event.durationMs,
            error: event.error ?? "",
            prompt: runContext?.prompt,
            ...toolAudit,
            ...resultAudit,
          });
        });
      }

      if (cfg.checkOutgoingMessages) {
        api.on("message_sending", async (event, ctx) => {
          const ruleset = await ensureRules();
          const allRules = selectRulesImpl(ruleset.rules, { stage: "message_sending" });
          const deterministicDecision = evaluateDeterministicImpl({
            stage: "message_sending",
            event,
            rules: allRules,
          });

          if (deterministicDecision.decision !== "allow") {
            await audit({
              stage: "message_sending",
              decisionSource: "deterministic",
              decision: deterministicDecision.decision,
              reason: deterministicDecision.reasons.join(" "),
              matchedRuleIds: deterministicDecision.matchedRuleIds,
              channelId: ctx?.channelId,
              conversationId: ctx?.conversationId,
              to: event.to,
              content: makeSafeText(event.content ?? "", cfg, 8000),
            });
            if (cfg.mode === "enforce") {
              return decisionToOutgoingResult(deterministicDecision);
            }
          }

          const llmRules = selectRulesImpl(allRules, { mode: "llm" });
          if (llmRules.length === 0) {
            return undefined;
          }

          try {
            const supervisorDecision = await callSupervisorImpl({
              config: {
                ...cfg.supervisor,
                enabled: cfg.supervisor.enabled,
                timeoutMs: cfg.supervisor.timeoutMs ?? cfg.timeoutMs,
              },
              stage: "message_sending",
              payload: buildOutgoingPayload(event, ctx, llmRules),
            });

            await audit({
              stage: "message_sending",
              decisionSource: "supervisor",
              decision: supervisorDecision?.decision ?? "allow",
              reason: supervisorDecision?.reason ?? "",
              matchedRuleIds: supervisorDecision?.violatedRules ?? [],
              safeUserMessage: supervisorDecision?.safeUserMessage ?? "",
              channelId: ctx?.channelId,
              conversationId: ctx?.conversationId,
              to: event.to,
              content: makeSafeText(event.content ?? "", cfg, 8000),
            });

            if (cfg.mode === "enforce") {
              return decisionToOutgoingResult(supervisorDecision);
            }
          } catch (error) {
            await audit({
              stage: "message_sending",
              decisionSource: "supervisor",
              decision: "error",
              reason: error.message,
              matchedRuleIds: llmRules.map((rule) => rule.id),
              channelId: ctx?.channelId,
              conversationId: ctx?.conversationId,
              to: event.to,
              content: makeSafeText(event.content ?? "", cfg, 8000),
            });
          }

          return undefined;
        });
      }
    },
  };
}
