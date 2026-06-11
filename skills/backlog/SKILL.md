---
name: Backlog
description: Manage configured Backlog projects through local API helper scripts.
---

# Backlog

## Khi Nào Dùng

User muốn thao tác Backlog: xem/search issue, tạo/cập nhật issue, tạo UT bug, resolve bug, đổi config, inspect project.

## Quy Ước Chung

- Entry point duy nhất: `python3 scripts/backlog.py` (chạy từ `skills/backlog/`).
- Output compact mặc định; `--json-full` cho raw JSON.
- Lệnh ghi mặc định dry-run; thêm `--apply` để ghi thật.
- Không truyền `--project` → dùng `default_project_key`; nêu project cụ thể → `--project <KEY>`.

## Quy Tắc Chọn Lệnh

| User muốn | Lệnh |
|-----------|------|
| Việc cần làm | `issue list` (thêm `--type Bug`/`--type Story` nếu cần) |
| Chi tiết issue | `issue get <KEY>` |
| Tìm keyword | `issue list --query <kw>` (thêm `--project` nếu cần) |
| Bug open + context | `bug my-open` |
| Story/Task + due alert | `story overview` |
| Phân tích bug để fix | `bug context <KEY>` |
| Tạo/cập nhật issue | `issue create/update` (dry-run mặc định) |
| Tạo UT bug con | `bug create-ut` (dry-run mặc định) |
| Resolve bug | `bug resolve <KEY>` → review diff → `--apply` |
| Rule/field guidance | `bug rules` / `bug fields <field>` |

Không đổi `default_project_key` chỉ cho một lệnh; dùng `--project`.

## Workflow Cho Agent

1. Xác định intent + project.
2. Metadata lỗi → `project inspect <KEY>` refresh catalog.
3. Lệnh ghi: kiểm tra field bắt buộc → dry-run → đối chiếu payload → `--apply`.
4. Thành công → báo issue key. Lỗi → xem `logs/backlog.log`, báo HTTP error.

## Agent Không Nên

- Ghi thật khi request mơ hồ hoặc thiếu dữ liệu bắt buộc.
- Suy đoán status/category/custom field khi user chưa nói rõ.
- Đổi status issue nếu user chỉ yêu cầu xem/phân tích.
- In `.env`, `BACKLOG_API_KEY`, full URL có query string.

## Đọc Thêm (khi cần)

- CLI syntax đầy đủ: `docs/cli_reference.md`
- Bug workflow chi tiết: `docs/bug_workflow.md`
- Bug field options: `docs/bug_field_guidance.md`
- Rule cá nhân: `docs/business_logic.md`
- Session trace convention: `docs/session_trace.md`
- Bàn giao / TODO: `HANDOVER.md`
