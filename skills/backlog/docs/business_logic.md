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

Dùng rule này khi resolve bug có `Detected Role = Tester` và hiện đang assign cho tôi.

Nếu không đọc được `Detected Role`, vẫn có thể resolve theo yêu cầu rõ ràng của user, nhưng phải nêu rõ điểm này trong phần tóm tắt dry-run.

Các field thường đã có giá trị và không được đổi chỉ vì workflow resolve:

- `Detected Role`
- `Summary`
- `Description`
- `QC Activity`

Hành động resolve:

- Đổi status thành `Resolved`.
- Assign issue về `createdUser`.
- Set các field còn thiếu theo rule bên dưới.
- `Impacted` luôn update đè.
- `Corrective Action` luôn update đè.

Khi bug được chuyển sang trạng thái kết thúc như `Closed` hoặc `Resolved`, assignee chuẩn là người tạo issue (`createdUser`).

Các field chỉ set khi hiện đang trống:

- `Start Date = hôm nay`
- `Due Date = Start Date + 2 ngày`
- `Bug Origin = COD_Other` hoặc giá trị phù hợp hơn theo ngữ cảnh
- `Cause Category = Not Applicable` hoặc giá trị phù hợp hơn theo ngữ cảnh
- `Estimated Hours = 1`
- `Actual Hours = 1`
- `Resolution = fixed`

Nếu user truyền `estimated hours` thì dùng giá trị user truyền; nếu không truyền và `estimatedHours` đang trống thì set `1`.

Nếu user truyền `actual hours` thì dùng giá trị user truyền; nếu không truyền và `actualHours` đang trống thì set `1`.

Các field luôn update đè:

- `Impacted = no`
- `Corrective Action = fixed {description_lower}`

Hai field này là ngoại lệ: update đè kể cả đã có value.

`description_lower` nên lấy từ mô tả fix do user cung cấp nếu có, ví dụ tham số `--fix-description`. Nếu không có, dùng issue summary. Summary luôn được xem là có giá trị.

Khi chọn giá trị theo ngữ cảnh cho `Bug Origin` và `Cause Category`, đọc `docs/bug_field_guidance.md`.

Thứ tự ưu tiên khi chọn field theo ngữ cảnh:

1. Dùng giá trị user chỉ định.
2. Nếu agent đủ chắc dựa trên bug context và `docs/bug_field_guidance.md`, chọn giá trị phù hợp hơn default.
3. Nếu không đủ chắc, dùng default và nói rõ điểm chưa chắc trong phần tóm tắt dry-run.

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
