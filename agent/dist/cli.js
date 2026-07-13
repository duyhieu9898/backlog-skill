"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCli = runCli;
const node_path_1 = __importDefault(require("node:path"));
const cli_1 = require("./adapters/cli");
const paths_1 = require("./config/paths");
const env_1 = require("./config/env");
const router_1 = require("./core/router");
const registry_1 = require("./skills/registry");
const repositories_1 = require("./storage/repositories");
function readStdin() {
    return new Promise((resolve, reject) => {
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            input += chunk;
        });
        process.stdin.on("end", () => resolve(input.trim()));
        process.stdin.on("error", reject);
    });
}
async function runCli(args = process.argv.slice(2)) {
    (0, env_1.loadEnv)(node_path_1.default.join(paths_1.agentDir, ".env"));
    const json = args.includes("--json");
    const text = (0, cli_1.inputFromArgs)(args.filter((arg) => arg !== "--json")) || (process.stdin.isTTY ? "" : await readStdin());
    if (!text) {
        process.stderr.write('Usage: npm run cli -- "<message>"\n');
        return 2;
    }
    const router = new router_1.Router(new registry_1.SkillRegistry());
    const message = (0, cli_1.toCliMessage)(text);
    let artifactId;
    const reply = await router.route(message, undefined, (id) => { artifactId = id; });
    const artifact = artifactId ? (0, repositories_1.getArtifact)(artifactId) : null;
    if (json) {
        process.stdout.write(`${JSON.stringify({
            traceId: message.traceId,
            reply,
            artifact: artifact && { id: artifact.id, mimeType: artifact.mime_type, byteSize: artifact.byte_size, path: artifact.local_path },
        })}\n`);
    }
    else {
        process.stdout.write(`${reply}${artifact ? `\nArtifact: ${artifact.local_path}` : ""}\n`);
    }
    return 0;
}
if (require.main === module) {
    runCli()
        .then((exitCode) => {
        process.exitCode = exitCode;
    })
        .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Agent lỗi: ${message}\n`);
        process.exitCode = 1;
    });
}
