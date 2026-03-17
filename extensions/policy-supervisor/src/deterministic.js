const DELETE_COMMAND_PATTERNS = [
  /(^|\s)rm(\s|$)/i,
  /\bfind\b[^\n]*\s-delete\b/i,
  /\bgit\s+clean\b/i,
  /\btruncate\b[^\n]*\s-s\s+0\b/i,
  /\bmkfs(\.|\s|$)/i,
  /\bdd\b[^\n]*\bof=/i,
  /(^|[;&|])\s*: \>\s*[^\s]+/,
];

const EXFIL_COMMAND_PATTERNS = [
  /(^|\s)curl(\s|$)/i,
  /(^|\s)wget(\s|$)/i,
  /(^|\s)scp(\s|$)/i,
  /(^|\s)rsync(\s|$)/i,
  /(^|\s)(nc|netcat)(\s|$)/i,
  /(^|\s)sendmail(\s|$)/i,
  /(^|\s)mail(\s|$)/i,
  /(^|\s)msmtp(\s|$)/i,
  /https?:\/\//i,
];

const PRIVATE_OUTPUT_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/i,
  /\/home\/raspi\/\.openclaw\//,
  /MEMORY\.md/i,
  /\b(?:OPENAI|ANTHROPIC|GEMINI|SLACK|DISCORD|TELEGRAM)_[A-Z0-9_]*\b/i,
];

const DECISION_WEIGHT = {
  allow: 0,
  revise: 1,
  confirm: 2,
  block: 3,
};

function getEventField(event, ...names) {
  for (const name of names) {
    const value = event?.[name];
    if (typeof value === "string") return value;
  }
  return "";
}

function mergeDecision(current, next) {
  if (!current) return next;
  if (DECISION_WEIGHT[next.decision] > DECISION_WEIGHT[current.decision]) return next;
  return {
    ...current,
    reasons: [...current.reasons, ...next.reasons],
    matchedRuleIds: [...current.matchedRuleIds, ...next.matchedRuleIds],
  };
}

function makeDecision(rule, decision, reason, safeUserMessage) {
  return {
    decision,
    reasons: [reason],
    matchedRuleIds: [rule.id],
    safeUserMessage,
  };
}

function evaluateDeleteRule(rule, event) {
  if (event?.toolName === "exec") {
    const command = getEventField(event.params, "command");
    if (DELETE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
      return makeDecision(
        rule,
        "confirm",
        "Potentially destructive command detected.",
        "Das sieht potenziell destruktiv aus. Soll ich das wirklich ausführen?",
      );
    }
  }

  if (event?.toolName === "write") {
    const content = getEventField(event.params, "content");
    if (!content.trim()) {
      return makeDecision(
        rule,
        "confirm",
        "Write call would empty a file.",
        "Das würde eine Datei leeren oder überschreiben. Soll ich das wirklich tun?",
      );
    }
  }

  if (event?.toolName === "edit") {
    const replacement = getEventField(event.params, "newText", "new_string");
    if (!replacement) {
      return makeDecision(
        rule,
        "confirm",
        "Edit call removes content.",
        "Das würde Inhalt entfernen. Soll ich das wirklich tun?",
      );
    }
  }

  return null;
}

function evaluateExternalSendRule(rule, event) {
  if (event?.toolName === "sessions_send") {
    return makeDecision(
      rule,
      "confirm",
      "Cross-session send detected.",
      "Das würde eine Nachricht in eine andere Session senden. Soll ich das wirklich tun?",
    );
  }

  if (event?.toolName === "exec") {
    const command = getEventField(event.params, "command");
    if (EXFIL_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
      return makeDecision(
        rule,
        "confirm",
        "Potential outbound or exfiltration command detected.",
        "Das sieht nach externer Übertragung aus. Soll ich das wirklich ausführen?",
      );
    }
  }

  return null;
}

function evaluateProtectPrivateContextRule(rule, event) {
  const content = getEventField(event, "content");
  if (PRIVATE_OUTPUT_PATTERNS.some((pattern) => pattern.test(content))) {
    return makeDecision(
      rule,
      "revise",
      "Outgoing content appears to contain private context or secrets.",
      "Ich kann diese Nachricht so nicht senden, weil sie wahrscheinlich private Informationen enthält.",
    );
  }
  return null;
}

export function evaluateDeterministicDecision({ stage, event, rules }) {
  let decision = {
    decision: "allow",
    reasons: [],
    matchedRuleIds: [],
    safeUserMessage: undefined,
  };

  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || rule.enabled === false || rule.mode !== "deterministic") continue;
    if (stage && rule.stage !== stage) continue;

    let candidate = null;
    switch (rule.id) {
      case "no-delete-without-confirm":
        candidate = evaluateDeleteRule(rule, event);
        break;
      case "no-external-send-without-explicit-request":
        candidate = evaluateExternalSendRule(rule, event);
        break;
      case "protect-private-context":
        candidate = evaluateProtectPrivateContextRule(rule, event);
        break;
      default:
        candidate = null;
    }

    if (candidate) {
      decision = mergeDecision(decision, candidate);
    }
  }

  return decision;
}
