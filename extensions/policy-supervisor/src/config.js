import path from "node:path";

function resolveWorkspaceDir(api) {
  const configured = api?.config?.agents?.defaults?.workspace;
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(configured);
  }
  return process.cwd();
}

function resolvePathAgainstWorkspace(workspaceDir, value, fallback) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(workspaceDir, raw);
}

export function resolvePluginConfig(api) {
  const pluginConfig = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
  const workspaceDir = resolveWorkspaceDir(api);
  const supervisor = pluginConfig.supervisor && typeof pluginConfig.supervisor === "object"
    ? pluginConfig.supervisor
    : {};

  const apiKeyFromEnv =
    typeof supervisor.apiKeyEnv === "string" && supervisor.apiKeyEnv.trim()
      ? process.env[supervisor.apiKeyEnv.trim()] || ""
      : "";

  const supervisorConfig = {
    enabled: Boolean(supervisor.enabled),
    baseUrl: typeof supervisor.baseUrl === "string" ? supervisor.baseUrl.trim().replace(/\/$/, "") : "",
    model: typeof supervisor.model === "string" ? supervisor.model.trim() : "",
    apiKey: typeof supervisor.apiKey === "string" && supervisor.apiKey.trim()
      ? supervisor.apiKey.trim()
      : apiKeyFromEnv,
    apiKeyEnv: typeof supervisor.apiKeyEnv === "string" ? supervisor.apiKeyEnv.trim() : "",
    headers: supervisor.headers && typeof supervisor.headers === "object" ? { ...supervisor.headers } : {},
    timeoutMs: Number.isFinite(supervisor.timeoutMs) ? Math.max(1, Number(supervisor.timeoutMs)) : undefined,
    maxTokens: Number.isFinite(supervisor.maxTokens) ? Math.max(1, Number(supervisor.maxTokens)) : undefined,
  };

  return {
    workspaceDir,
    rulesPath: resolvePathAgainstWorkspace(
      workspaceDir,
      pluginConfig.rulesPath,
      "./policies/SUPERVISOR_RULES.md",
    ),
    auditLogPath: resolvePathAgainstWorkspace(
      workspaceDir,
      pluginConfig.auditLogPath,
      "./logs/policy-supervisor.jsonl",
    ),
    mode: pluginConfig.mode === "enforce" ? "enforce" : "audit",
    redactSecrets: pluginConfig.redactSecrets !== false,
    checkLlmInput: pluginConfig.checkLlmInput !== false,
    checkLlmOutput: pluginConfig.checkLlmOutput !== false,
    checkToolCalls: pluginConfig.checkToolCalls !== false,
    checkOutgoingMessages: pluginConfig.checkOutgoingMessages !== false,
    failClosedTools: new Set(
      Array.isArray(pluginConfig.failClosedTools) && pluginConfig.failClosedTools.length > 0
        ? pluginConfig.failClosedTools.map(String)
        : ["exec", "write", "edit", "sessions_send"],
    ),
    maxContextChars: Number.isFinite(pluginConfig.maxContextChars)
      ? Math.max(100, Number(pluginConfig.maxContextChars))
      : 6000,
    timeoutMs: Number.isFinite(pluginConfig.timeoutMs)
      ? Math.max(1, Number(pluginConfig.timeoutMs))
      : 1500,
    supervisor: supervisorConfig,
  };
}
