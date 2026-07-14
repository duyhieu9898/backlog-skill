"use strict";
// Cron expression helpers backed by the `croner` library.
//
// Supported syntax (5-field, standard cron):
//   minute hour day-of-month month day-of-week
//
// Examples:
//   "0 17 * * 1-5"   → Mon–Fri at 17:00
//   "0 9 * * 6"      → Saturday at 09:00
//   "*/30 * * * *"   → every 30 minutes
//   "0 8 1 * *"      → 1st of every month at 08:00
//
// Day-of-week: 0 = Sunday, 1 = Monday, … 6 = Saturday
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateCron = validateCron;
exports.nextAfter = nextAfter;
const croner_1 = require("croner");
/**
 * Validate a cron expression. Returns an error message or null if valid.
 */
function validateCron(expr) {
    try {
        new croner_1.Cron(expr, { paused: true });
        return null;
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
/**
 * Returns the next ISO timestamp (UTC) after `from` that matches the cron
 * expression, evaluated in the given IANA timezone.
 * Returns null if no upcoming run is found.
 */
function nextAfter(expr, from, timeZone) {
    const job = new croner_1.Cron(expr, { timezone: timeZone, paused: true });
    const next = job.nextRun(from);
    return next ? next.toISOString() : null;
}
