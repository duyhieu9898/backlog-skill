---
name: Browser Capability
description: Tự động hoá tương tác trình duyệt thông qua Playwright, thu thập snapshot cây accessibility và thực hiện click, fill, type, press, select, scroll, wait.
---

# Browser Capability

Skill này cung cấp hướng dẫn cách tương tác trực tiếp với trình duyệt Chromium qua Playwright để thực hiện tự động hoá web.

## Khi Nào Dùng

Dùng skill này khi người dùng yêu cầu truy cập một trang web, đăng nhập, tìm kiếm thông tin, điền form, chụp ảnh màn hình trang web, hoặc thực hiện tương tác UI phức tạp.

## Khả Năng

- Khởi chạy và quản lý vòng đời của trình duyệt (`start`, `stop`, `status`).
- Quản lý tab (`tabs`, `open`, `focus`, `close`).
- Điều hướng và chụp ảnh màn hình (`navigate`, `screenshot`).
- Trích xuất cây Accessibility đại diện cho DOM (`snapshot`).
- Tương tác UI bằng các hành động được định nghĩa sẵn (`act`).

## Luồng Tương Tác Chuẩn

1. **Khởi chạy / Mở tab**: Sử dụng `browser.open` với URL mục tiêu để tạo tab mới.
2. **Snapshot**: Luôn gọi `browser.snapshot` trước khi thực hiện hành động trên tab để thu thập các reference (ví dụ: `e1`, `e2`) đại diện cho các phần tử tương tác.
3. **Thực hiện hành động**: Sử dụng `browser.act` với các hành động như `click`, `fill`, `type`, `press`, `select`, `scroll`, hoặc `wait`.

## Tham Khảo Chi Tiết

Để biết chi tiết các luồng làm việc, chính sách an toàn, và cách xử lý lỗi, hãy đọc các tài liệu sau:
- [Quy trình làm việc](file:///home/hieund/Downloads/my-agents/skills/browser/references/workflow.md)
- [Chính sách an toàn](file:///home/hieund/Downloads/my-agents/skills/browser/references/safety.md)
- [Hướng dẫn xử lý lỗi](file:///home/hieund/Downloads/my-agents/skills/browser/references/errors.md)
