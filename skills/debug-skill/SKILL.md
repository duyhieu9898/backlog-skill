---
name: Debug Skill
description: Hỗ trợ truy vấn và phân tích logs, trace events, và lịch sử chạy lệnh hệ thống cho các Agent phát triển (Developer Agents).
---

# Debug Skill

## Khi Nào Dùng

Dùng skill này khi một Developer Agent hoặc người dùng muốn điều tra chi tiết các bước xử lý của AI, các lệnh terminal bị lỗi hoặc tìm vết sự kiện từ trace ID.

## Khả Năng

Skill này cung cấp một tool chuyên biệt `debug.query` để truy vấn trực tiếp cơ sở dữ liệu SQLite và thư mục logs của Agent:
- Xem chi tiết danh sách sự kiện (`trace_events`) của một phiên chat qua Trace ID.
- Liệt kê và xem chi tiết kết quả chạy lệnh terminal (`command_runs`) bao gồm exit code và output tail.
- Đọc file ghi log thô các cuộc hội thoại AI (`logs/ai-interactions/`) theo ngày và trace ID.

## File Liên Quan

- Script truy vấn chính: `{baseDir}/scripts/query.py`

## Hướng Dẫn Sử Dụng Tool `debug.query`

### 1. Truy vấn các Trace Events
Gửi JSON vào stdin của `debug.query` với action `"traces"` và `traceId`:
```json
{
  "action": "traces",
  "traceId": "tr_xxxx_yyyy"
}
```

### 2. Xem các Command Runs gần đây
Gửi JSON vào stdin với action `"commands"` và giới hạn `limit`:
```json
{
  "action": "commands",
  "limit": 5
}
```

### 3. Xem chi tiết kết quả chạy của 1 Command Run cụ thể
Gửi JSON với action `"runs"` và `traceId`:
```json
{
  "action": "runs",
  "traceId": "tr_xxxx_yyyy"
}
```

### 4. Đọc Raw AI Interaction Logs
Gửi JSON với action `"ai-logs"` và `traceId`:
```json
{
  "action": "ai-logs",
  "traceId": "tr_xxxx_yyyy"
}
```
