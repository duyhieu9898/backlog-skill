---
name: Backlog
description: Manage configured Backlog projects through local API helper scripts, including project inspection, default project selection, issue listing/searching, flexible issue creation/update, personal UT bug creation, bug resolve workflow, and Story/Task overview.
---

# Backlog

## Khi Nào Dùng

Dùng skill này khi user muốn thao tác với Backlog qua API local: xem/search issue, tạo issue, cập nhật issue, đổi default project, inspect metadata project, hoặc tạo bug con theo workflow UT mặc định.

## Mô Hình Config

- Config chung: `{baseDir}/config/backlog.json`
- Project catalog từ API: `{baseDir}/config/projects/<PROJECT_KEY>.json`
- Workflow defaults: `{baseDir}/config/workflows/*.json`
- `backlog.json` chỉ giữ lựa chọn chung như `default_project_key`, user refs, và project keys.
- ID chi tiết như project id, issue type id, status id, category id, custom field id/value options nằm trong catalog riêng.
- Business defaults như UT bug, resolve bug, Story/Task overview nằm trong config workflow riêng.
- Nếu không truyền `--project`, script dùng `default_project_key`; khi user nêu project cụ thể thì truyền `--project <KEY>` thay vì đổi default toàn cục.

## Khả Năng

- Get issue theo key/id.
- List/search issue trong default project hoặc project chỉ định.
- List issue assign cho user mặc định.
- Tạo issue linh hoạt với issue type/category/custom field theo label hoặc ID.
- Update issue với summary, description, status, priority, assignee, dates, hours, custom fields, comment trong default project hoặc project chỉ định.
- Dry-run payload trước khi gọi API ghi dữ liệu.
- Inspect project để refresh catalog `config/projects/<PROJECT_KEY>.json`.
- Đổi default project và ghi vào `config/backlog.json`.
- Tạo sub-task bug theo default UT workflow.

## File Liên Quan

- Env: `{baseDir}/.env`
- Env example: `{baseDir}/.env.example`
- Runtime log: `{baseDir}/logs/backlog.log`
- Personal business logic: `{baseDir}/docs/business_logic.md`
- Bug workflow docs: `{baseDir}/docs/bug_workflow.md`
- Bug field guidance: `{baseDir}/docs/bug_field_guidance.md`
- Main config: `{baseDir}/config/backlog.json`
- Project catalogs: `{baseDir}/config/projects/OOP.json`, `{baseDir}/config/projects/AQM.json`, ...
- Workflow configs: `{baseDir}/config/workflows/ut_bug.json`, `{baseDir}/config/workflows/resolve_bug.json`, `{baseDir}/config/workflows/story_task_overview.json`
- Shared config module: `{baseDir}/backlog_tool/settings.py`
- Shared API client: `{baseDir}/backlog_tool/client.py`
- Shared resolver helpers: `{baseDir}/backlog_tool/resolver.py`
- Generic issue service: `{baseDir}/backlog_tool/issue_service.py`
- UT bug workflow: `{baseDir}/workflows/ut_bug.py`
- Bug template parser: `{baseDir}/workflows/bug_template.py`
- Personal bug resolve workflow: `{baseDir}/workflows/resolve_bug.py`
- Story/Task overview workflow: `{baseDir}/workflows/story_task_overview.py`
- Config CLI: `{baseDir}/scripts/backlog_config.py`
- Project inspector: `{baseDir}/scripts/inspect_project.py`
- Generic API CLI: `{baseDir}/scripts/backlog_api.py`
- Default UT bug CLI: `{baseDir}/scripts/create_ut_bug_default.py`
- Personal bug workflow CLI: `{baseDir}/scripts/bug_workflow.py`
- Story/Task overview CLI: `{baseDir}/scripts/story_task_overview.py`
- Tests: `{baseDir}/tests/`

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

Mặc định script ghi đè `config/projects/<PROJECT_KEY>.json`. Output là catalog/reference từ Backlog API, không chứa lựa chọn runtime như `issue_type`, `category`, `status`, `value`, `estimated_hours`, `due_in_days`.

## Generic API CLI

`backlog_api.py` dùng default project khi không truyền `--project`.

```bash
python3 scripts/backlog_api.py get OOP-123
python3 scripts/backlog_api.py list
python3 scripts/backlog_api.py list --me
python3 scripts/backlog_api.py list --query keyword
python3 scripts/backlog_api.py list --project OOP --query keyword
```

Create issue:

```bash
python3 scripts/backlog_api.py create "Summary" --desc "Description" --issue-type Bug --dry-run
python3 scripts/backlog_api.py create "Summary" --project OOP --issue-type Bug --category 112_DHP --dry-run
python3 scripts/backlog_api.py create "Summary" --issue-type Bug --category 112_DHP --custom qc_activity="Unit Test" --custom bug_origin=COD_Other --dry-run
```

Update issue:

```bash
python3 scripts/backlog_api.py update OOP-123 --summary "New summary" --dry-run
python3 scripts/backlog_api.py update OOP-123 --project OOP --summary "New summary" --dry-run
python3 scripts/backlog_api.py update OOP-123 --status "In Progress" --comment "Updated by agent" --dry-run
python3 scripts/backlog_api.py update OOP-123 --custom impacted=no --dry-run
```

## Default UT Bug

```bash
python3 scripts/create_ut_bug_default.py OOP-123 "A020100|FE" "Issue description"
python3 scripts/create_ut_bug_default.py --project OOP --dry-run OOP-123 "A020100|FE" "Issue description"
```

Workflow:

- Lấy parent issue từ Backlog.
- Tạo summary dạng `[PARENT_KEY][MODULE] description`.
- Dùng `config/workflows/ut_bug.json` và resolve ID/value từ project catalog.
- Category của UT bug lấy theo từng project trong `project_overrides`.
- Status của UT bug mặc định là `Closed`.
- Backlog create issue không nhận `statusId`, nên workflow tạo issue trước rồi update issue vừa tạo sang `Closed`.
- Set start date là hôm nay, due date theo `due_in_days`.
- Assign theo `defaults.assignee`, mặc định `me`.
- Tự sinh corrective action từ template `corrective_action`.

## Personal Bug Workflow

Đọc thêm trước khi làm task liên quan bug fixing/resolve:

- Business logic cá nhân: `{baseDir}/docs/business_logic.md`
- Quy trình bug: `{baseDir}/docs/bug_workflow.md`
- Hướng dẫn chọn field: `{baseDir}/docs/bug_field_guidance.md`

```bash
python3 scripts/bug_workflow.py my-open --project AQM
python3 scripts/bug_workflow.py context AQM-123
python3 scripts/bug_workflow.py resolve AQM-123 --actual-hours 1.5 --fix-description "Save issue" --comment "Fixed save issue"
python3 scripts/bug_workflow.py resolve AQM-123 --actual-hours 1.5 --apply
```

`my-open` lấy Bug chưa Closed đang assign cho user mặc định. `context` parse description theo template bug để agent có context fix. `resolve` mặc định là dry-run; chỉ ghi thật khi thêm `--apply`. Khi bug chuyển sang `Closed` hoặc `Resolved`, assignee chuẩn là `createdUser`. Khi có mô tả fix, truyền `--fix-description` để sinh `Corrective Action = fixed <mô tả lowercase>`. Khi cần chọn `qc_activity`, `bug_origin`, hoặc `cause_category`, đọc `docs/bug_field_guidance.md` trước.

## Quy Tắc Chọn Lệnh

- User muốn xem chi tiết issue: dùng `backlog_api.py get <ISSUE_KEY>`.
- User muốn tìm issue: dùng `backlog_api.py list`; nếu user nêu project thì thêm `--project`.
- User muốn tạo/cập nhật issue thông thường: dùng `backlog_api.py create/update` và chạy `--dry-run` trước khi ghi thật nếu request không hoàn toàn quen thuộc.
- User muốn tạo bug con theo workflow Unit Test mặc định: dùng `create_ut_bug_default.py`, ưu tiên `--dry-run` trước.
- User muốn lấy bug đang cần fix: dùng `bug_workflow.py my-open`.
- User muốn phân tích bug để fix: dùng `bug_workflow.py context <ISSUE_KEY>`.
- User muốn resolve bug theo rule cá nhân: dùng `bug_workflow.py resolve <ISSUE_KEY>` trước, chỉ thêm `--apply` sau khi payload đúng.
- User muốn xem tổng quan Story/Task assign cho mình: dùng `story_task_overview.py`.
- Story/Task overview trả `issueKey`, `summary`, `description`, `status`, `dueDate`, `daysUntilDue`, `dueAlertLevel`. `dueAlertLevel=1` là quá hạn, `dueAlertLevel=2` là còn dưới 2 ngày. Issue không có `dueDate` thì không cảnh báo.
- Với request liên quan bug fixing/resolve, đọc `docs/bug_workflow.md`; nếu cần chọn custom fields, đọc thêm `docs/bug_field_guidance.md`.
- Với request liên quan rule cá nhân như tạo UT bug, resolve tester bug, hoặc overview Story/Task, đọc `docs/business_logic.md`.
- Không đổi `default_project_key` chỉ để chạy một lệnh; dùng `--project` trước.

## Workflow Cho Agent

Khi bắt đầu một task Backlog:

- Xác định intent của user: xem/tìm issue, tạo issue, cập nhật issue, tạo UT bug, đổi config, hay inspect metadata.
- Xác định project: nếu user nêu project key thì dùng `--project <KEY>`; nếu không nêu thì kiểm tra default bằng `python3 scripts/backlog_config.py current` khi cần chắc chắn.
- Nếu thao tác cần metadata mới hoặc lỗi field/category/issue type không tồn tại, chạy inspect project: `python3 scripts/inspect_project.py <PROJECT_KEY>`.
- Với request ghi dữ liệu, kiểm tra đủ thông tin bắt buộc trước: summary/description, issue key hoặc parent key, module, status, category, assignee, custom fields.
- Chạy `--dry-run` trước cho create/update/UT bug nếu payload chưa hoàn toàn hiển nhiên hoặc user chưa xác nhận ghi thật.
- Đọc payload dry-run và đối chiếu projectId, issueTypeId, categoryId, assigneeId, dates, customField_* trước khi bỏ `--dry-run`. Với UT bug, kiểm tra thêm `postCreatePayload` vì status `Closed` được update sau khi tạo.
- Sau khi ghi thật thành công, báo issue key/link hoặc JSON response quan trọng cho user.
- Nếu lỗi API xảy ra, xem thêm `logs/backlog.log`; báo lại HTTP/API error, path, status, và context liên quan. Không đoán issue đã tạo nếu response không thành công.

Agent có thể làm:

- Get issue chi tiết theo key/id.
- List/search issue theo keyword, project, assignee mặc định hoặc assignee ID.
- Tạo issue thông thường với label hoặc ID cho issue type/category/custom fields.
- Cập nhật summary, description, status, priority, assignee, dates, hours, category, custom fields, và comment.
- Tạo sub-task bug theo workflow UT mặc định.
- Lấy context bug cá nhân từ template description.
- Chuẩn bị resolve bug theo rule cá nhân với dry-run mặc định.
- Xem tổng quan Story/Task assign cho user mặc định.
- Inspect project để refresh catalog metadata.
- Xem/đổi default project trong config.
- Chạy test offline để kiểm tra code sau khi sửa.

Agent không nên tự làm:

- Ghi thật lên Backlog khi request còn mơ hồ hoặc chưa có đủ dữ liệu bắt buộc.
- Đổi `default_project_key` chỉ để chạy một command đơn lẻ.
- Tự suy đoán status/category/custom field khi user chưa nói rõ và dry-run không đủ xác nhận.
- In `.env`, `BACKLOG_API_KEY`, hoặc full URL có query string.

## Lưu Ý An Toàn

- Tạo/cập nhật issue là thao tác ghi dữ liệu thật lên Backlog.
- Dùng `--dry-run` trước khi chạy lệnh create/update không quen thuộc.
- Các script ghi log runtime vào `logs/backlog.log` với timestamp, command, project, dry-run, API path/status và lỗi API body đã cắt ngắn.
- Chạy test offline bằng `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests`; test mock network và dùng fixture API thật đã lưu trong `tests/fixtures/`, không gọi Backlog thật.
- Nếu request ghi dữ liệu còn mơ hồ về summary, description, parent key, module, status, issue type, category hoặc custom fields, cần hỏi lại user.
- Không tự đổi status issue nếu user chỉ yêu cầu xem hoặc phân tích.
- Nếu API trả lỗi, báo HTTP/API error và context liên quan; không đoán issue đã được tạo khi không có response thành công.
- Không in hoặc log `BACKLOG_API_KEY`; log chỉ ghi API path như `/issues`, không ghi full URL kèm query string.
