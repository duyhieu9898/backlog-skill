const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { resolveBrowserProfile } = require("../dist/browser/profile-path");

test("profile-path resolves valid names and rejects invalid/unsafe ones", (t) => {
  const profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-"));
  t.after(() => fs.rmSync(profilesRoot, { recursive: true, force: true }));
  const config = {
    profilesRoot,
    defaultPersistent: true,
    profiles: {
      "persistent-p": { persistent: true },
      "ephemeral-p": { persistent: false }
    }
  };

  // 1. Valid persistent profile
  const res1 = resolveBrowserProfile("persistent-p", config);
  assert.equal(res1.name, "persistent-p");
  assert.equal(res1.persistent, true);
  assert.equal(res1.userDataDir, path.join(profilesRoot, "persistent-p"));

  // 2. Valid ephemeral profile
  const res2 = resolveBrowserProfile("ephemeral-p", config);
  assert.equal(res2.name, "ephemeral-p");
  assert.equal(res2.persistent, false);
  assert.ok(res2.userDataDir.startsWith(profilesRoot + path.sep));
  assert.match(res2.userDataDir, /tmp_ephemeral-p_[a-f0-9]+$/);

  // 3. Reject invalid names
  assert.throws(() => resolveBrowserProfile("", config), (err) => err.code === "PROFILE_INVALID_NAME");
  assert.throws(() => resolveBrowserProfile("a/b", config), (err) => err.code === "PROFILE_INVALID_NAME");
  assert.throws(() => resolveBrowserProfile("../escape", config), (err) => err.code === "PROFILE_INVALID_NAME");
  assert.throws(() => resolveBrowserProfile("profile.name", config), (err) => err.code === "PROFILE_INVALID_NAME");
  assert.throws(() => resolveBrowserProfile("a".repeat(65), config), (err) => err.code === "PROFILE_INVALID_NAME");
});
