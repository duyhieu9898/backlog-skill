# Business Logic Cá Nhân Cho Backlog

Tài liệu này mô tả các rule workflow cá nhân nằm trên các thao tác Backlog generic.

## Nguyên Tắc Chung

- Dùng label trong config/docs, không dùng trực tiếp raw option ID. Option ID khác nhau theo project và phải được resolve từ `config/projects/<PROJECT>.json`.
- `Detected Role` chỉ cần set trong workflow tạo UT bug do developer tạo. Các workflow khác không cần sửa field này.
- Khi set `Detected Role`, agent phải resolve label từ project catalog. Label thường dùng là `Developer`, nhưng giá trị chính xác phải lấy từ catalog của project.
- Nếu không resolve được label `Developer`, inspect project trước; không tự đoán ID.
- Luôn dry-run trước khi ghi dữ liệu lên Backlog, trừ khi user yêu cầu apply rõ ràng và payload đã chắc chắn đúng.
- Với rule ngày tháng, `Start Date` là ngày hiện tại theo local time và `Due Date` là `Start Date + 2 ngày`.

## UT Bug Do Developer Tạo

Dùng rule này khi tạo UT bug/sub-task từ parent ticket.

Các field cố định:

- `QC Activity = Unit Test`
- `Detected Role = Developer`, resolve label từ project catalog
- `Assignee = me`
- `Status = Closed`
- `Start Date = hôm nay`
- `Due Date = Start Date + 2 ngày`

Backlog create issue không nhận `statusId`, nên workflow tạo UT bug trước rồi update issue vừa tạo sang `Closed`.

Các field theo ngữ cảnh hoặc default:

- `Estimated Hours = 1`
- `Actual Hours = 1`
- `Summary = [Parent Ticket][Module] IssueDescription`
- `Description = bug template`
- `Category` lấy theo project trong `config/workflows/ut_bug.json` phần `project_overrides`
- `Bug Origin = COD_Other`
- `Cause Category = Not Applicable`
- `Impacted = no`
- `Corrective Action = fixed {description_lower}`

Với UT bug, `description_lower` chính là `IssueDescription` trong Summary, chuyển về lowercase.

Template mặc định cho bug description:

```markdown
**Environment**:

 **Pre-Condition**:
-

 **Steps to reproduce**:
1.
2.

**Actual**:

**Expected**:

 **Evidence**:
```

Nếu AI cập nhật description, phải giữ cấu trúc template này và điền nội dung vào đúng section. Nếu không đủ context, dùng nguyên template làm default thay vì tự bịa nội dung.

Khi tạo mới, dùng template chuẩn như trên. Parser vẫn cần linh hoạt vì QC/tester có thể chỉnh description và làm mất `**` ở cuối heading.

## Resolve Bug Do Tester Tạo

Rule resolve bug đã được mã hóa trong CLI. Chạy lệnh để lấy logic hiện hành thay vì đọc lại ở đây:

```bash
python3 scripts/backlog.py bug rules
python3 scripts/backlog.py bug fields <field>
```

Tóm tắt: resolve áp dụng cho issue type `Bug` đang assign cho tôi; đổi status `Resolved`, assign về `createdUser`, set date/hours còn thiếu, luôn ghi đè `impacted` và `corrective_action`, các field khác chỉ set khi trống. `resolve` mặc định dry-run và trả `changes` + `warnings`; chỉ `--apply` sau khi diff đúng. Nếu không đọc được `Detected Role`, vẫn resolve theo yêu cầu rõ ràng của user nhưng phải nêu rõ trong tóm tắt dry-run. Chi tiết default, field guidance, và quy tắc chọn theo ngữ cảnh nằm trong output `rules`/`fields`.

## Tổng Quan Story/Task

Dùng rule này khi user hỏi tổng quan project hoặc các việc còn lại.

Đọc các issue thỏa điều kiện:

- issue type là `Story` hoặc `Task`
- status không phải `Closed`, chỉ loại status `Closed`
- assignee là `me`
- không lấy task con hoặc issue con nếu item đó không assign cho `me`

Trả về tổng quan ngắn gọn, có thể group theo issue type/status nếu hữu ích, gồm:

- issue key
- summary
- description
- status
- due date
- số ngày còn lại tới due date
- cảnh báo due date

Không update Story/Task nếu user không yêu cầu rõ ràng.

Rule cảnh báo due date:

- `dueAlertLevel = 1`: issue đã quá hạn, tức due date trước ngày hiện tại.
- `dueAlertLevel = 2`: issue còn dưới 2 ngày tới due date, gồm due hôm nay hoặc ngày mai.
- Issue không có `dueDate` thì bỏ qua cảnh báo, không xem đó là lỗi cần nhắc.
- `dueAlertLevel = null`: chưa cần cảnh báo hoặc không có due date.
