"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserError = void 0;
class BrowserError extends Error {
    code;
    retryable;
    constructor(code, message, retryable = false) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.name = "BrowserError";
    }
}
exports.BrowserError = BrowserError;
