# Hướng Dẫn Quy Trình Làm Việc Trình Duyệt

Tài liệu này hướng dẫn cách thực hiện một luồng thao tác web chuẩn một cách an toàn và tối ưu tài nguyên.

## Quy Trình Từng Bước

### Bước 1: Khởi chạy và Mở trang
Sử dụng tool `browser` với action `open`:
```json
{
  "action": "open",
  "url": "https://example.com"
}
```
Nhận về `targetId` đại diện cho Tab đó.

### Bước 2: Tạo Snapshot để Lấy Element Ref
Trước khi click hoặc điền form, bạn bắt buộc phải có snapshot hiện tại của trang để lấy các element ref (`e1`, `e2`,...).
```json
{
  "action": "snapshot",
  "targetId": "tab_xxxx"
}
```
Cây accessibility trả về sẽ hiển thị các phần tử tương tác dưới dạng:
`- button "Đăng nhập" [ref=e1]`

### Bước 3: Thực hiện tương tác
Sử dụng `browser.act` cùng với `targetId` và request cụ thể. Luôn gửi kèm `snapshotId` thu được từ Bước 2.
```json
{
  "action": "act",
  "targetId": "tab_xxxx",
  "request": {
    "kind": "click",
    "ref": "e1",
    "snapshotId": "snap_yyyy"
  }
}
```

### Bước 4: Kiểm tra kết quả
Sau mỗi bước tương tác, tool tự động trả về một ảnh chụp màn hình (`BROWSER_ACTION_COMPLETED` đi kèm `artifactId`). Hãy kiểm tra trực quan ảnh chụp này hoặc gọi lại `browser.snapshot` nếu cần phân tích cấu trúc DOM mới trước khi tiếp tục.

### Bước 5: Đóng trình duyệt / Dọn dẹp
Khi hoàn thành công việc hoặc khi chuyển sang tác vụ khác không liên quan, hãy đóng các tab không dùng bằng `browser.close` hoặc dừng hẳn trình duyệt qua `browser.stop` để tiết kiệm tài nguyên.
