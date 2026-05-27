---
name: Backlog
description: Manage configured Backlog projects through local API helper scripts, including project inspection, default project selection, issue listing/searching, flexible issue creation/update, and default UT bug creation.
---

# Backlog

## Khi Nào Dùng

Dùng skill này khi user muốn thao tác với Backlog qua API local: xem/search issue, tạo issue, cập nhật issue, đổi default project, inspect metadata project, hoặc tạo bug con theo workflow UT mặc định.

## Mô Hình Config

- Config chung: `{baseDir}/config/backlog.json`
- Project catalog từ API: `{baseDir}/config/<PROJECT_KEY>.json`
- `backlog.json` chỉ giữ lựa chọn chung như `default_project_key`, user refs, project keys, `bug_defaults`, và project overrides.
- ID chi tiết như project id, issue type id, category id, custom field id/value options nằm trong catalog riêng.
- Các script luôn làm việc với `default_project_key`; muốn đổi project thì chạy `backlog_config.py set-default <KEY>`.

## Khả Năng

- List/search issue trong default project.
- List issue assign cho user mặc định.
- Tạo issue linh hoạt với issue type/category/custom field theo label hoặc ID.
- Update issue với summary, description, status, priority, assignee, dates, hours, custom fields, comment.
- Dry-run payload trước khi gọi API ghi dữ liệu.
- Inspect project để refresh catalog `config/<PROJECT_KEY>.json`.
- Đổi default project và ghi vào `config/backlog.json`.
- Tạo sub-task bug theo default UT workflow.

## File Liên Quan

- Env: `{baseDir}/.env`
- Env example: `{baseDir}/.env.example`
- Main config: `{baseDir}/config/backlog.json`
- Project catalogs: `{baseDir}/config/OOP.json`, `{baseDir}/config/AQM.json`, ...
- Shared config module: `{baseDir}/scripts/backlog_settings.py`
- Config CLI: `{baseDir}/scripts/backlog_config.py`
- Project inspector: `{baseDir}/scripts/inspect_project.py`
- Generic API CLI: `{baseDir}/scripts/backlog_api.py`
- Default UT bug CLI: `{baseDir}/scripts/create_ut_bug_default.py`

## Biến Môi Trường

- `BACKLOG_API_KEY`: required để gọi Backlog API. Không in hoặc commit key thật.

## Lệnh Config

```bash
python3 scripts/backlog_config.py list-projects
python3 scripts/backlog_config.py current
python3 scripts/backlog_config.py set-default AQM
python3 scripts/backlog_config.py show
```

`set-default <PROJECT_KEY>` chỉ nhận project key đã có trong `config/backlog.json`.

## Inspect Project

```bash
python3 scripts/inspect_project.py AQM
python3 scripts/inspect_project.py OOP --stdout
```

Mặc định script ghi đè `config/<PROJECT_KEY>.json`. Output là catalog/reference từ Backlog API, không chứa lựa chọn runtime như `issue_type`, `category`, `value`, `estimated_hours`, `due_in_days`.

## Generic API CLI

`backlog_api.py` luôn dùng default project.

```bash
python3 scripts/backlog_api.py list
python3 scripts/backlog_api.py list --me
python3 scripts/backlog_api.py list --query keyword
```

Create issue:

```bash
python3 scripts/backlog_api.py create "Summary" --desc "Description" --issue-type Bug --dry-run
python3 scripts/backlog_api.py create "Summary" --category 112_DHP --custom qc_activity="Unit Test" --custom bug_origin=COD_Other --dry-run
```

Update issue:

```bash
python3 scripts/backlog_api.py update OOP-123 --summary "New summary" --dry-run
python3 scripts/backlog_api.py update OOP-123 --status "In Progress" --comment "Updated by agent" --dry-run
python3 scripts/backlog_api.py update OOP-123 --custom impacted=no --dry-run
```

## Default UT Bug

```bash
python3 scripts/create_ut_bug_default.py OOP-123 "A020100|FE" "Issue description"
```

Workflow:

- Lấy parent issue từ Backlog.
- Tạo summary dạng `[PARENT_KEY][MODULE] description`.
- Dùng `bug_defaults` trong `backlog.json` và resolve ID/value từ project catalog.
- Set start date là hôm nay, due date theo `due_in_days`.
- Assign theo `defaults.assignee`, mặc định `me`.
- Tự sinh corrective action từ template `corrective_action`.

## Lưu Ý An Toàn

- Tạo/cập nhật issue là thao tác ghi dữ liệu thật lên Backlog.
- Dùng `--dry-run` trước khi chạy lệnh create/update không quen thuộc.
- Nếu request ghi dữ liệu còn mơ hồ về summary, description, parent key, module, status, issue type, category hoặc custom fields, cần hỏi lại user.
- Không tự đổi status issue nếu user chỉ yêu cầu xem hoặc phân tích.
- Nếu API trả lỗi, báo HTTP/API error và context liên quan; không đoán issue đã được tạo khi không có response thành công.
