## Kết luận nghiên cứu

Ý tưởng của bạn đúng, nhưng nên tách thành **hai lớp độc lập**:

```text
Capability routing
→ quyết định model nhìn thấy schema nào

Authorization policy
→ quyết định tool nào thực sự được phép chạy
```

Không nên để intent router vừa chọn schema vừa cấp quyền. Router có thể đoán sai; quyền thực thi phải luôn được kiểm tra lại bằng allowlist tĩnh, policy, scope tài nguyên và approval.

OpenClaw hiện đã làm tốt lớp thứ hai: tool policy được tính **trước khi gọi model**, nên tool bị loại sẽ không gửi schema vào request. Tuy nhiên các profile như `coding` vẫn khá rộng, chứa filesystem, runtime, web, session, memory và nhiều tool khác; nó chưa phải mô hình “general chat không tool, mỗi intent chỉ nhận 2–3 tool” mà bạn đang hướng đến. ([OpenClaw][1])

---

# 1. OpenClaw đang xử lý schema tool như thế nào?

## Tool profile tĩnh

OpenClaw có các profile:

| Profile     | Tool được cấp                                           |
| ----------- | ------------------------------------------------------- |
| `minimal`   | Chỉ `session_status`                                    |
| `coding`    | File, runtime, web, session, memory và một số tool khác |
| `messaging` | Message và session                                      |
| `full`      | Không giới hạn theo profile                             |

Sau profile, OpenClaw tiếp tục áp dụng:

```text
base profile
→ provider profile
→ global allow/deny
→ agent allow/deny
→ sender policy
→ sandbox policy
→ runtime/session restrictions
→ plugin availability
```

Deny thắng allow. Các nhóm như `group:web`, `group:fs`, `group:ui`, `group:nodes` đóng vai trò capability group tĩnh. ([OpenClaw][2])

Điểm đáng học:

> Effective tool set phải được tính một lần trước khi dựng prompt, rồi chính tập đó được dùng cho cả schema gửi model và enforcement lúc execute.

OpenClaw từng có bug khi đường gọi skill trực tiếp không đi qua đầy đủ effective-policy pipeline, cho thấy mọi execution path phải dùng cùng một authority gate. ([GitHub][3])

## Tool Search cho catalog lớn

OpenClaw hiện có Tool Search thử nghiệm:

```text
Model thấy:
- tool_search_code
- một số direct-only tools

Model không thấy:
- toàn bộ schema của catalog

Khi cần:
search → describe → call
```

Catalog vẫn được lọc qua policy trước. Full schema chỉ được hydrate khi tool được chọn. ([OpenClaw][4])

OpenAI hiện cũng có native `tool_search`: deferred tool không được nạp đầy đủ từ đầu; với namespace hoặc MCP server, model ban đầu chỉ thấy tên và mô tả của namespace, rồi tải schema liên quan khi cần. OpenAI khuyến nghị mỗi namespace dưới khoảng 10 function. Tính năng này chỉ có trên GPT-5.4 trở lên. ([OpenAI Developers][5])

### Nhận xét cho `my-agent`

Hiện tại bạn chưa có catalog hàng trăm tool, nên **chưa cần Tool Search**.

Một router capability với 0–5 schema mỗi turn sẽ:

* đơn giản hơn;
* ít lỗi hơn;
* dùng được với mọi provider;
* không phụ thuộc model có hỗ trợ deferred tools hay không.

Tool Search chỉ nên thêm khi số tool vượt khoảng vài chục hoặc MCP catalog trở nên lớn.

---

# 2. Không nên gọi nó là intent routing thuần túy

`Intent` thường là:

```text
Người dùng muốn làm gì?
```

Nhưng để chọn tool đúng, bạn còn cần:

```text
Capability: cần loại năng lực nào?
Target: thao tác lên tài nguyên nào?
Mode: chỉ đọc hay thay đổi?
Authority: user có quyền đến đâu?
Continuation: có phải tiếp tục task trước không?
```

Do đó object router nên gần như:

```ts
type Capability =
  | 'general'
  | 'web'
  | 'file-read'
  | 'file-write'
  | 'desktop-observe'
  | 'desktop-control'
  | 'skill'
  | 'mixed'

interface CapabilityRoute {
  capabilities: Capability[]
  targets: ResourceTarget[]
  continuation: boolean
  confidence: number
  reason: string
}
```

Ví dụ:

```text
"React compositionend là gì?"
→ general
→ tools: []

"Kiểm tra tài liệu mới nhất của Vue"
→ web
→ tools: [web_search, web_fetch]

"Đọc ARCHITECTURE.md và review"
→ file-read
→ tools: [file_search, file_read]

"Sửa file app.ts"
→ file-write
→ tools: [file_read, file_write, apply_patch]

"Mở VS Code và tìm lỗi"
→ desktop-control
→ tools: [desktop_snapshot, desktop_act]

"Dùng skill clean-code review index.js"
→ skill + file-read
→ tools: [skill_load, file_read]
```

---

# 3. Router nên chạy thế nào?

## Không nên dùng một LLM router cho mọi message

Nếu general chat phải gọi thêm model chỉ để kết luận `general`, bạn tiết kiệm schema token nhưng lại:

* thêm một API call;
* tăng latency;
* tốn input/output cho router;
* tạo thêm một điểm có thể phân loại sai.

Nên dùng pipeline ba tầng.

## Tầng 1 — deterministic signals

Các tín hiệu chắc chắn:

```ts
function routeHardSignals(input: TurnInput): PartialRoute | null {
  if (input.command === '/skill') {
    return { capabilities: ['skill'], confidence: 1 }
  }

  if (input.attachments.some((item) => item.kind === 'file')) {
    return { capabilities: ['file-read'], confidence: 0.95 }
  }

  if (input.uiTarget?.kind === 'desktop-app') {
    return { capabilities: ['desktop-control'], confidence: 0.95 }
  }

  if (containsExplicitWebRequest(input.text)) {
    return { capabilities: ['web'], confidence: 0.9 }
  }

  return null
}
```

Các cụm rõ ràng:

```text
"tìm trên mạng", "research", "mới nhất"
→ web

"đọc file", "review file", "mở ARCHITECTURE.md"
→ file-read

"sửa", "ghi", "patch", "refactor file"
→ file-write

"click", "mở app", "điều khiển VS Code"
→ desktop-control

"dùng skill", "/skill"
→ skill
```

## Tầng 2 — continuation resolver

Nếu message mơ hồ:

```text
"còn file kia thì sao?"
"tiếp tục đi"
"click cái thứ hai"
"sửa luôn lỗi đó"
"trang tiếp theo"
```

Router kiểm tra scope đang hoạt động.

## Tầng 3 — model router chỉ khi còn mơ hồ

Router model chỉ nhận:

```text
- message hiện tại;
- 1–2 user turn gần nhất;
- active scope summary;
- enum capability;
```

Không gửi:

* toàn transcript;
* full tool schemas;
* system prompt chính;
* skill bodies.

Schema output:

```ts
interface RouteDecision {
  capabilities: Array<
    | 'general'
    | 'web'
    | 'file-read'
    | 'file-write'
    | 'desktop-observe'
    | 'desktop-control'
    | 'skill'
  >
  continuation: boolean
  confidence: number
}
```

Nếu confidence thấp, fallback về:

```text
general
tools: []
```

Không nên fallback thành `full tools`.

---

# 4. Kế thừa scope qua follow-up

Đây là phần dễ sai nhất.

Không nên lưu đơn giản:

```ts
session.lastIntent = 'desktop'
```

Vì sau đó:

```text
User: Mở VS Code.
Agent: Đã mở.

User: JavaScript closure là gì?
```

Nếu kế thừa `desktop`, turn hỏi kiến thức vẫn bị gửi desktop schema.

## Dùng một “scope lease”

```ts
interface ActiveScope {
  id: string

  capability:
    | 'web'
    | 'file-read'
    | 'file-write'
    | 'desktop-observe'
    | 'desktop-control'
    | 'skill'

  target?: {
    type: 'file' | 'directory' | 'website' | 'desktop-app' | 'skill'
    id: string
  }

  taskSummary: string

  sourceTurnId: string
  lastUsedTurn: number

  state: 'active' | 'completed' | 'cancelled' | 'expired'

  expiresAfterTurns: number
}
```

Ví dụ:

```json
{
  "capability": "desktop-control",
  "target": {
    "type": "desktop-app",
    "id": "antigravity"
  },
  "taskSummary": "Review lỗi trong terminal của Antigravity",
  "state": "active",
  "expiresAfterTurns": 3
}
```

## Khi nào được kế thừa?

Kế thừa khi message:

* chứa đại từ tham chiếu: “nó”, “file đó”, “trang kia”;
* là hành động nối tiếp: “tiếp tục”, “mở tiếp”, “sửa luôn”;
* phụ thuộc trực tiếp vào kết quả tool vừa rồi;
* không thể hiểu đầy đủ nếu bỏ context trước;
* target vẫn còn tồn tại.

Ví dụ:

```text
User: Đọc app.ts và tìm lỗi.
→ file-read scope

Agent: Có lỗi ở refreshTokenSync.

User: Sửa nó đi.
→ kế thừa target app.ts
→ nâng route từ file-read sang file-write
```

Điểm quan trọng: đây là **nâng capability**, không phải kế thừa quyền write từ trước.

## Khi nào phải ngắt scope?

Ngắt khi:

* user đưa ra câu hỏi tự đầy đủ về chủ đề mới;
* task trước đã hoàn tất;
* user nói “dừng”, “bỏ qua”, “không cần nữa”;
* target bị đóng hoặc không còn hợp lệ;
* quá số turn TTL;
* bắt đầu skill/task mới;
* session reset;
* capability nhạy cảm đã dùng xong.

```ts
function shouldInheritScope(
  message: string,
  scope: ActiveScope,
): boolean {
  if (scope.state !== 'active') return false
  if (isExplicitTopicChange(message)) return false
  if (isSelfContainedGeneralQuestion(message)) return false
  if (isCancellation(message)) return false
  if (scopeExpired(scope)) return false

  return isEllipticalFollowUp(message) ||
    refersToScopeTarget(message, scope) ||
    dependsOnPreviousResult(message)
}
```

## Không kế thừa authority

Nên phân biệt:

```text
Scope continuity:
"ta vẫn đang làm việc với app.ts"

Authority continuity:
"ta vẫn được phép sửa hoặc execute mọi thứ"
```

Chỉ kế thừa cái đầu.

Các quyền sau không nên tự động kế thừa:

* file write;
* shell exec;
* desktop action có hậu quả;
* gửi message;
* thanh toán;
* xóa dữ liệu;
* đăng nhập;
* upload;
* publish.

Mỗi tool call vẫn phải qua:

```text
static capability allowlist
→ resource boundary
→ action risk policy
→ persisted approval nếu cần
→ execute
```

OpenClaw cũng tách session override khỏi hard policy: chẳng hạn `/exec` có thể lưu lựa chọn host/security/ask theo session, nhưng hard deny trong tool policy vẫn vô hiệu hóa exec. ([OpenClaw][6])

---

# 5. Static allowlist theo capability

Đây nên là source of truth bằng code, không để model tự chọn.

```ts
const CAPABILITY_TOOLS = {
  general: [],

  web: [
    'web.search',
    'web.fetch',
  ],

  'file-read': [
    'file.search',
    'file.read',
  ],

  'file-write': [
    'file.search',
    'file.read',
    'file.write',
    'file.applyPatch',
  ],

  'desktop-observe': [
    'desktop.listApps',
    'desktop.snapshot',
  ],

  'desktop-control': [
    'desktop.listApps',
    'desktop.snapshot',
    'desktop.act',
  ],

  skill: [
    'skill.search',
    'skill.load',
  ],
} as const
```

Có thể khai báo quan hệ kế thừa:

```ts
const CAPABILITY_INHERITANCE = {
  'file-write': ['file-read'],
  'desktop-control': ['desktop-observe'],
} as const
```

Sau đó:

```ts
function resolveVisibleTools(
  route: CapabilityRoute,
  authority: AuthorityContext,
): ToolDefinition[] {
  const capabilityTools = expandCapabilityTools(route.capabilities)

  return toolRegistry
    .filterByNames(capabilityTools)
    .filter((tool) => tool.isSupportedBy(authority.provider))
    .filter((tool) => authority.staticPolicy.allows(tool))
    .filter((tool) => tool.isAvailable())
}
```

## Mixed scope

Một request có thể cần nhiều capability:

```text
"Research cách OpenClaw làm rồi cập nhật ARCHITECTURE.md"
```

Route:

```text
web + file-write
```

Tool set:

```text
web.search
web.fetch
file.read
file.write
file.applyPatch
```

Nên giới hạn:

```ts
const MAX_DIRECT_CAPABILITIES_PER_TURN = 2
const MAX_DIRECT_TOOLS_PER_TURN = 8
```

Nếu vượt giới hạn:

* tách task thành stage;
* dùng tool catalog/search;
* hoặc chỉ gửi capability cho stage hiện tại.

---

# 6. Skill không nên được xem như một capability tool thông thường

Trong OpenClaw, skill là instruction pack, không phải executable tool. Các skill đủ điều kiện được đưa vào system prompt dưới dạng XML compact; chi phí khoảng 97 ký tự cộng tên, description và location cho mỗi skill, tương đương khoảng 24 token trước các field bổ sung. Danh sách skill thường được snapshot theo session. ([OpenClaw][7])

Với `my-agent`, nên dùng hai bước:

```text
Skill catalog:
- name
- description ngắn
- required capabilities

Khi chọn skill:
- load body SKILL.md
- union các required capability tools
```

Ví dụ:

```ts
interface SkillDescriptor {
  name: string
  description: string
  requiredCapabilities: Capability[]
  requiredTools?: string[]
}
```

```json
{
  "name": "clean-code-review",
  "description": "Review code for maintainability issues.",
  "requiredCapabilities": ["file-read"]
}
```

Turn general không cần skill:

```text
tools: []
skills: []
```

Turn gọi skill:

```text
skill instructions: clean-code-review/SKILL.md
tools: [file.search, file.read]
```

Không nhất thiết gửi `skill.search` và `skill.load` cho model nếu router đã chọn skill bằng command hoặc metadata. Runtime có thể load skill trước model call.

---

# 7. Provider-native function schema

Không nên tạo một JSON object duy nhất rồi gửi nguyên xi cho mọi provider.

Nên có:

```text
Canonical ToolDefinition
        │
        ├── OpenAI encoder
        ├── Anthropic encoder
        └── Gemini encoder
```

## Canonical definition nội bộ

```ts
interface ToolDefinition {
  id: string
  capability: Capability
  description: string
  inputSchema: JsonSchema
  risk: 'read' | 'write' | 'execute' | 'external-side-effect'

  provider?: {
    openai?: Record<string, unknown>
    anthropic?: Record<string, unknown>
    gemini?: Record<string, unknown>
  }
}
```

Runtime luôn validate bằng canonical schema của chính bạn trước execute, bất kể provider đã validate hay chưa.

---

## OpenAI

Responses API dùng dạng:

```ts
{
  type: 'function',
  name: 'file_read',
  description: 'Read a UTF-8 text file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  strict: true,
}
```

Với strict mode:

* mọi object phải có `additionalProperties: false`;
* mọi property phải nằm trong `required`;
* field tùy chọn được biểu diễn bằng nullable type;
* OpenAI khuyến nghị bật strict mode. ([OpenAI Developers][8])

OpenAI còn có:

* built-in tools;
* custom free-form tools;
* namespaces;
* deferred loading;
* provider-native Tool Search trên model hỗ trợ. ([OpenAI Developers][8])

---

## Anthropic

Custom tool dùng:

```ts
{
  name: 'file_read',
  description: 'Read a UTF-8 text file.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  strict: true,
}
```

Anthropic còn có các field native:

* `input_examples`;
* `cache_control`;
* `strict`;
* `defer_loading`;
* `allowed_callers`.

`defer_loading: true` loại full definition khỏi initial system prompt; khi tool search tìm thấy tool, schema được chèn tại vị trí đó trong conversation, giúp giữ prompt cache. `allowed_callers` còn cho phép giới hạn tool chỉ được gọi trực tiếp hoặc từ code execution. ([Claude Platform Docs][9])

Anthropic cũng có server tools versioned như web search, web fetch, code execution và computer use; nếu dùng chúng, nên giữ native type thay vì wrap thành custom function. ([Claude Platform][10])

---

## Gemini

Gemini Interactions API nhận:

```ts
{
  type: 'function',
  name: 'file_read',
  description: 'Read a UTF-8 text file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
}
```

Gemini có compositional và parallel function calling, đồng thời hỗ trợ kết hợp một số built-in tools với custom functions. ([Google AI for Developers][11])

Do schema hỗ trợ và request shape có thể khác giữa `generateContent`, Live API và Interactions API, encoder nên chọn theo cả:

```text
provider + API family + model capability
```

Không chỉ theo `provider = gemini`.

---

# 8. Kiến trúc provider adapter đề xuất

```ts
interface ProviderToolEncoder {
  encodeTools(
    tools: ToolDefinition[],
    context: {
      model: string
      apiFamily: string
    },
  ): unknown[]
}
```

```ts
class OpenAIResponsesToolEncoder
  implements ProviderToolEncoder {}

class AnthropicMessagesToolEncoder
  implements ProviderToolEncoder {}

class GeminiInteractionsToolEncoder
  implements ProviderToolEncoder {}
```

Mỗi encoder phải:

1. Chuyển schema canonical sang subset provider hỗ trợ.
2. Giữ thứ tự tool ổn định.
3. Giữ description byte-identical giữa các lượt.
4. Không thêm field động như timestamp vào schema.
5. Bật strict khi provider hỗ trợ.
6. Ghi log schema hash.
7. Validate tool args lần nữa ở application layer.

```ts
const schemaCacheKey = hash({
  provider,
  apiFamily,
  model,
  capabilitySet: [...capabilities].sort(),
  toolVersions: tools.map((tool) => tool.version),
})
```

---

# 9. Pipeline hoàn chỉnh cho `my-agent`

```text
Inbound message
      │
      ▼
Hard-signal router
      │
      ├── rõ ràng ──────────────┐
      │                         │
      ▼                         │
Continuation resolver           │
      │                         │
      ├── đủ chắc chắn ─────────┤
      │                         │
      ▼                         │
Small route model               │
      │                         │
      └─────────────────────────┘
                │
                ▼
       CapabilityRoute
                │
                ▼
     Static capability allowlist
                │
                ▼
 Effective authority-policy filter
                │
                ▼
   Provider-native schema encoder
                │
                ▼
          Main model call
                │
                ▼
           Tool request
                │
                ▼
 Schema validation + policy + approval
                │
                ▼
              Execute
```

Pseudocode:

```ts
async function runTurn(turn: TurnInput): Promise<AgentResult> {
  const session = await sessionStore.load(turn.sessionId)

  const route = await capabilityRouter.resolve({
    message: turn.message,
    attachments: turn.attachments,
    activeScopes: session.activeScopes,
    recentContext: session.routingContext,
  })

  const candidateTools = capabilityPolicy.resolve(route.capabilities)

  const effectiveTools = authorityPolicy.filter(candidateTools, {
    sender: turn.sender,
    session,
    provider: turn.provider,
    sandbox: turn.sandbox,
  })

  const providerTools = providerToolEncoder.encodeTools(
    effectiveTools,
    {
      model: turn.model,
      apiFamily: turn.apiFamily,
    },
  )

  return agentLoop.run({
    ...turn,
    tools: providerTools,
    authoritySnapshot: effectiveTools.map((tool) => tool.id),
  })
}
```

Lúc execute:

```ts
async function executeTool(call: ToolCall, run: AgentRun) {
  if (!run.authoritySnapshot.includes(call.name)) {
    throw new ToolNotVisibleError(call.name)
  }

  const tool = toolRegistry.require(call.name)

  tool.validateInput(call.arguments)

  await authorityPolicy.assertExecutable({
    tool,
    call,
    run,
  })

  return approvalService.executeOrPause({
    tool,
    call,
    run,
  })
}
```

---

# 10. Cấu hình nên chốt

```ts
const routingPolicy = {
  defaultCapability: 'general',

  followUpScopeTtlTurns: 3,

  maxCapabilitiesPerTurn: 2,

  maxDirectToolsPerTurn: 8,

  inheritReadScope: true,

  inheritWriteAuthority: false,

  inheritExecutionAuthority: false,

  lowConfidenceFallback: 'general',

  routeModelThreshold: 0.7,
}
```

## Quy tắc quan trọng nhất

```text
General chat
→ 0 tool

Continuation về web
→ web tools

Continuation về file
→ file tools

Continuation về desktop
→ desktop tools

Skill được chọn
→ skill body + required tools

Topic mới
→ xóa active capability scope

Write/execute/control
→ không kế thừa authority

Mọi tool call
→ enforcement lại ở server
```

## Chốt thiết kế

Với quy mô hiện tại của `my-agent`, tôi đề xuất:

1. **Capability router nội bộ**, không copy nguyên profile `coding` rộng của OpenClaw.
2. **Static capability-to-tool map** làm source of truth.
3. **Scope lease có target và TTL** để hiểu follow-up.
4. **Chỉ kế thừa task context, không kế thừa quyền nguy hiểm.**
5. **Canonical tool schema + provider-native encoders.**
6. **General route hoàn toàn không gửi tool schema.**
7. Chưa triển khai Tool Search; chỉ thêm khi catalog thực sự lớn.

Đây sẽ tiết kiệm token rõ rệt hơn OpenClaw profile thông thường, nhưng vẫn giữ authority model đơn giản và kiểm chứng được.

[1]: https://docs.openclaw.ai/tools "Overview - OpenClaw"
[2]: https://docs.openclaw.ai/gateway/config-tools "Configuration — tools and custom providers - OpenClaw"
[3]: https://github.com/openclaw/openclaw/issues/75124?utm_source=chatgpt.com "[Bug]: `command-dispatch: tool` skill slash ..."
[4]: https://docs.openclaw.ai/tools/tool-search "Tool Search - OpenClaw"
[5]: https://developers.openai.com/api/docs/guides/tools-tool-search?utm_source=chatgpt.com "Tool search | OpenAI API"
[6]: https://docs.openclaw.ai/tools/exec "Exec tool - OpenClaw"
[7]: https://docs.openclaw.ai/tools/skills "Skills - OpenClaw"
[8]: https://developers.openai.com/api/docs/guides/function-calling "
  Function calling | OpenAI API
"
[9]: https://docs.anthropic.com/ko/docs/agents-and-tools/tool-use/implement-tool-use "도구 정의하기 - Claude Platform Docs"
[10]: https://platform.claude.com/docs/ko/agents-and-tools/tool-use/tool-reference "도구 참조 - Claude Platform Docs"
[11]: https://ai.google.dev/gemini-api/docs/function-calling "Function calling with the Gemini API  |  Google AI for Developers"
