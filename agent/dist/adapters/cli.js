"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCAL_CLI_USER_ID = exports.LOCAL_CLI_CHAT_ID = void 0;
exports.cliChatId = cliChatId;
exports.toCliMessage = toCliMessage;
exports.inputFromArgs = inputFromArgs;
const trace_1 = require("../logging/trace");
exports.LOCAL_CLI_CHAT_ID = "local-cli";
exports.LOCAL_CLI_USER_ID = "local-cli";
function cliChatId(session) {
    if (!session)
        return exports.LOCAL_CLI_CHAT_ID;
    const normalized = session.trim();
    if (!normalized)
        throw new Error("CLI session must not be empty.");
    if (normalized.length > 160)
        throw new Error("CLI session must be at most 160 characters.");
    return `${exports.LOCAL_CLI_CHAT_ID}:session:${normalized}`;
}
function toCliMessage(text, options = {}) {
    return {
        traceId: (0, trace_1.generateTraceId)(),
        provider: "cli",
        chatId: cliChatId(options.session),
        userId: exports.LOCAL_CLI_USER_ID,
        text,
        timestamp: new Date(),
    };
}
function inputFromArgs(args) {
    return args.join(" ").trim();
}
