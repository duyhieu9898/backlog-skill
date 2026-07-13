"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logDesktopEvent = logDesktopEvent;
const logger_1 = require("../../logging/logger");
function logDesktopEvent(traceId, envelope) {
    logger_1.log.info(traceId, `desktop.${envelope.action}.${envelope.outcome}`, envelope);
}
