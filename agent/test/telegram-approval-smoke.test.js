// ADR 0017 P2.7 — Telegram approval adapter smoke.
//
// The Telegram adapter (adapters/telegram.ts) and the bot's callback_query handling
// had zero test coverage. This drives the real adapter seam end-to-end:
//   1st update (message)  -> Router pauses, emits the Approve/Reject inline keyboard.
//   2nd update (callback_query) -> callback_data "approve <shortId>" resumes and the
//                                  action executes.
// It proves the callback_query -> StandardMessage.text transformation, the markup
// shape emitted at router.ts:251-266, and the full pause/resume round-trip through
// the Telegram adapter specifically.
//
// AGENT_COMMANDS_FILE / AGENT_DB_FILE must be set before any dist require.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-smoke-"));
const commandsFile = path.join(workspaceDir, "commands.json");
const dbFile = path.join(workspaceDir, "test.sqlite");
fs.writeFileSync(
  commandsFile,
  JSON.stringify({
    allow: [
      {
        name: "tg.confirm",
        label: "Telegram smoke command",
        cwd: workspaceDir,
        argv: [process.execPath, "-e", 'process.stdout.write("tg-ok")'],
        requiresConfirmation: true,
      },
    ],
  }),
);
process.env.AGENT_COMMANDS_FILE = commandsFile;
process.env.AGENT_DB_FILE = dbFile;

const { toStandardMessage } = require("../dist/adapters/telegram");
const { Router } = require("../dist/core/router");
const { SkillRegistry } = require("../dist/skills/registry");
const { getPendingApproval } = require("../dist/storage/repositories");
const { closeDb } = require("../dist/storage/db");

const CHAT_ID = 424242;
const USER_ID = 99;

test.after(() => {
  closeDb();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function pauseUpdate() {
  return {
    update_id: 1,
    message: { chat: { id: CHAT_ID }, from: { id: USER_ID }, text: "tg.confirm", date: 1718000000 },
  };
}

function approveUpdate(shortId) {
  return {
    update_id: 2,
    callback_query: {
      id: "cq-1",
      from: { id: USER_ID },
      message: { chat: { id: CHAT_ID } },
      data: `approve ${shortId}`,
    },
  };
}

test("Telegram adapter round-trips an approval: pause emits keyboard, callback approve resumes", async () => {
  const router = new Router(new SkillRegistry());
  let markup = null;

  const pauseMsg = toStandardMessage(pauseUpdate());
  assert.equal(pauseMsg.provider, "telegram");
  assert.equal(pauseMsg.text, "tg.confirm");
  // The run row is created by AgentRuntime.execute inside Router.route.
  const reply = await router.route(pauseMsg, (m) => { markup = m; });

  const shortId = (reply.match(/Approval ID: ([a-f0-9]{8})/) || [])[1];
  assert.ok(shortId, "pause reply includes an Approval ID");
  assert.ok(/cần xác nhận/.test(reply), "pause reply asks for confirmation");
  assert.deepEqual(markup, {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `approve ${shortId}` },
      { text: "❌ Reject", callback_data: `reject ${shortId}` },
    ]],
  });

  // The Telegram-specific path: a button press arrives as callback_query.data and
  // becomes the approving message text.
  const approveMsg = toStandardMessage(approveUpdate(shortId));
  assert.equal(approveMsg.text, `approve ${shortId}`);
  assert.equal(approveMsg.chatId, String(CHAT_ID));

  const resumeReply = await router.route(approveMsg);
  assert.match(resumeReply, /tg-ok/);
  assert.equal(
    getPendingApproval(shortId, String(USER_ID), String(CHAT_ID)).status,
    "approved",
  );
});
