# Hướng Dẫn Xử Lý Lỗi Trình Duyệt

Tài liệu này mô tả các mã lỗi phổ biến khi tự động hoá trình duyệt và cách khắc phục tương ứng.

## 1. STALE_ELEMENT_REF (Lỗi tham chiếu cũ)

- **Nguyên nhân**: Trang web đã cập nhật (tải lại hoặc thay đổi DOM động bằng JS) khiến `snapshotId` cũ không còn khớp với trạng thái hiện tại của phần tử trên trang.
- **Cách tự động sửa của Hệ thống**:
  - Hệ thống tự động phát hiện mã lỗi `STALE_ELEMENT_REF` có cờ `retryable: true`.
  - Một bước `browser.snapshot` mới sẽ tự động được chạy ngầm.
  - Hệ thống tự động so khớp lại element dựa trên `role` và `name` của phần tử ban đầu để lấy `refId` mới trên snapshot mới, rồi tự động thực thi lại hành động của bạn đúng 1 lần.
- **Cách xử lý thủ công (nếu lỗi vẫn tiếp diễn)**:
  - Nếu hành động vẫn thất bại sau khi tự động thử lại, bạn cần gọi `browser.snapshot` thủ công để có snapshot mới nhất, phân tích lại danh sách refs và thực hiện lại hành động với ref mới.

## 2. ELEMENT_NOT_FOUND (Không tìm thấy phần tử)

- **Nguyên nhân**: Phần tử với ref tương ứng không còn tồn tại trên trang, hoặc selector fallback không tìm thấy phần tử nào khớp với `role` và `name`.
- **Cách khắc phục**:
  - Gọi lại `browser.snapshot` để kiểm tra xem phần tử có bị ẩn, bị xóa hoặc đổi tên hay không.
  - Đảm bảo rằng trang đã tải xong (có thể sử dụng hành động `wait` trước khi snapshot).

## 3. ACTION_TIMEOUT (Hết thời gian tương tác)

- **Nguyên nhân**: Thao tác click/fill/type kéo dài quá 5000ms mà không phản hồi (có thể do trang bị treo hoặc element bị che khuất).
- **Cách khắc phục**:
  - Thử cuộn trang bằng hành động `scroll` để đưa element vào vùng nhìn thấy (viewport).
  - Tăng thời gian chờ bằng cách thêm hành động `wait` trước khi thực hiện tương tác.

## 4. NAVIGATION_BLOCKED (Điều hướng bị chặn)

- **Nguyên nhân**: Trang web cố gắng điều hướng sang một URL nằm ngoài danh sách cho phép (ví dụ: HTTP không bảo mật hoặc địa chỉ IP mạng nội bộ).
- **Cách khắc phục**:
  - Thông báo cho người dùng rằng URL này không an toàn hoặc bị chặn bởi chính sách bảo mật của hệ thống.
