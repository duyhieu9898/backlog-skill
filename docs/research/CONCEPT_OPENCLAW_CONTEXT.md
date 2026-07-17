## Ý chính trước tiên

OpenClaw **không gửi toàn bộ lịch sử chat cho model ở mỗi lượt**. Nó giữ hai khái niệm tách biệt:

* **Lịch sử đầy đủ trên ổ đĩa** để có thể kiểm tra, tìm kiếm và phục hồi.
* **Working context gửi cho model** chỉ gồm phần cần thiết cho lượt hiện tại.

Working context thường có dạng:

```text
System prompt ổn định
+ thông tin agent/workspace được giới hạn
+ bản tóm tắt lịch sử cũ
+ một đoạn hội thoại gần đây còn giữ nguyên
+ memory liên quan được lấy theo nhu cầu
+ message hiện tại
```

Nhờ vậy, model có cảm giác vẫn nhớ cuộc trò chuyện, nhưng không phải đọc lại toàn bộ hàng trăm message.

---

# 1. OpenClaw có nhiều tầng “nhớ”

Có thể hiểu nó có bốn tầng:

```text
┌─────────────────────────────────────────────┐
│ 1. Full transcript                          │
│ Toàn bộ message/tool call được lưu bền vững │
├─────────────────────────────────────────────┤
│ 2. Compaction summary                       │
│ Lịch sử cũ được thay bằng checkpoint ngắn   │
├─────────────────────────────────────────────┤
│ 3. Recent raw tail                          │
│ Các message gần nhất vẫn giữ nguyên văn     │
├─────────────────────────────────────────────┤
│ 4. Durable memory                           │
│ Facts/quyết định được lưu và tìm khi cần    │
└─────────────────────────────────────────────┘
```

## Tầng 1: Full transcript

Ở kiến trúc OpenClaw hiện tại, Gateway quản lý hai lớp persistence trong SQLite:

* `SessionEntry`: session hiện tại, model, token counters, số lần compact…
* Transcript event dạng append-only và có cấu trúc cây bằng `id`/`parentId`.

Transcript chứa user message, assistant message, tool result, compaction summary và branch summary. Những bản cài cũ có thể còn `sessions.json` và JSONL, nhưng runtime mới dùng SQLite làm nguồn hoạt động chính. ([OpenClaw][1])

Điểm quan trọng:

> **Lưu đầy đủ không có nghĩa là gửi đầy đủ cho model.**

Ổ đĩa có thể giữ lịch sử dài hàng tháng, nhưng mỗi API request chỉ dựng một “view” vừa với context window.

---

# 2. Context được dựng lại trước mỗi lần gọi model

OpenClaw có khái niệm **context engine**. Trước mỗi model run, engine thực hiện bước `assemble`, trả về một danh sách message đã được sắp xếp và giới hạn theo token budget.

Lifecycle của context engine gồm:

```text
ingest(message)
    ↓
assemble(messages, tokenBudget)
    ↓
model run
    ↓
afterTurn()
```

Khi context đầy:

```text
compact()
    ↓
summary + recent messages
```

Context engine mặc định hiện vẫn là `legacy`. Nó để session manager persist message, sau đó dùng pipeline sanitize → validate → limit và compactor tích hợp để tạo context. ([OpenClaw][2])

Vì vậy mỗi lượt chat không đơn giản là:

```ts
model.chat(allMessages)
```

Mà gần hơn với:

```ts
const context = await contextEngine.assemble({
  transcript,
  tokenBudget,
  availableTools,
})

await model.generate(context.messages)
```

---

# 3. Compaction: nén lịch sử cũ thành checkpoint

Khi gần đầy context, OpenClaw thực hiện **compaction**:

```text
Message cũ  ─┐
Message cũ   │
Tool calls   ├── LLM summarization ──> Compaction summary
Decisions    │
Progress    ─┘

Message gần đây ─────────────────────> Giữ nguyên
```

Sau compaction, model thấy:

```text
system prompt
+ compaction summary
+ recent raw messages
+ current message
```

Nó không thấy nguyên văn phần lịch sử đã compact, mặc dù transcript đầy đủ vẫn được persist. Compaction entry lưu cả `firstKeptEntryId` và `tokensBefore`, nhờ đó runtime biết summary thay thế phần nào và message nào bắt đầu được giữ nguyên. ([OpenClaw][1])

## Khi nào compaction chạy?

Có hai trigger chính:

1. Model báo lỗi context overflow, OpenClaw compact rồi retry.
2. Sau một lượt thành công, nếu:

```text
contextTokens > contextWindow - reserveTokens
```

Ngoài ra, OpenClaw có tùy chọn kiểm tra giữa tool loop để tránh một tool result rất lớn làm request tiếp theo vượt context. ([OpenClaw][1])

Cấu hình mẫu hiện tại:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "enabled": true,
        "reserveTokens": 16384,
        "keepRecentTokens": 20000
      }
    }
  }
}
```

Trong embedded runtime, OpenClaw còn áp dụng `reserveTokensFloor`, mặc định 20.000 token, để chừa chỗ cho output và các lượt housekeeping như memory flush. ([OpenClaw][1])

---

# 4. Nó quyết định message nào được giữ thế nào?

Compactor mà legacy engine sử dụng không đơn thuần “giữ 20 message cuối”.

Nó làm theo **token**, không theo số message:

```text
Đi ngược từ message mới nhất
→ ước lượng token từng entry
→ cộng dồn
→ khi đạt keepRecentTokens
→ tìm một cut point hợp lệ gần nhất
```

Điều này hợp lý hơn giữ `N` message, vì:

* Một message có thể chỉ 10 token.
* Một tool result có thể dài 50.000 token.
* Một lượt agent có thể gồm nhiều tool calls.

Source của Pi compactor mà OpenClaw legacy engine ủy quyền cho thấy thuật toán đi ngược từ cuối transcript, cộng token ước lượng cho đến khi đạt `keepRecentTokens`. ([GitHub][3])

## Không cắt giữa tool call và tool result

Ví dụ:

```text
assistant: gọi read_file
toolResult: nội dung file
assistant: phân tích file
```

Không được compact thành:

```text
assistant: gọi read_file
--- cut here ---
toolResult: nội dung file
```

Nếu làm vậy, model sẽ thấy một tool result không có tool call tương ứng hoặc tool call không có kết quả.

OpenClaw dịch chuyển boundary để giữ assistant tool call và `toolResult` thành một block nhất quán. Cut point không đặt trực tiếp tại tool result. ([OpenClaw][4])

## Trường hợp một turn quá lớn

Một turn có thể như sau:

```text
user
assistant → tool
toolResult
assistant → tool
toolResult
assistant → tool
toolResult
```

Nếu riêng turn này đã vượt `keepRecentTokens`, compactor được phép cắt giữa turn nhưng vẫn không cắt sai tool pair. Phần đầu của turn được tóm tắt riêng, phần cuối được giữ nguyên. ([Pi Coding Agent][5])

---

# 5. Summary không phải một đoạn văn chung chung

Đây là một điểm OpenClaw/Pi làm khá tốt.

Compaction prompt bắt model tạo **structured checkpoint** có các mục:

```markdown
## Goal

## Constraints & Preferences

## Progress

### Done

### In Progress

### Blocked

## Key Decisions

## Next Steps

## Critical Context
```

Prompt còn yêu cầu giữ chính xác:

* đường dẫn file;
* tên function;
* error message;
* quyết định;
* trạng thái công việc.

Khi compact lần tiếp theo, model không tạo summary hoàn toàn mới. Nó nhận previous summary cùng các message mới và được yêu cầu cập nhật tiến độ, bảo toàn quyết định cũ, bổ sung context mới và loại bỏ nội dung đã hết liên quan. ([GitHub][3])

Do đó summary của một session code có thể trông như:

```markdown
## Goal

Hoàn thiện persisted approval pause/resume qua restart.

## Constraints & Preferences

- Approval phải tồn tại trong SQLite.
- Không dựa vào state trong memory.
- Tool phải được prepare lại sau restart.

## Progress

### Done

- [x] ToolRegistry.
- [x] Approval matching mở rộng.

### In Progress

- [ ] Integration test đóng và mở lại DB.

## Key Decisions

- Loop B phải là instance hoàn toàn mới.
- Không mock persistence layer.

## Next Steps

1. Tạo pending call bằng loop A.
2. Đóng DB.
3. Mở DB và dựng loop B.
4. Consume persisted approval.
5. Xác minh tool chỉ execute một lần.

## Critical Context

- `ApprovalService` tự query `getDb()` trong mỗi method.
- Biến môi trường test là `AGENT_DB_FILE`.
```

Summary khoảng vài nghìn token này có thể thay cho hàng chục nghìn token hội thoại cũ mà vẫn đủ để tiếp tục task.

---

# 6. Pruning: bỏ phần nặng mà không cần summarize

Compaction xử lý toàn bộ lịch sử cũ. Nhưng phần làm context phình nhanh nhất thường không phải user message mà là:

* output lệnh shell;
* nội dung file;
* kết quả search;
* HTML;
* JSON schema;
* browser snapshot.

OpenClaw có thêm **session pruning**, chỉ xử lý `toolResult`.

Pruning không sửa transcript trên ổ đĩa. Nó chỉ thay đổi context view trước khi gửi model. ([OpenClaw][6])

## Soft trim

Tool result dài:

```text
10.000 dòng output
```

Có thể thành:

```text
1.500 ký tự đầu
...
1.500 ký tự cuối
```

Mặc định, soft trim giữ phần đầu và cuối của tool result lớn, giới hạn tổng nội dung giữ lại.

## Hard clear

Nếu context vẫn quá lớn, tool result cũ có thể được thay bằng:

```text
[Old tool result content cleared]
```

Thông tin hội thoại bình thường không bị xóa bởi pruning.

## Các guard quan trọng

OpenClaw mặc định:

* không prune ba assistant turn gần nhất;
* không prune nội dung trước user message đầu tiên;
* chỉ prune tool result;
* giữ recent prompt prefix ổn định để tận dụng cache;
* chỉ thực hiện pruning sau khi cache TTL hết và context đã đủ lớn. ([OpenClaw][6])

Đây là phần tiết kiệm token rất lớn. Một lần `read_file` 30.000 token không cần được mang theo trong 50 lượt tiếp theo nếu assistant đã phân tích xong và ghi kết luận vào message.

---

# 7. Ảnh và media cũ cũng được loại khỏi context view

Ảnh base64 hoặc media payload rất nặng.

Trong replay view, OpenClaw giữ nguyên các turn gần đây, nhưng ảnh cũ đã được model xử lý có thể được thay bằng marker:

```text
[image data removed - already processed by model]
```

Các đường dẫn media cũ cũng có thể được thay bằng marker tương tự. Transcript gốc vẫn không bị rewrite. ([OpenClaw][6])

Nghĩa là model nhớ **kết luận assistant đã rút ra từ ảnh**, không cần xem lại toàn bộ bytes của ảnh ở mỗi lượt.

---

# 8. Memory khác với conversation summary

Đây là điểm dễ nhầm nhất.

## Compaction summary

* Gắn với một session.
* Giúp tiếp tục task hiện tại.
* Chứa goal, progress, decision và next step.
* Có thể tiếp tục được compact lại.

## Long-term memory

* Sống ngoài session.
* Dùng lại qua session mới và restart.
* Chứa thông tin bền vững.
* Có thể tìm kiếm theo relevance.

OpenClaw dùng các file Markdown làm nguồn sự thật:

```text
MEMORY.md
memory/2026-07-17.md
memory/2026-07-16.md
DREAMS.md
```

`MEMORY.md` là lớp đã được tuyển chọn: preference, fact, quyết định lâu dài. Các file theo ngày là working notes chi tiết hơn và không được nhét vào mọi prompt. ([OpenClaw][7])

Ví dụ:

```markdown
# MEMORY.md

- User ưu tiên báo lỗi hơn chọn project mặc định.
- Dự án my-agent được quản lý bằng systemd user service.
- Browser cần hỗ trợ managed mode và CDP mode.
- Persisted approval phải tồn tại qua process restart.
```

Đây chỉ vài chục token nhưng giúp model “nhớ” các quyết định xuyên session.

---

# 9. Memory không được đổ toàn bộ vào mỗi turn

OpenClaw tránh cách:

```text
system prompt
+ toàn bộ MEMORY.md
+ toàn bộ memory/*.md
+ toàn bộ transcript
```

Thay vào đó:

* `MEMORY.md` là bản nhỏ đã được curate.
* Daily memory thường chỉ được truy cập qua memory tools.
* Các file daily không nằm trong bootstrap prompt thông thường.
* Với native Codex, nếu memory tools khả dụng, raw `MEMORY.md` còn có thể được thay bằng một pointer nhỏ, rồi model search/get nội dung khi cần. ([OpenClaw][8])

Memory search hiện hỗ trợ:

* chia tài liệu thành chunk khoảng 400 token;
* overlap khoảng 80 token;
* hybrid search giữa vector và BM25;
* mặc định trả tối đa sáu kết quả;
* lọc kết quả dưới score 0,35;
* vector weight mặc định 0,7 và text weight 0,3. ([OpenClaw][9])

Ví dụ người dùng hỏi:

> Cơ chế đăng ký custom tool mà ta đã chọn là gì?

Thay vì load toàn bộ memory, engine có thể chỉ lấy:

```text
[Memory hit 1]
User ưu tiên đăng ký custom tools programmatically trong source,
vì đơn giản và ít lỗi hơn auto-discovery.

[Memory hit 2]
Dynamic plugin loading chưa cần thiết cho phiên bản minimal agent.
```

Chỉ vài trăm token được đưa vào context.

---

# 10. Trước khi compact, OpenClaw chủ động lưu điều quan trọng

Summary vẫn là lossy. Một chi tiết không được summary model nhận ra có thể biến mất khỏi working context.

Do đó OpenClaw có **pre-compaction memory flush**.

Khi token usage tiến gần threshold, nó chạy một agent turn ẩn với ý nghĩa:

```text
Context sắp compact.
Hãy ghi các fact, quyết định và trạng thái quan trọng
vào memory files.
Không trả lời người dùng.
```

Agent có thể gọi tool để cập nhật:

```text
MEMORY.md
memory/YYYY-MM-DD.md
```

Sau đó output chính xác `NO_REPLY`, delivery layer sẽ không gửi message đó cho người dùng. Mỗi chu kỳ compaction chỉ flush một lần, được theo dõi bằng `memoryFlushCompactionCount`. ([OpenClaw][1])

Luồng đầy đủ:

```text
Context gần đầy
      │
      ▼
Silent memory-flush turn
      │
      ├── ghi durable facts → memory files
      │
      └── NO_REPLY
      │
      ▼
Compact old messages
      │
      ▼
Persist summary checkpoint
      │
      ▼
Tiếp tục với summary + recent tail
```

Đây là lý do OpenClaw có thể chịu được việc summary làm mất chi tiết: những quyết định thực sự quan trọng đã có một bản durable riêng.

---

# 11. Skills và workspace cũng được load có chọn lọc

Token không chỉ đến từ conversation. Nó còn đến từ:

* system prompt;
* tool descriptions;
* JSON schemas;
* skills;
* project instructions;
* memory;
* runtime metadata.

OpenClaw giảm phần này bằng cách:

* chỉ inject metadata ngắn của skill;
* full skill instructions chỉ được đọc khi cần;
* giới hạn từng bootstrap file;
* giới hạn tổng bootstrap injection;
* không inject toàn bộ daily memory;
* giới hạn tool schemas và cho phép xem tool nào đang chiếm context. ([OpenClaw][10])

Đây cũng đúng với thiết kế skill mà bạn đang nghiên cứu: **index nhỏ, content load on demand** tốt hơn việc nhét mọi `SKILL.md` vào system prompt.

---

# 12. Prompt caching không giảm context window, nhưng giảm chi phí

Cần phân biệt:

## Compaction/pruning

Thực sự giảm số token model phải nhận.

## Prompt caching

Prompt có thể vẫn dài, nhưng provider tái sử dụng phần prefix không đổi nên giảm chi phí và latency.

OpenClaw cố ý chia system prompt thành:

```text
Stable prefix:
- tool definitions
- skills metadata
- workspace files ổn định

Volatile suffix:
- timestamp
- heartbeat
- metadata thay đổi theo turn
```

Stable prefix được sắp xếp xác định và giữ byte-identical để provider cache lại. ([OpenClaw][11])

Ví dụ:

```text
Request 1:
50k input token
→ provider xử lý và cache prefix

Request 2:
50k logical context
→ 42k cacheRead
→ chỉ phần mới phải xử lý đầy đủ
```

Nhưng 50k vẫn chiếm context window. Vì vậy caching không thay thế compaction; nó chỉ làm việc mang context dài trở nên rẻ hơn.

---

# 13. Vì sao model vẫn “có cảm giác nhớ”?

Model không thực sự nhớ toàn bộ. Nó nhận đủ ba loại thông tin:

### 1. Recent details

```text
20k token gần nhất giữ nguyên
```

Nên nó trả lời chính xác các message vừa trao đổi.

### 2. Task state

```text
Goal
Progress
Decisions
Next steps
Critical context
```

Nên nó biết đang làm gì dù đoạn chat gốc đã bị compact.

### 3. Durable facts

```text
User preferences
Architecture decisions
Project conventions
Important constraints
```

Được lấy từ memory khi cần.

Có thể biểu diễn như sau:

```text
Model memory illusion
       =
recent verbatim context
       +
structured task checkpoint
       +
retrieved durable memory
```

Nó không phải lossless memory. Các chi tiết nhỏ có thể mất nếu:

* không nằm trong recent tail;
* compaction summary bỏ sót;
* chưa được ghi vào memory;
* retrieval không tìm thấy;
* user mở session mới mà memory không chứa thông tin đó.

OpenClaw từng có nhiều bug report về mất context hoặc memory flush không chạy đúng, nên cơ chế này không phải bảo đảm tuyệt đối. Chính tài liệu cũng mô tả memory là lớp cần ghi rõ ra disk, không có “hidden state” bí mật. ([OpenClaw][7])

---

# 14. Ví dụ token minh họa

Giả sử transcript đầy đủ đã dài **180.000 token**.

Sau compaction, context lượt tiếp theo có thể là:

| Thành phần                   | Token minh họa |
| ---------------------------- | -------------: |
| System prompt + tool schemas |         12.000 |
| Compaction summary           |          5.000 |
| Recent raw messages          |         20.000 |
| Memory hits liên quan        |          2.000 |
| Message hiện tại             |          1.000 |
| Tổng input                   |         40.000 |

Trong khi SQLite vẫn giữ transcript 180.000 token.

Nếu stable prefix 12.000 token được provider cache, chi phí xử lý thực tế cho các lượt gần nhau có thể còn thấp hơn nữa. Đây là ví dụ minh họa, không phải con số mặc định cố định của OpenClaw.

---

# 15. Phiên bản nên áp dụng cho `my-agent`

Bạn không cần toàn bộ hệ thống memory của OpenClaw. Một phiên bản gọn nên có sáu phần:

```text
SessionStore
TranscriptStore
ContextAssembler
ContextPruner
CompactionService
MemoryStore
```

## Context được dựng theo thứ tự

```ts
async function buildContext(sessionId: string, input: Message) {
  const transcript = await transcriptStore.getActiveBranch(sessionId)

  const pruned = contextPruner.pruneOldToolResults(transcript)

  return fitToBudget([
    buildStableSystemPrompt(),
    loadLatestCompactionSummary(pruned),
    selectRecentRawTail(pruned),
    await retrieveRelevantMemory(input),
    input,
  ])
}
```

## Ngưỡng đề xuất cho model 128K

Đây là cấu hình tôi đề xuất cho `my-agent`, không phải mặc định OpenClaw:

```ts
const contextPolicy = {
  maxContextTokens: 128_000,

  reserveTokens: 20_000,

  recentTailTokens: 20_000,

  summaryMaxTokens: 6_000,

  retrievedMemoryMaxTokens: 3_000,

  toolResultSoftTrimChars: 4_000,

  keepRecentAssistantTurnsFromPruning: 3,
}
```

## Trigger

```ts
const pressure =
  estimatedContextTokens >
  maxContextTokens - reserveTokens

if (pressure) {
  await flushDurableMemory()
  await compactTranscript()
}
```

## Compaction checkpoint

Nên dùng schema gần giống OpenClaw:

```ts
interface ContextCheckpoint {
  goals: string[]
  constraints: string[]
  completed: string[]
  inProgress: string[]
  blockers: string[]
  decisions: Array<{
    decision: string
    rationale?: string
  }>
  nextSteps: string[]
  criticalContext: string[]
  importantIdentifiers: string[]
}
```

Tôi còn khuyên lưu dưới dạng JSON có schema validation, rồi render sang Markdown cho model. Cách này dễ merge, test và phát hiện summary bị thiếu section hơn chỉ lưu text tự do.

---

# Kết luận

OpenClaw giữ context hiệu quả nhờ **phân tầng dữ liệu**:

```text
Transcript đầy đủ
    không gửi hết cho model

Summary checkpoint
    giữ trạng thái dài hạn của task

Recent raw tail
    giữ độ chính xác cho đoạn chat gần đây

Pruned tool results
    loại payload cũ rất nặng

Durable memory
    giữ facts xuyên session

Retrieval
    chỉ nạp memory liên quan

Prompt caching
    giảm chi phí phần prefix không đổi
```

Phần đáng học nhất cho `my-agent` không phải vector database hay hệ thống memory phức tạp, mà là ba thứ:

1. **Structured compaction summary thay vì summary văn xuôi.**
2. **Giữ recent tail theo token và không phá tool-call pair.**
3. **Flush quyết định quan trọng ra durable memory trước khi compact.**

Đó là bộ tối thiểu mang lại phần lớn lợi ích của OpenClaw mà không làm kiến trúc `my-agent` phình quá lớn.

[1]: https://docs.openclaw.ai/reference/session-management-compaction "Session management deep dive - OpenClaw"
[2]: https://docs.openclaw.ai/concepts/context-engine "Context engine - OpenClaw"
[3]: https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts "pi/packages/coding-agent/src/core/compaction/compaction.ts at main · earendil-works/pi · GitHub"
[4]: https://docs.openclaw.ai/concepts/compaction "Compaction - OpenClaw"
[5]: https://pi.dev/docs/latest/compaction "Compaction & Branch Summarization · Documentation · Pi"
[6]: https://docs.openclaw.ai/concepts/session-pruning "Session pruning - OpenClaw"
[7]: https://docs.openclaw.ai/concepts/memory "Memory overview - OpenClaw"
[8]: https://docs.openclaw.ai/reference/token-use "Token use and costs - OpenClaw"
[9]: https://docs.openclaw.ai/reference/memory-config "Memory configuration reference - OpenClaw"
[10]: https://docs.openclaw.ai/concepts/context "Context - OpenClaw"
[11]: https://docs.openclaw.ai/reference/prompt-caching "Prompt caching - OpenClaw"
