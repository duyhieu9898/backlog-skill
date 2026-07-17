# Skills

Tài liệu ngắn này mô tả format `SKILL.md` để một agent hoặc AI API có thể đọc, chọn và nạp đúng skill khi xử lý yêu cầu.

## Skill Là Gì

Một skill là một thư mục có file `SKILL.md`.

```text
my-agents/
├── skills/
│   ├── bemo/
│   │   └── SKILL.md
│   ├── gmail/
│   │   └── SKILL.md
│   └── linux-janitor/
│       └── SKILL.md
└── agent/
```

Tên thư mục trong `skills/` là `slug` của skill. Ví dụ: `bemo`, `gmail`, `linux-janitor`.

## Vai Trò Của SKILL.md

`SKILL.md` giúp AI hiểu:

- Skill này dùng cho việc gì.
- Khi nào nên chọn skill này.
- Skill có những khả năng nào.
- Những file/script/config nào quan trọng.
- Rủi ro hoặc lưu ý khi thao tác.

`SKILL.md` không phải là cơ chế phân quyền. Quyền chạy command nằm ở config riêng của agent, ví dụ `agent/commands.json`.

## Format SKILL.md

`SKILL.md` có thể có YAML frontmatter ở đầu file, sau đó là nội dung hướng dẫn bằng Markdown.

```markdown
---
name: Bemo Automation
description: Automate Bemo attendance, checkout, time-off sync, and related scripts.
---

## Khi Nào Dùng

Dùng skill này khi user muốn thao tác với Bemo attendance, checkout, time-off hoặc dữ liệu chấm công.

## Khả Năng

- Checkout Bemo attendance.
- Đồng bộ dữ liệu attendance/time-off.
- Tạo và verify time-off request.

## Ngữ Cảnh Quan Trọng

- Project này là Node.js.
- Cần session Bemo đã login.
- Các script có thể tạo tác động thật lên Bemo.

## File Liên Quan

- Config mẫu: `{baseDir}/.env.example`
- Script cron Telegram: `{baseDir}/scripts/run-cron-telegram.js`
```

Frontmatter nên có:

| Field | Bắt buộc | Ý nghĩa |
|---|---:|---|
| `name` | Không | Tên hiển thị của skill. Nếu thiếu, dùng tên thư mục. |
| `description` | Có | Mô tả ngắn để AI tìm đúng skill. |

## Command Shortcuts

Command được phép chạy nên nằm ở một tầng config riêng của agent, không bắt buộc khai báo trong từng `SKILL.md`.

Ví dụ `agent/commands.json`:

```json
{
  "allow": [
    {
      "name": "bemo.checkout",
      "label": "Bemo checkout",
      "skillSlug": "bemo",
      "aliases": ["/bemo-checkout", "bemo checkout"],
      "cwd": "../skills/bemo",
      "argv": ["npm", "run", "checkout"],
      "requiresConfirmation": true,
      "externalSideEffect": true
    }
  ]
}
```

Khuyến nghị:

- Chỉ dùng command cụ thể với `argv` cố định; wildcard và raw shell bị vô hiệu hóa.
- `cwd` phải trỏ đúng thư mục của `skillSlug`; catalog lỗi thời sẽ bị từ chối khi load.
- Command chạy không qua shell và chỉ nhận tập environment tối thiểu.
- Command ghi dữ liệu thật nên có cơ chế confirmation trong `agent/commands.json`.

## Cách Agent Load Skill

Quy trình tối thiểu:

1. Quét các thư mục con trong `skills/`.
2. Thư mục nào có `SKILL.md` thì xem là một skill.
3. Parse frontmatter nếu có.
4. Tạo danh sách metadata:

```json
{
  "slug": "bemo",
  "name": "Bemo Automation",
  "description": "Automate Bemo attendance, checkout, time-off sync, and related scripts.",
  "path": "/home/hieund/Downloads/my-agents/skills/bemo/SKILL.md",
  "baseDir": "/home/hieund/Downloads/my-agents/skills/bemo"
}
```

5. Khi user gửi yêu cầu, so khớp yêu cầu với `slug`, `name`, `description`.
6. Chỉ đọc toàn bộ `SKILL.md` của skill phù hợp, không nạp tất cả skill vào prompt nếu không cần.

Registry tiếp tục nạp các skill hợp lệ nếu một skill khác có frontmatter lỗi.
Các lỗi bị bỏ qua phải xuất hiện trong `/status` và `/skills`; không được làm
agent dừng khởi động chỉ vì một package skill hỏng.

## Cách Chọn Skill

Ưu tiên chọn skill khi:

- User nhắc trực tiếp tên skill hoặc tên thư mục, ví dụ `bemo`, `gmail`.
- Nội dung request khớp rõ với `description`.
- Request cần script, config hoặc workflow nằm trong thư mục skill đó.

Nếu nhiều skill cùng khớp:

- Chọn skill khớp cụ thể nhất trước.
- Ưu tiên cụm slug hoặc name được nhắc trực tiếp, sau đó mới chấm điểm token
  trong description.
- Nếu các kết quả cao nhất bằng điểm, không tự chọn skill.
- Nếu không chắc, hỏi lại user thay vì đoán và chạy script rủi ro.

## Nội Dung Nên Có Trong SKILL.md

Một `SKILL.md` tốt nên ngắn và thực dụng:

- Khi nào dùng skill này.
- Skill này có khả năng gì.
- File config hoặc script quan trọng.
- Biến môi trường cần có.
- Quy tắc an toàn trước khi thao tác có tác động thật.
- Ví dụ request thường gặp và cách hiểu intent.

Không nên nhét log dài, tài liệu sản phẩm đầy đủ, hoặc hướng dẫn không liên quan. Nếu cần tài liệu dài, đặt ở file riêng và link từ `SKILL.md`.

## File Liên Quan

Trong nội dung skill, có thể tham chiếu file cùng thư mục bằng `{baseDir}`.

```markdown
Config mẫu: {baseDir}/.env.example
Script chính: {baseDir}/scripts/run.py
```

Khi load skill, agent thay `{baseDir}` bằng đường dẫn tuyệt đối của thư mục skill.

## Gợi Ý Prompt Cho AI API

Khi tích hợp AI API, gửi metadata skill và command catalog:

```text
Available skills:
- bemo: Automate Bemo attendance, checkout, time-off sync, and related scripts.
- gmail: Manage Gmail helper scripts.
- linux-janitor: Clean up Linux system files and maintenance tasks.

Allowed commands:
- bemo.checkout: Bemo checkout
- bemo.sync: Bemo sync data
```

Sau khi model chọn skill, mới gửi nội dung `SKILL.md` tương ứng vào context nếu cần:

```text
Use this skill for the current task:
<skill slug="bemo" baseDir="/home/hieund/Downloads/my-agents/skills/bemo">
...content of skills/bemo/SKILL.md...
</skill>
```

Cách này giữ prompt ngắn, giảm chi phí token và tránh model bị nhiễu bởi skill không liên quan.

## Nguyên Tắc An Toàn

- `SKILL.md` là tài liệu hướng dẫn, không phải cơ chế phân quyền.
- Command thật được kiểm soát bởi catalog config của agent.
- Không đưa secret vào `SKILL.md`; dùng `.env` hoặc biến môi trường.
- Nếu skill có script gửi request ra ngoài, ghi rõ service nào được gọi.
- Không dùng wildcard hoặc raw shell; chỉ khai báo argv cố định đã review.
