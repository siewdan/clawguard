import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

export async function writeAuditEvent(auditLogPath, event) {
  const target = path.resolve(auditLogPath);
  await mkdir(path.dirname(target), { recursive: true });
  const payload = {
    ts: new Date().toISOString(),
    ...event,
  };
  await appendFile(target, `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}
