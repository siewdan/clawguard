const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:OPENAI|ANTHROPIC|GEMINI|SLACK|DISCORD|TELEGRAM)_[A-Z0-9_]*\b\s*[:=]\s*[^\s]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g,
];

export function redactText(text) {
  let output = typeof text === "string" ? text : "";
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
}

export function truncateText(text, maxChars = 6000) {
  const safe = typeof text === "string" ? text : "";
  if (safe.length <= maxChars) return safe;
  return `${safe.slice(0, maxChars)}\n…[truncated]`;
}
