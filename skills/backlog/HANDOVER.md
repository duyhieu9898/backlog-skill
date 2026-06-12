# Backlog Skill — Handover / Overview

Tài liệu bàn giao giữa các session. Đọc file này trước khi tiếp tục làm việc với skill backlog.

Cập nhật lần cuối: 2026-06-11 (session 2).

> Lưu ý phạm vi: tài liệu này dành cho skill **backlog** (`skills/backlog/`). Skill BEMO nằm ở `skills/bemo/` và không liên quan đến công việc mô tả ở đây.

## 1. Skill này làm gì

Helper gọi Backlog API cho các project đã cấu hình, qua **một CLI gom nhóm** `scripts/backlog.py`. Tách bạch:

- `config/backlog.json`: lựa chọn runtime chung (default project, user refs, project keys).
- `config/projects/<KEY>.json`: catalog metadata từ API (project id, issue type, status, category, custom field id/option).
- `config/workflows/*.json`: business defaults cá nhân theo label (UT bug, resolve bug, story/task overview).

API key đọc từ `.env` (`BACKLOG_API_KEY`), không commit, không log.

## 2. Kiến trúc hiện tại

```text
scripts/backlog.py            # entry point duy nhất
scripts/<legacy>.py           # 6 shim mỏng forward sang CLI mới
backlog_tool/cli.py           # parser tree + dispatch + present() + đo lường
backlog_tool/presenter.py     # compact_issue / compact_bug / compact_story
backlog_tool/journal.py       # session trace log (logs/sessions/*.jsonl)
backlog_tool/inspect.py       # build + write project catalog
backlog_tool/settings.py      # config, log_event, log_metric, summarize_metrics
backlog_tool/client.py        # BacklogClient (HTTP)
backlog_tool/resolver.py      # resolve label -> id từ catalog
backlog_tool/issue_service.py # build/create/update payload generic
workflows/resolve_bug.py      # resolve bug cá nhân (diff + warnings)
workflows/ut_bug.py           # tạo UT sub-task bug
workflows/story_task_overview.py
workflows/guidance.py         # rule + field guidance dạng dữ liệu (thay docs dài)
workflows/bug_template.py     # parse description theo template bug
docs/*.md                     # bản tóm tắt, trỏ về lệnh CLI
tests/                        # 75 test offline, mock network + fixtures
```

Cây lệnh: `issue` / `bug` / `config` / `project` / `story` / `metrics` / `journal`. Xem `backlog.py --help` và `backlog.py <group> --help`.

## 3. Quy ước CLI (quan trọng)

- **Compact output mặc định**; `--json-full` để lấy raw JSON. Flag chạy ở **mọi vị trí** (đã strip khỏi argv trước khi parse).
- **Lệnh ghi mặc định dry-run**, thêm `--apply` để ghi thật: `issue create`, `issue update`, `bug resolve`, `bug create-ut`.
- Lỗi ra **stderr**; mỗi lần chạy đo vào `logs/metrics.log`.
- Không truyền `--project` thì dùng `default_project_key`.

## 4. Đã làm trong các session vừa rồi

### Đợt 1 — tiết kiệm token + chính xác hơn (trên `bug_workflow`)
- Compact output cho `my-open`, `context`, `resolve` (bỏ nulabAccount, iconUrl, milestones, attachments...).
- `resolve` dry-run trả `changes` (diff field cũ → mới) + `warnings` thay vì dump full context.
- Sửa Corrective Action fallback: strip prefix `[bug][key][module]` khỏi summary.
- Thêm cảnh báo khi thiếu `--fix-description`.
- Đưa rule + field guidance từ docs dài vào CLI: `bug rules`, `bug fields [<field>]` (`workflows/guidance.py`). Docs rút gọn còn bản tóm tắt trỏ về lệnh.

### Đợt 2 — gom CLI + đo lường (REFACTOR_PLAN.md)
- Gom 6 entry point rời thành một CLI `scripts/backlog.py` với nhóm lệnh + `--help`.
- Presenter dùng chung `backlog_tool/presenter.py`.
- Thống nhất quy ước: compact + `--json-full`, dry-run + `--apply`, lỗi ra stderr.
- Lớp đo lường: `log_metric` ghi `logs/metrics.log`; `metrics summary` tổng hợp runs / output bytes / p95 latency theo command.
- 6 script cũ thành shim forward (tự dịch quy ước `--dry-run` cũ sang `--apply`).
- Cập nhật `agent/commands.json`, `SKILL.md`, `README.md`, docs, thông báo lỗi UT bug.
- Tách `backlog_tool/inspect.py` để inspect logic dùng chung.

### Đợt 3 — review trước khi test
- Sửa footgun `--json-full` đặt sau action bị lỗi → giờ chạy mọi vị trí.
- Đồng bộ các docs còn dùng lệnh `bug_workflow.py` cũ sang `backlog.py bug ...`.
- Xác nhận `logs/metrics.log` được gitignore, `commands.json` hợp lệ.

### Đợt 4 — session trace + presenter improvements + issue list refactor
- **Session trace journal**: `backlog_tool/journal.py` + `logs/sessions/<date>_<command>.jsonl`. Mỗi lần chạy CLI (issue/bug/story) tự ghi entry `step: cli`. Agent ghi thêm `step: ai` (user request + AI response nguyên văn) qua `journal log-ai --stdin`.
- **Presenter gọn hơn**: drop null fields, drop customFields khi toàn null/"-"/empty, drop `Impacted: "-"` và `Corrective Action: "-"`.
- **`issue list` refactor (plan B)**: thêm `--open` (exclude Closed via API statusId[]), `--type` (repeatable, filter issueTypeId[]), `--view` (compact/bug/story) để thống nhất đọc dữ liệu. `bug my-open` và `story overview` giữ lại như shortcut.
- **`client.get_issues`** mở rộng nhận `status_ids`, `issue_type_ids` filter tại API level.
- **Steering file** `.kiro/steering/backlog-session-trace.md` (fileMatch: `skills/backlog/**`) nhắc agent ghi trace sau mỗi CLI call.
- **SKILL.md "Quy Tắc Chọn Lệnh"** rewrite cho convention mới (`--me --open` là lệnh mặc định khi user hỏi "get task").
- Thử và bỏ: cache phức tạp (TTL/invalidation/read-through) — quá over-engineer cho nhu cầu thực tế. Hook `postToolUse` — gây infinite loop và noise.

Test: **75 pass**.

Test: **75 pass** (`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests`).

## 5. Vấn đề tồn đọng / TODO

Ưu tiên cao → thấp:

1. **Presenter còn thừa field khi context rõ**: khi `--me` thì `assignee` lặp vô nghĩa; `priority: Normal` là default không cần hiện. Nên drop `assignee` khi có `--me`, drop `priority` khi = "Normal".
2. **Resolver trùng lặp**: `issue_service.resolve_status/resolve_priority` gọi API (`/projects/<key>/statuses`, `/priorities`) trong khi `resolver.resolve_status` resolve từ catalog local. Nên hợp nhất về một nguồn (ưu tiên catalog, fallback API) để bớt round-trip và bớt nhầm hai hàm `resolve_status` cùng tên.
3. **`get_issues` count=100 cứng** trong `client.py`, không phân trang — project nhiều issue bị cắt âm thầm. Nên cho tham số count và/hoặc cảnh báo khi chạm trần.
4. **`issue list --assignee` nhận `type=int`** trong khi các workflow resolve user ref từ config. Chưa thống nhất cách nhận diện user giữa các lệnh.
5. **Session trace `log-ai` phụ thuộc agent tự giác gọi** — steering file nhắc nhưng không enforce. Chấp nhận hiện tại.
6. **Corrective Action vẫn nên khuyến khích `--fix-description`**: fallback summary đã sạch hơn nhưng vẫn là tiêu đề, không phải mô tả fix.

## 6. Cách kiểm tra nhanh

```bash
# Test offline (không gọi Backlog thật)
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests

# Help
python3 scripts/backlog.py --help
python3 scripts/backlog.py bug --help

# Đo lường
python3 scripts/backlog.py metrics summary

# Session trace
python3 scripts/backlog.py journal list
python3 scripts/backlog.py journal read <filename>
```

## 7. Lưu ý an toàn (giữ nguyên)

- Lệnh ghi mặc định dry-run; review payload/diff rồi mới `--apply`.
- Không in/log `BACKLOG_API_KEY`; log API path (vd `/issues`), không log full URL có query string.
- Khi resolve/ tạo bug còn mơ hồ về summary/description/parent/module/status/category/custom field → hỏi lại user.
- Không tự đổi status issue nếu user chỉ yêu cầu xem/phân tích.
- Khi API lỗi: báo HTTP/API error + context, xem `logs/backlog.log`; không đoán issue đã tạo khi không có response thành công.

## 8. File tham chiếu

- Tổng quan + cách dùng cho agent: `SKILL.md`
- Hướng dẫn người dùng: `README.md`
- Rule cá nhân: `docs/business_logic.md`, `docs/bug_workflow.md`, `docs/bug_field_guidance.md` (đều trỏ về lệnh CLI)
- Steering (auto-inject khi đọc file backlog): `.kiro/steering/backlog-session-trace.md`
- Session logs: `logs/sessions/<date>_<command>.jsonl`
