# Bug Field Guidance

Field guidance được mã hóa trong CLI. Chạy lệnh để lấy option + ý nghĩa thay vì đọc bảng dài ở đây:

```bash
python3 scripts/backlog.py bug fields            # liệt kê field
python3 scripts/backlog.py bug fields qc_activity
python3 scripts/backlog.py bug fields bug_origin
python3 scripts/backlog.py bug fields cause_category
```

Dùng label, không dùng ID. Resolver tự map label sang ID theo project từ `config/projects/<PROJECT>.json`.

## Quy tắc chọn

1. Ưu tiên giá trị user chỉ định (`--qc-activity`, `--bug-origin`, `--cause-category`).
2. Nếu đủ chắc dựa trên bug context và output `fields <field>`, chọn giá trị phù hợp hơn default.
3. Nếu không chắc, dùng default (xem trong `fields <field>`) và nêu rõ điểm chưa chắc trong tóm tắt dry-run.
4. Không `--apply` khi chưa được user xác nhận.
