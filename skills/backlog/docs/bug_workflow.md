# Bug Workflow

Quy trình resolve bug được mã hóa trong CLI. Không cần đọc rule dài ở đây — chạy lệnh để lấy đúng logic hiện hành.

## Lấy rule và field guidance

```bash
python3 scripts/backlog.py bug rules              # rule resolve bug, sinh từ config/workflows/resolve_bug.json
python3 scripts/backlog.py bug fields             # các field cần chọn khi resolve
python3 scripts/backlog.py bug fields bug_origin  # option + ý nghĩa của 1 field
```

`rules` trả về: điều kiện áp dụng, các action (status, assignee về creator, dates, hours), field luôn ghi đè (`impacted`, `corrective_action`), field chỉ set khi trống, default values, các flag override, và lưu ý an toàn.

## Lệnh chính

```bash
python3 scripts/backlog.py bug my-open --project AQM
python3 scripts/backlog.py bug context AQM-123
python3 scripts/backlog.py bug resolve AQM-123 --actual-hours 1.5 --fix-description "Save issue"
python3 scripts/backlog.py bug resolve AQM-123 --apply
```

- Output mặc định compact; thêm `--json-full` khi cần raw JSON.
- `resolve` mặc định dry-run, trả `changes` (diff field cũ → mới) và `warnings`. Đọc `changes` để verify thay vì dump cả issue. Chỉ thêm `--apply` sau khi diff đúng.
- `context` parse description theo template bug; nếu `descriptionMeta.hasTemplateMarkers=false` hoặc thiếu section quan trọng, dùng thêm `rawDescription` cho AI fallback. Không bịa thông tin không có trong issue.

## Corrective Action

- Có `--fix-description`: `Corrective Action = fixed <text lowercased>`.
- Không có: fallback summary đã bỏ prefix `[bug][key][module]`, và script thêm cảnh báo vào `warnings`. Ưu tiên luôn truyền `--fix-description`.

## Agent Flow

1. `context <ISSUE_KEY>` để xem bug.
2. `fields <field>` trước khi chọn `qc_activity`, `bug_origin`, `cause_category`.
3. `resolve` dry-run với hours/comment/field values.
4. Đọc `changes` và `warnings`.
5. `--apply` sau khi diff đúng hoặc user xác nhận.
