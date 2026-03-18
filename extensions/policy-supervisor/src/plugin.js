import { resolvePluginConfig } from "./config.js";
import { loadRules } from "./rules.js";
import { writeAuditEvent } from "./audit.js";
import { redactText, truncateText } from "./redact.js";
import { callSupervisor } from "./supervisor-client.js";
import { evaluatePolicyDecision, summarizeRules } from "./policy-engine.js";

function safeSerialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
  const callSupervisorImpl = deps.callSupervisor ?? callSupervisor;
  const evaluatePolicyDecisionImpl = deps.evaluatePolicyDecision ?? evaluatePolicyDecision;
  const writeAuditEventImpl = deps.writeAuditEvent ?? writeAuditEvent;
  const cfg = resolveConfigImpl(api);

  const state = {
    rulesCache: null,
    runContextByRunId: new Map(),
  };

  async function ensureRules(forceReload = false) {
    if (!state.rulesCache || forceReload) {
      try {
        state.rulesCache = await loadRulesImpl(cfg.rulesPath);
      } catch (error) {
        api.logger?.warn?.(`policy-supervisor: failed to load rules (${error.message})`);
        throw error;
      }
    }
    return state.rulesCache;
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
    while (state.runContextByRunId.size > 500) {
      const oldest = state.runContextByRunId.keys().next().value;
      state.runContextByRunId.delete(oldest);
    }
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

  function buildToolSupervisorPayload(event, ctx, runContext, rules) {
    return {
      toolName: event.toolName,
      params: event.params ?? {},
      runContext,
      sessionKey: ctx?.sessionKey,
      sessionId: ctx?.sessionId,
      rules: summarizeRules(rules),
    };
  }

  function buildOutputSupervisorPayload(event, runContext, rules) {
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

  function buildOutgoingSupervisorPayload(event, ctx, rules) {
    return {
      content: event.content ?? "",
      to: event.to,
      channelId: ctx?.channelId,
      conversationId: ctx?.conversationId,
      rules: summarizeRules(rules),
    };
  }

  function baseAuditPayload(runContext, evaluation) {
    return {
      mode: evaluation.effectiveMode,
      enforceCapable: evaluation.enforceCapable,
      wouldEnforce: evaluation.wouldEnforce,
      wouldExecute: evaluation.wouldExecute,
      matchedRuleIds: evaluation.matchedRuleIds,
      supervisorError: evaluation.supervisorError || "",
      prompt: runContext?.prompt,
      historyMessages: runContext?.historyMessages,
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
          const runContext = state.runContextByRunId.get(event.runId);
          let ruleset;
          try {
            ruleset = await ensureRules();
          } catch (error) {
            await audit({
              stage: "llm_output",
              runId: event.runId,
              sessionId: event.sessionId,
              decision: "error",
              reason: `rules load error: ${error.message}`,
            });
            return;
          }

          const evaluation = await evaluatePolicyDecisionImpl({
            cfg,
            rules: ruleset.rules,
            input: {
              stage: "llm_output",
              runContext,
              rulesDefaults: ruleset.defaults,
              supervisorPayload: buildOutputSupervisorPayload(event, runContext, ruleset.rules),
              enforceCapable: false,
            },
            callSupervisorImpl,
          });

          await audit({
            stage: "llm_output",
            runId: event.runId,
            sessionId: event.sessionId,
            provider: event.provider,
            model: event.model,
            decision: evaluation.finalDecision,
            reason: evaluation.supervisorDecision?.reason ?? evaluation.deterministicDecision?.reasons?.join(" ") ?? "",
            assistantTexts: Array.isArray(event.assistantTexts)
              ? event.assistantTexts.map((value) => makeSafeText(value, cfg, 8000))
              : [],
            usage: event.usage ?? undefined,
            ...baseAuditPayload(runContext, evaluation),
          });
        });
      }

      if (cfg.checkToolCalls) {
        api.on("before_tool_call", async (event, ctx) => {
          const runContext = event.runId ? state.runContextByRunId.get(event.runId) : undefined;
          let ruleset;
          try {
            ruleset = await ensureRules();
          } catch (error) {
            await audit({
              stage: "before_tool_call",
              decisionSource: "rules",
              runId: event.runId,
              toolCallId: event.toolCallId,
              sessionId: ctx?.sessionId,
              sessionKey: ctx?.sessionKey,
              decision: "error",
              reason: `rules load error: ${error.message}`,
              ...extractToolAuditFields(event.toolName, event.params ?? {}, cfg),
            });
            if (cfg.mode === "enforce" && cfg.failClosedTools.has(event.toolName)) {
              return { block: true, blockReason: "Policy rules could not be loaded. Please confirm before continuing." };
            }
            return undefined;
          }

          const evaluation = await evaluatePolicyDecisionImpl({
            cfg,
            rules: ruleset.rules,
            input: {
              stage: "before_tool_call",
              toolName: event.toolName,
              params: event.params ?? {},
              runContext,
              rulesDefaults: ruleset.defaults,
              supervisorPayload: buildToolSupervisorPayload(event, ctx, runContext, ruleset.rules),
            },
            callSupervisorImpl,
          });

          await audit({
            stage: "before_tool_call",
            decisionSource: evaluation.supervisorDecision ? "supervisor" : evaluation.deterministicDecision?.decision !== "allow" ? "deterministic" : "allow",
            runId: event.runId,
            toolCallId: event.toolCallId,
            sessionId: ctx?.sessionId,
            sessionKey: ctx?.sessionKey,
            decision: evaluation.finalDecision,
            reason: evaluation.supervisorDecision?.reason ?? evaluation.deterministicDecision?.reasons?.join(" ") ?? "",
            safeUserMessage: evaluation.supervisorDecision?.safeUserMessage ?? evaluation.deterministicDecision?.safeUserMessage ?? "",
            rulesChecked: summarizeRules(evaluation.selectedRules),
            ...baseAuditPayload(runContext, evaluation),
            ...extractToolAuditFields(event.toolName, event.params ?? {}, cfg),
          });

          if (evaluation.wouldEnforce) {
            return decisionToToolResult(evaluation.finalDecisionObject);
          }
          return undefined;
        });

        api.on("after_tool_call", async (event, ctx) => {
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
            ...extractToolAuditFields(event.toolName, event.params ?? {}, cfg),
            ...extractResultAuditFields(event.result, cfg),
          });
        });
      }

      if (cfg.checkOutgoingMessages) {
        api.on("message_sending", async (event, ctx) => {
          let ruleset;
          try {
            ruleset = await ensureRules();
          } catch (error) {
            await audit({
              stage: "message_sending",
              decisionSource: "rules",
              decision: "error",
              reason: `rules load error: ${error.message}`,
              channelId: ctx?.channelId,
              conversationId: ctx?.conversationId,
              to: event.to,
              content: makeSafeText(event.content ?? "", cfg, 8000),
            });
            return undefined;
          }

          const evaluation = await evaluatePolicyDecisionImpl({
            cfg,
            rules: ruleset.rules,
            input: {
              stage: "message_sending",
              content: event.content ?? "",
              rulesDefaults: ruleset.defaults,
              supervisorPayload: buildOutgoingSupervisorPayload(event, ctx, ruleset.rules),
            },
            callSupervisorImpl,
          });

          await audit({
            stage: "message_sending",
            decisionSource: evaluation.supervisorDecision ? "supervisor" : evaluation.deterministicDecision?.decision !== "allow" ? "deterministic" : "allow",
            decision: evaluation.finalDecision,
            reason: evaluation.supervisorDecision?.reason ?? evaluation.deterministicDecision?.reasons?.join(" ") ?? "",
            safeUserMessage: evaluation.supervisorDecision?.safeUserMessage ?? evaluation.deterministicDecision?.safeUserMessage ?? "",
            channelId: ctx?.channelId,
            conversationId: ctx?.conversationId,
            to: event.to,
            content: makeSafeText(event.content ?? "", cfg, 8000),
            rulesChecked: summarizeRules(evaluation.selectedRules),
            ...baseAuditPayload(undefined, evaluation),
          });

          if (evaluation.wouldEnforce) {
            return decisionToOutgoingResult(evaluation.finalDecisionObject);
          }
          return undefined;
        });
      }
    },
  };
}
