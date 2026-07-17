Bạn nhớ **đúng về ý tưởng**, nhưng có một điểm cần chỉnh:

> OpenClaw không chính thức chia desktop app thành đúng hai loại. Tài liệu hiện tại mô tả **bốn đường điều khiển desktop**. Còn cách chia “app bình thường” và “app Electron” là một cách phân loại thực dụng, trong đó nhánh Electron chủ yếu đến từ **skill cộng đồng dùng `agent-browser` qua CDP**. ([OpenClaw][1])

## Hai loại bạn đang nhớ

### 1. Điều khiển app như con người — OS-level computer use

Agent nhìn màn hình hoặc accessibility tree, sau đó:

```text
chụp màn hình
→ xác định nút/input
→ di chuyển chuột
→ click
→ gõ bàn phím
→ chụp lại
```

Cơ chế này không quan tâm ứng dụng được viết bằng Electron, Swift, Qt, GTK hay công nghệ nào khác.

Trong OpenClaw trên macOS, đường built-in là:

```text
Agent
  ↓
computer tool
  ↓
screen.snapshot
  ↓
computer.act
  ↓
macOS node
  ↓
embedded Peekaboo automation
  ↓
mouse / keyboard / accessibility
```

`computer.act` được thực thi trong app OpenClaw đã có quyền Screen Recording và Accessibility. Nó có thể điều khiển pointer, keyboard và giao diện desktop nói chung. ([OpenClaw][1])

Phù hợp với:

* Finder;
* System Settings;
* native dialog;
* menu hệ điều hành;
* ứng dụng không có API;
* ứng dụng không bật được debug port;
* bất kỳ GUI nào agent có thể nhìn thấy.

Hạn chế:

* phụ thuộc focus và vị trí cửa sổ;
* dễ sai khi UI thay đổi;
* thường cần screenshot nhiều lần;
* tốn token hình ảnh hơn;
* chậm hơn điều khiển theo DOM hoặc accessibility element;
* click nhầm nguy hiểm hơn.

---

### 2. Điều khiển bên trong Electron qua CDP

Electron nhúng Chromium vào desktop app. Vì vậy một Electron app có thể được khởi động với Chrome DevTools Protocol, ví dụ:

```bash
code --remote-debugging-port=9223
```

Sau đó agent kết nối trực tiếp vào renderer của ứng dụng:

```text
Agent
  ↓
agent-browser
  ↓
Chrome DevTools Protocol
  ↓
Electron renderer
  ↓
DOM / accessibility tree / input events
```

Electron chính thức được xây dựng trên Chromium và Node.js; VS Code là một ứng dụng Electron điển hình. ([GitHub][2])

Cách này gần giống điều khiển một trang web hơn là điều khiển desktop bằng chuột:

```bash
agent-browser connect 9223
agent-browser snapshot -i
agent-browser click @e5
agent-browser fill @e9 "hello"
```

`agent-browser` hỗ trợ CDP endpoint của Electron, Chrome/Chromium, WebView2 và các browser service từ xa. ([GitHub][3])

## Skill mà bạn nhớ là skill nào?

Rất có khả năng đó là skill:

```text
name: electron
path: daxiangnaoyang/daxiang-electron
```

Mô tả của skill ghi rõ nó dùng `agent-browser` qua Chrome DevTools Protocol để điều khiển:

* VS Code;
* Slack;
* Discord;
* Figma;
* Notion;
* Spotify;
* GitHub Desktop;
* Postman;
* Obsidian;
* các Electron app khác. ([GitHub][4])

Skill hướng dẫn workflow:

```text
1. Đóng app nếu đang chạy.
2. Khởi động lại với --remote-debugging-port.
3. agent-browser connect PORT.
4. Lấy snapshot.
5. Dùng element ref như @e5.
6. Snapshot lại sau khi UI thay đổi.
```

Ví dụ trên Linux:

```bash
code --remote-debugging-port=9223

agent-browser connect 9223
agent-browser snapshot -i
```

Skill còn hướng dẫn dùng session riêng khi điều khiển đồng thời nhiều app:

```bash
agent-browser --session vscode connect 9223
agent-browser --session slack connect 9222

agent-browser --session vscode snapshot -i
agent-browser --session slack snapshot -i
```

Các hướng dẫn này nằm trực tiếp trong skill được lưu tại kho archive của OpenClaw Skills. ([GitHub][4])

## Đây là skill hay tool?

Nó gồm hai phần khác nhau:

```text
electron SKILL.md
    =
hướng dẫn agent nhận biết Electron app
+ quy trình launch/connect/snapshot/action

agent-browser
    =
tool thực sự gửi lệnh CDP
```

Nói cách khác, skill không tự cung cấp khả năng điều khiển. Nó dạy agent cách dùng executable `agent-browser`.

Skill khai báo quyền:

```yaml
allowed-tools:
  - Bash(agent-browser:*)
  - Bash(npx agent-browser:*)
```

Bản thân `agent-browser` cần được cài riêng:

```bash
npm install -g agent-browser
agent-browser install
```

Skill chính thức của `agent-browser` cũng mô tả đây là CLI dùng CDP và accessibility-tree snapshot với các reference ngắn dạng `@eN`. ([GitHub][5])

Để tìm và kiểm tra skill trong ClawHub, nên chạy:

```bash
clawhub search electron
clawhub inspect <slug-tìm-được>
clawhub install <slug-tìm-được>
```

ClawHub hỗ trợ `search`, `inspect`, `install`, `list`, `update` và `uninstall`; nên inspect nội dung trước khi cài vì đây là skill cộng đồng, không phải module core của OpenClaw. ([GitHub][6])

## So sánh chính xác hai cơ chế

| Tiêu chí                   | Computer use OS-level          | Electron qua CDP                         |
| -------------------------- | ------------------------------ | ---------------------------------------- |
| Quan sát                   | Screenshot/accessibility       | DOM/accessibility tree của Chromium      |
| Thao tác                   | Chuột và bàn phím hệ điều hành | CDP input và element ref                 |
| App hỗ trợ                 | Gần như mọi GUI                | Electron/Chromium/WebView2               |
| Native menu/dialog         | Tốt hơn                        | Có thể không nhìn thấy                   |
| Độ chính xác               | Phụ thuộc giao diện hình ảnh   | Cao khi element xuất hiện trong renderer |
| Token                      | Screenshot có thể nặng         | Snapshot text thường nhẹ hơn             |
| Tốc độ                     | Chậm hơn                       | Nhanh hơn                                |
| Yêu cầu khởi động đặc biệt | Không nhất thiết               | Thường cần remote debugging              |
| Hoạt động nền              | Khó, phụ thuộc focus           | Thường tốt hơn                           |
| Rủi ro                     | Click nhầm trên desktop        | Debug port cấp quyền rất mạnh vào app    |

Điểm quan trọng là hai cơ chế **bổ sung nhau**, không thay thế hoàn toàn nhau.

Ví dụ điều khiển VS Code:

```text
Mở Command Palette trong renderer
→ CDP có thể xử lý tốt

Chọn file trong native file picker
→ cần OS-level computer use

Click menu do hệ điều hành render
→ có thể cần OS-level

Điền search box trong sidebar
→ CDP thường chính xác hơn
```

Thiết kế tốt nhất là cho agent thử CDP trước, sau đó fallback sang computer use khi gặp thành phần native.

## OpenClaw hiện thực sự có bốn đường desktop control

Tài liệu OpenClaw hiện liệt kê bốn đường độc lập:

1. **PeekabooBridge**
   `peekaboo` CLI dùng quyền Accessibility và Screen Recording của OpenClaw.app.

2. **Built-in `computer.act`**
   Agent của Gateway điều khiển Mac node qua contract thống nhất.

3. **Codex Computer Use**
   Khi chạy Codex harness, plugin `codex` chuẩn bị và có thể cài plugin MCP `computer-use`, rồi Codex trực tiếp sở hữu các native computer tool call.

4. **Direct `cua-driver` MCP**
   Đăng ký TryCua driver như một MCP server bình thường trong OpenClaw. ([OpenClaw][1])

Skill Electron bằng `agent-browser` là một nhánh khác ở cấp workflow:

```text
Không điều khiển toàn desktop
→ attach trực tiếp vào Chromium renderer của app
```

Do đó, cách hiểu đơn giản cho dự án của bạn là:

```text
Desktop automation
├── OS computer driver
│   ├── screenshot
│   ├── accessibility
│   ├── mouse
│   └── keyboard
│
└── CDP application driver
    ├── browser
    ├── Electron
    ├── VS Code
    └── Chromium-based IDE
```

## Trường hợp Antigravity

Antigravity có giao diện và nền tảng phát triển dựa trên trải nghiệm IDE kiểu VS Code, nhưng khả năng attach CDP có thể thay đổi theo phiên bản và cách Google đóng gói ứng dụng. Một số công cụ cộng đồng báo cáo rằng Antigravity có thể được chạy với `--remote-debugging-port`; một số khác báo cáo có phiên bản hoặc cấu hình chặn cơ chế này. Vì vậy không nên mặc định rằng skill Electron luôn kết nối được với Antigravity. ([GitHub][7])

Bạn có thể kiểm tra trên Ubuntu:

```bash
pkill -f antigravity

antigravity --remote-debugging-port=9223
```

Sau đó:

```bash
curl http://127.0.0.1:9223/json/version
curl http://127.0.0.1:9223/json/list
```

Nếu có JSON trả về và có `webSocketDebuggerUrl`, thử:

```bash
agent-browser --cdp 9223 snapshot -i
```

Nếu không có endpoint hoặc snapshot không thấy UI, fallback sang:

```text
Linux accessibility/UI automation
hoặc
screenshot-based computer use
```

Không nên mở port debug ra `0.0.0.0`. Hãy chỉ để trên loopback, vì CDP có khả năng đọc, thao tác và chạy JavaScript trong renderer của ứng dụng; đây là một quyền điều khiển rất mạnh. ([GitHub][3])

## Thiết kế phù hợp cho `my-agent`

Bạn không cần sao chép cả bốn đường của OpenClaw. Có thể chỉ cần hai adapter:

```ts
interface DesktopAppDriver {
  inspect(): Promise<AppSnapshot>
  act(action: AppAction): Promise<AppActionResult>
  close(): Promise<void>
}
```

Hai implementation:

```ts
class ComputerUseDriver implements DesktopAppDriver {
  // screenshot + mouse + keyboard + accessibility
}

class CdpAppDriver implements DesktopAppDriver {
  // Chrome, Electron, VS Code, Chromium IDE
}
```

Router:

```ts
async function selectDriver(target: AppTarget) {
  if (target.cdpEndpoint && await canConnect(target.cdpEndpoint)) {
    return new CdpAppDriver(target.cdpEndpoint)
  }

  return new ComputerUseDriver(target)
}
```

Luồng thực tế:

```text
Yêu cầu điều khiển VS Code/Antigravity
        │
        ▼
Có CDP endpoint an toàn?
   ┌────┴────┐
  Có        Không
   │          │
CdpDriver  ComputerUseDriver
   │          │
   └────┬─────┘
        ▼
Native dialog xuất hiện?
        │
        ▼
Fallback OS driver
```

Đối với `my-agent`, đây là abstraction nên học từ ý tưởng OpenClaw:

> **Không phân chia theo tên ứng dụng, mà phân chia theo control surface: OS-level hay app-internal CDP.**

Điều này cho phép cùng một VS Code turn sử dụng CDP cho editor/sidebar và OS computer use cho native dialog, menu hoặc cửa sổ ngoài renderer.

[1]: https://docs.openclaw.ai/platforms/mac/peekaboo "Peekaboo bridge - OpenClaw"
[2]: https://github.com/electron/electron?utm_source=chatgpt.com "electron: Build cross-platform desktop apps with JavaScript ..."
[3]: https://github.com/vercel-labs/agent-browser?utm_source=chatgpt.com "vercel-labs/agent-browser"
[4]: https://github.com/openclaw/skills/blob/main/skills/daxiangnaoyang/daxiang-electron/SKILL.md "skills/skills/daxiangnaoyang/daxiang-electron/SKILL.md at main · openclaw/skills · GitHub"
[5]: https://github.com/vercel-labs/agent-browser/blob/main/skills/agent-browser/SKILL.md?utm_source=chatgpt.com "agent-browser/skills/agent-browser/SKILL.md at main"
[6]: https://github.com/openclaw/clawhub?utm_source=chatgpt.com "openclaw/clawhub: Skill + Plugin Registry for ..."
[7]: https://github.com/yazanbaker94/AntiGravity-AutoAccept?utm_source=chatgpt.com "AntiGravity AutoAccept that actually works and safe"
