---
name: debug-eval-loop-skill
description: Vòng lặp cải tiến agent có đo lường, chạy từng bước (step-gated). Mỗi bước làm xong thì DỪNG và nói rõ bước tiếp theo làm gì. Dùng khi muốn tối ưu hành vi agent qua chứng cứ (eval report + trace), khi debug một case fail/timeout, hoặc (riêng query.py) tra cứu lịch sử lệnh terminal production.
---

# Debug Eval Loop (step-gated)

## Nguyên tắc sống còn

- **Step-gated, KHÔNG tự chạy mãi:** mỗi pha làm xong → **DỪNG** → báo (1) kết quả ngắn,
  (2) **“Bước tiếp theo: …”** rõ ràng. Caller quyết định tiếp. Không tự loop.
- **Mọi kết luận = bằng chứng** từ report/trace. Không đoán rồi chuyển bước.
- **1 thay đổi / lần sửa** (biến cô lập) để bước REVIEW quy kết đúng nguyên nhân.
- **cwd mặc định: `agent/`** (vì `npm run eval` cần `package.json` ở đây). Mọi lệnh dưới
  đây chạy từ `agent/` trừ khi ghi khác.

## Bản đồ công cụ (cwd: `agent/`)

| Việc | Lệnh | Build dist? |
|---|---|---|
| TEST (chạy eval) | `npm run eval -- --batch A` / `--only <id>` / `--us US-026` | ✅ có |
| REVIEW (so sánh) | `node scripts/dev.js eval diff --last` | ❌ |
| Dọn report | `node scripts/dev.js eval prune --keep 20` | ❌ |
| Drill raw từng turn | `node scripts/dev.js logs show <traceId>` | ❌ |
| Prod: command_runs | `python ../skills/debug-skill/scripts/query.py commands\|runs …` | ❌ |

> Source of truth cú pháp/flag: `node scripts/dev.js help` (đừng học thuộc — có thể đổi).

## Các pha (state machine — di chuyển từng bước, DỪNG sau mỗi pha)

Ghi nhớ pha hiện tại. Làm xong → DỪNG → báo kết quả + **Bước tiếp theo**.

### Pha TEST
```
npm run eval -- --batch A            # hoặc: --only <id>  |  --us US-026 (cả story)  |  --batch smoke (rẻ)
# filter compose: --us US-026 --batch A = US-026 provider-only
```
- `npm run eval` **build dist rồi mới chạy** — BẮT BUỘC nếu vừa sửa `src/` (eval chạy
  `dist/cli.js`; quên build = test dist cũ → "thay đổi không tác động", kết luận sai).
- Báo: pass/fail/⏳ mỗi case + đường dẫn report mới.
- **DỪNG.** Bước tiếp theo: có case fail/⏳ → **ANALYZE**; all pass → xác nhận thêm 1-2 chạy
  (xem STOCHASTIC) rồi → **tạm dừng / DONE**.

### Pha ANALYZE
- Đọc report. Ánh xạ tín hiệu → **giả thuyết** (bảng dưới). **VERIFY giả thuyết trong trace
  trước khi sửa** — bảng là gợi ý, không phải chân lý.
- Drill khi report chưa đủ: `node scripts/dev.js logs show <traceId>` (raw request/response).
- Báo: nguyên nhân likely (đã verify) + deterministic hay stochastic.
- **DỪNG.** Bước tiếp theo: **IMPROVE** (đúng 1 thay đổi).

### Pha IMPROVE
- Sửa **một** thứ: `src/…` (hành vi agent) HOẶC `eval/real-trace.json` (chỉ khi `expect`
  sai bản chất; `tuning:true` là escape hatch hợp lệ).
- **Tuyệt đối không edit `expect` để ép case pass** — che regression.
- Báo: đổi gì, tại sao.
- **DỪNG.** Bước tiếp theo: **TEST** (`npm run eval -- …`, rebuild dist).

### Pha REVIEW
```
node scripts/dev.js eval diff --last        # 2 report mới nhất
# hoặc tường minh khi --last không cùng case-set:
node scripts/dev.js eval diff eval/reports/<cũ>.json eval/reports/<mới>.json
```
- **Cổng đạt = tín hiệu DETERMINISTIC cải thiện** (xem bảng) và không có ✅→❌.
- `--last` giả định 2 report **cùng case-set** — mix smoke + A/B chỉ ra new-case/removed (rác).
- **DỪNG.** Bước tiếp theo:
  - cải thiện → giữ, đặt baseline mới = report hiện tại → **TEST** (case khác) hoặc **DONE**;
  - worse / noise → **revert**, quay **ANALYZE**;
  - ⏳ inconclusive → **KHÔNG kết luận**, re-run off-peak (`EVAL_TIMEOUT_MS=120000 npm run
    eval -- --only <id>`), có thể `EVAL_INTER_CASE_MS=15000`.

### Pha CLEANUP (cứ ~10 lần lặp, hoặc khi `eval/reports/` nhiều)
```
node scripts/dev.js eval prune --keep 20         # giữ 20 report gần nhất cho truy vết
node scripts/dev.js eval prune --keep 20 --dry-run   # xem trước
```
- Giữ đủ lịch sử truy vết, không để report ngập. `logs/ai-interactions/` tự prune 14 ngày.
- `eval/eval.sqlite` tích lũy `trace_events` qua các chạy (cần cho recovery/drill-down);
  nếu quá to → sao lưu rồi có thể xóa file (sẽ tạo lại ở chạy sau).
- Báo: dọn xong.
- **DỪNG.** Bước tiếp theo: quay pha đang làm.

## Bảng giả thuyết chẩn đoán — **VERIFY trong trace trước khi sửa**

| Tín hiệu | Giả thuyết nguyên nhân (cần verify) | Loại |
|---|---|---|
| ⏳ `inconclusive` + `providerRetries>0` | provider 503/429 quá tải | deterministic → re-run |
| `routeContinuation: new`, kỳ vọng `continued` | resolver không nhận diện tham chiếu elip ("chụp lại ảnh đó") | deterministic |
| `INVALID_TOOL_CALL` / `Unknown tool: X` | model gọi tool ngoài visible set | deterministic (visibility) |
| `pausesOrBlocks` fail | hành động rủi ro chạy thầm (không confirm/deny) | deterministic (gateway) |
| token tăng đột biến | `toolSchemas`/`toolSteps` attribution | deterministic (xem `client attribution`) |
| `artifact mime` ≠ kỳ vọng | browser/screenshot path | deterministic |
| `traces=[]` | CLI crash trước `route.started` (dist thiếu / config / build lỗi) | deterministic → check build |
| `replyContains`/`replyMatches` fail | model trả lời khác kỳ vọng | ⚠️ **STOCHASTIC** — chạy N lần |
| case đa-lượt fail nhưng metric sai | metric lấy sai lượt (phải lượt cuối) | deterministic → check `eval.js aggregate` |

## Deterministic vs Stochastic — QUAN TRỌNG

Eval LLM **không deterministic hoàn toàn**. Đừng kết luận cải thiện/regression qua 1 chạy.

- **Deterministic (tin qua 1 chạy)** — phản ánh resolver/gateway/tooling, ổn định:
  `visibility.continuation`, `visibleToolNames`, `toolSchemas` (attribution),
  `gateway.decision` outcome, structured codes (`WEB_CAPTURED`, `INVALID_TOOL_CALL`…).
- **Stochastic (cần N=2-3, hoặc đừng dùng làm gate duy nhất):**
  `replyContains`/`replyMatches`, token counts chính xác, `aiSteps`, việc model có chọn
  đúng tool từng bước. → chạy lại; chỉ tin khi ≥2/3 chạy đồng thuận.

`eval diff` có ý nghĩa nhất khi: **cùng case-set** + **so deterministic** + (với stochastic) **đã chạy N lần**.

## Production debug (NGOÀI eval loop) — `query.py`

`query.py` **không thuộc eval loop**: DB eval thường **rỗng** `command_runs` (eval chạy qua
gateway tool executor, không qua `runTrackedCommand`). Chỉ dùng để debug **production**:

```
python ../skills/debug-skill/scripts/query.py commands 10        # recent command_runs (prod)
python ../skills/debug-skill/scripts/query.py runs <traceId>     # chi tiết 1 run: exit code + output tail
```
- Mặc định trỏ DB prod (`agent/data/agent.sqlite`). Set `AGENT_DB_FILE=eval/eval.sqlite`
  (relative-to-`agentDir`, chạy từ đâu cũng đúng) nếu muốn truy vết eval DB có dữ liệu.
- trace_events + raw AI-log: vẫn dùng `dev.js eval` / `dev.js logs` (Node, đúng DB, không trùng).

## Lưu ý

- **Build:** `npm run eval` build; `node scripts/dev.js eval` **không** build → sửa `src/`
  thì PHẢI dùng `npm run eval -- …`.
- **⏳ inconclusive** = provider outage, re-run off-peak, **đừng sửa code**.
- **Output méo:** stdout chứa `:` (timestamp/JSON) có thể bị render thành `[file] (n):` —
  đây là quirk đã biết của môi trường, **không phải lỗi dữ liệu**. Ưu tiên Read tool; nếu cần
  in số liệu có cấu trúc thì dùng định dạng không dấu `:`.
- **Token:** raw `logs/ai-interactions/*` redact key `/token/` → so token phải qua `eval diff`
  (report đọc `trace_events` un-redacted).
