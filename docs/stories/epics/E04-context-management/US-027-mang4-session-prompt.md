# Session prompt — US-027 mảng 4 (media replay / asset marker)

Paste-ready prompt for a fresh session. Self-contained: a new session has no
context from the round-1 conversation.

---

## Paste this into the new session

```
Tiếp tục US-027 ở repo /home/hieund/Downloads/my-agents (agent TypeScript trong `agent/`), nhánh `master`.

Làm MẢNG 4 của US-027 (media replay / asset marker). Round 1 (mảng 1+2+3:
canonical browser contract, provider schema, usage normalization) đã land ở
commit eb46727 — KHÔNG làm lại. Xem hiện trạng round 1 trong
`docs/stories/epics/E04-context-management/US-027-implementation-handoff.md`
(section Status, 2026-07-21).

### Đọc trước (authority)
- `docs/stories/epics/E04-context-management/US-027-browser-contract-and-media-attribution.md` — AC §76-79 (media replay).
- `docs/decisions/0020-browser-snapshot-and-media-contract.md` — media/asset rule.
- `docs/research/CONCEPT_BROWSER_CONTRACT_AND_MEDIA_USAGE.md` — §179-204 (replay/budget), §190-203 (số liệu cần đo).
- `docs/stories/epics/E04-context-management/US-027-implementation-handoff.md` — slice 6 + test `media-replay.test.js`.

### Mục tiêu mảng 4 (AC §76-79)
- Persist media MỘT LẦN dạng asset reference nhẹ (hash + dimensions), không lặp base64 mỗi turn.
- Selective hydrate: chỉ ảnh current/recent/active nạp bytes; ảnh cũ → thay bằng observation marker dạng text.
- Rehydrate by asset ID: marker nạp lại metadata (không bytes) khi cần; KHÔNG bao giờ restore browser-ref authority (ref vẫn snapshot-bound).
- Giữ bằng chứng approval/audit.

### Hiện trạng code (đã khảo sát round 1, verify lại trước khi sửa)
- `agent/src/artifacts/store.ts` (47 dòng): create/claim/markDelivered/cleanupExpired; TTL 15min, MAX 10MB. `markDelivered` xóa file (destructive).
- `agent/src/storage/repositories.ts:12-43` ArtifactRow: KHÔNG có width/height/dimensions/observation_summary.
- `agent/src/brain/provider.ts:15-20` `AiToolStep.image?: ModelImage` (comment: "Ephemeral media for the next model turn; never serialize into tool text").
- `agent/src/brain/providers/gemini.ts:69,98` inject LAST step image inline base64.
- `agent/src/tools/loop.ts:58-67` `modelImageForResult` đọc artifact qua `result.data.artifactId`; silently undefined khi expire/delivered. L307 `consumeScopedApproval` là replay duy nhất.
- Context layer (`assembler.ts`, `hydrator.ts`, `compactor.ts`) TEXT-ONLY — chưa có asset/marker. Pattern `[truncated:...]` marker ở `files.ts:248` và `hydrator.ts:40,186` để mirror.
- `agent/src/tools/media/image-context.ts:14-23` createModelImage (5MB, png/jpeg, identity=sha256+byteSize).

### Cần tạo/sửa (đề xuất từ plan round 1 — confirm lại bằng code)
- MỚI `agent/src/context/media-asset.ts`: type `MediaAssetRef` (assetId/mimeType/sha256/byteSize/width?/height?/observationSummary? — KHÔNG refs/snapshotId/targetId), `ObservationMarker`, `renderObservationMarker()`, `rehydrateAssetRef()` (metadata-only).
- MỚI `agent/test/media-replay.test.js`: asset persistence+dimensions, dedup, current/recent hydrate inline, old marker, rehydrate metadata-only (assert NO refs/snapshotId/targetId keys), no historic ref revival (rehydrate không affect refStore), audit retention (row còn queryable sau markDelivered).
- SỬA `agent/src/storage/db.ts` (~L55-66): ALTER TABLE artifacts ADD COLUMN width/height/observation_summary (idempotent, mirror CREATE TABLE IF NOT EXISTS pattern; test migration-proof.test.js đã có sẵn pattern).
- SỬA `agent/src/storage/repositories.ts`: ArtifactRow + width/height/observation_summary; thêm getArtifactMetadata (non-byte cols).
- SỬA `agent/src/artifacts/store.ts`: create nhận dimensions/summary; thêm getMetadata; markDelivered soft-delete bytes nhưng giữ metadata row cho audit (behavior change — flag).
- SỬA `agent/src/context/hydrator.ts` toolContextBlock (~L43-51): khi result có artifactId KHÔNG phải current step image → append renderObservationMarker. Ảnh latest vẫn hydrate inline qua modelImageForResult (không đổi).
- SỬA `agent/src/tools/loop.ts` persistentSteps/appendStep (~L69): persist MediaAssetRef metadata vào durable step (ephemeral image vẫn strip như cũ).

### Constraints
- Test-first, deterministic (unit/integration). Real-trace proof (5 item, cần Gemini+browser thật) HOÃN — gộp chung với real-trace round sau.
- Tiết kiệm token là mục tiêu chính: không nhồi base64 lặp.
- Bảo toàn: approval/audit evidence, current image inline cho Gemini.
- TTL/budget (snapshot TTL, ≤2 hydrated screenshots, image budget 6000 tokens, ≤3 recent turns) là CONFIG đo được, KHÔNG hard-code (research §86-87,190-203).

### Verification
cd agent && npm run build && npm test && npm run verify  # mục tiêu xanh, không regression
node --test test/media-replay.test.js   # trong khi dev

### Lưu ý
- Real-trace proof (5 Required Real-Trace Proof trong handoff §70-78) chưa proven round 1 — khi có provider/browser thật, chạy cả mảng 4 proof + 5 proof cũ.
- `click_at` coordinate variant vẫn defer (browser hiện chỉ ref actions).
- Follow-up kiến trúc (tách BrowserRuntimeManager, state machine, registry generation) đã ghi trong handoff — KHÔNG thuộc mảng 4.
```
