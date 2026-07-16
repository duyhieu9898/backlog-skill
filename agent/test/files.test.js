const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const closeIsolatedDb = require("./helpers/db");
test.after(() => closeIsolatedDb());

const { PermissionPolicy } = require("../dist/security/permissionPolicy");
const { FileTools } = require("../dist/tools/files");
const { listTraceEvents } = require("../dist/storage/repositories");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-files-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const policy = new PermissionPolicy({
    workspaceRoot: workspace,
    allowedReadRoots: [workspace],
    allowedWriteRoots: [workspace],
    deniedPaths: [],
  });
  return { root, workspace, outside, tools: new FileTools(policy) };
}

test("file read/list/exists return structured results across ordinary project paths", (t) => {
  const { workspace, tools } = fixture(t);
  fs.writeFileSync(path.join(workspace, "note.txt"), "hello");
  fs.writeFileSync(path.join(workspace, ".env"), "TOKEN=secret");
  fs.mkdirSync(path.join(workspace, ".git"));
  fs.mkdirSync(path.join(workspace, "node_modules"));

  const read = tools.execute(
    { kind: "file.read", path: path.join(workspace, "note.txt") },
    { traceId: `files-read-${Date.now()}` },
  );
  assert.equal(read.ok, true);
  assert.equal(read.code, "FILE_READ");
  assert.equal(read.data.content, "hello");

  const listed = tools.execute(
    { kind: "file.list", path: workspace },
    { traceId: `files-list-${Date.now()}` },
  );
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.data.entries, [
    { name: ".git", type: "directory" },
    { name: "node_modules", type: "directory" },
    { name: "note.txt", type: "file" },
  ]);
  assert.equal(listed.data.deniedEntries, 1);

  const missing = tools.execute(
    { kind: "file.exists", path: path.join(workspace, "missing.txt") },
    { traceId: `files-exists-${Date.now()}` },
  );
  assert.deepEqual(missing.data, {
    path: path.join(workspace, "missing.txt"),
    exists: false,
  });
});

test("large reads are explicitly truncated and binary reads are refused", (t) => {
  const { workspace, tools } = fixture(t);
  const large = path.join(workspace, "large.txt");
  const binary = path.join(workspace, "binary.dat");
  fs.writeFileSync(large, "x".repeat(128));
  fs.writeFileSync(binary, Buffer.from([1, 0, 2]));

  const truncated = tools.execute(
    { kind: "file.read", path: large, maxBytes: 32 },
    { traceId: `files-large-${Date.now()}` },
  );
  assert.equal(truncated.ok, true);
  assert.equal(truncated.data.truncated, true);
  assert.match(truncated.data.content, /\[truncated: file exceeds 32 bytes\]/);

  const refused = tools.execute(
    { kind: "file.read", path: binary },
    { traceId: `files-binary-${Date.now()}` },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "BINARY_FILE_REFUSED");
});

test("routine write and mkdir run without confirmation", (t) => {
  const { workspace, tools } = fixture(t);
  const directory = path.join(workspace, "notes");
  const file = path.join(directory, "today.md");

  const mkdirPreview = tools.execute(
    { kind: "file.mkdir", path: directory },
    { traceId: `files-mkdir-preview-${Date.now()}` },
  );
  assert.equal(mkdirPreview.code, "DIRECTORY_CREATED");
  assert.equal(fs.existsSync(directory), true);
  const mkdir = mkdirPreview;
  assert.equal(mkdir.code, "DIRECTORY_CREATED");

  const preview = tools.execute(
    { kind: "file.write", path: file, content: "first\n" },
    { traceId: `files-write-preview-${Date.now()}` },
  );
  assert.equal(preview.ok, true);
  assert.equal(preview.code, "FILE_WRITTEN");
  assert.equal(fs.existsSync(file), true);

  const written = tools.execute(
    { kind: "file.write", path: file, content: "first\n" },
    { traceId: `files-write-${Date.now()}`, confirmationGranted: true },
  );
  assert.equal(written.ok, true);
  assert.equal(written.code, "FILE_WRITTEN");
  assert.equal(fs.readFileSync(file, "utf8"), "first\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("patch requires one exact match and mutates routine files", (t) => {
  const { workspace, tools } = fixture(t);
  const file = path.join(workspace, "note.txt");
  fs.writeFileSync(file, "alpha\nbeta\n", { mode: 0o640 });

  const preview = tools.execute(
    { kind: "file.patch", path: file, search: "beta", replacement: "gamma" },
    { traceId: `files-patch-preview-${Date.now()}` },
  );
  assert.equal(preview.code, "FILE_PATCHED");
  assert.equal(fs.readFileSync(file, "utf8"), "alpha\ngamma\n");

  const patched = tools.execute(
    { kind: "file.patch", path: file, search: "gamma", replacement: "delta" },
    { traceId: `files-patch-${Date.now()}`, confirmationGranted: true },
  );
  assert.equal(patched.code, "FILE_PATCHED");
  assert.equal(fs.readFileSync(file, "utf8"), "alpha\ndelta\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);

  fs.writeFileSync(file, "same same");
  const ambiguous = tools.execute(
    { kind: "file.patch", path: file, search: "same", replacement: "changed" },
    { traceId: `files-patch-ambiguous-${Date.now()}`, confirmationGranted: true },
  );
  assert.equal(ambiguous.code, "PATCH_TARGET_AMBIGUOUS");
  assert.equal(fs.readFileSync(file, "utf8"), "same same");
});

test("file tools refuse denied paths, symlink escapes, and binary writes", (t) => {
  const { workspace, outside, tools } = fixture(t);
  fs.symlinkSync(outside, path.join(workspace, "escape"));

  const secret = tools.execute(
    { kind: "file.read", path: path.join(workspace, ".env") },
    { traceId: `files-denied-secret-${Date.now()}` },
  );
  assert.equal(secret.code, "CONFIRMATION_REQUIRED");

  const escaped = tools.execute(
    { kind: "file.write", path: path.join(workspace, "escape", "note.txt"), content: "no" },
    { traceId: `files-denied-escape-${Date.now()}`, confirmationGranted: true },
  );
  assert.equal(escaped.code, "FILE_WRITTEN");
  assert.equal(fs.existsSync(path.join(outside, "note.txt")), true);

  const binary = tools.execute(
    { kind: "file.write", path: path.join(workspace, "binary.txt"), content: "a\0b" },
    { traceId: `files-denied-binary-${Date.now()}`, confirmationGranted: true },
  );
  assert.equal(binary.code, "BINARY_CONTENT_REFUSED");
});

test("every file result records a trace event without file content", (t) => {
  const { workspace, tools } = fixture(t);
  const traceId = `files-trace-${Date.now()}`;
  const target = path.join(workspace, "trace.txt");
  const result = tools.execute(
    { kind: "file.write", path: target, content: "sensitive body" },
    { traceId, confirmationGranted: true },
  );
  assert.equal(result.ok, true);

  const events = listTraceEvents(traceId, 20);
  assert.ok(events.some((event) => event.event === "file.write.completed"));
  const final = events.find((event) => event.event === "file.result");
  assert.ok(final);
  assert.equal(final.payload_json.includes("sensitive body"), false);
  assert.match(final.payload_json, /FILE_WRITTEN/);
});
