"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserError = void 0;
class BrowserError extends Error {
    code;
    retryable;
    recovery;
    constructor(code, message, retryable = false, recovery) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.name = "BrowserError";
        this.recovery = recovery;
    }
}
exports.BrowserError = BrowserError;
