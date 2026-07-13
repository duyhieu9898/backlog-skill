import { log } from "../../logging/logger";
import type { DesktopEventEnvelope } from "./contracts";

export function logDesktopEvent(traceId: string, envelope: DesktopEventEnvelope): void {
  log.info(traceId, `desktop.${envelope.action}.${envelope.outcome}`, envelope);
}
