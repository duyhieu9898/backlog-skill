"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCAL_CLI_USER_ID = exports.LOCAL_CLI_CHAT_ID = void 0;
exports.toCliMessage = toCliMessage;
exports.inputFromArgs = inputFromArgs;
const trace_1 = require("../logging/trace");
exports.LOCAL_CLI_CHAT_ID = "local-cli";
exports.LOCAL_CLI_USER_ID = "local-cli";
function toCliMessage(text) {
    return {
        traceId: (0, trace_1.generateTraceId)(),
        provider: "cli",
        chatId: exports.LOCAL_CLI_CHAT_ID,
        userId: exports.LOCAL_CLI_USER_ID,
        text,
        timestamp: new Date(),
    };
}
function inputFromArgs(args) {
    return args.join(" ").trim();
}
