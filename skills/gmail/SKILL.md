---
name: Gmail Cleanup
description: Manage Gmail unread cleanup helpers using local scripts and gog CLI.
---

# Gmail Cleanup

## Khi Nào Dùng

Dùng skill này khi user muốn kiểm tra, dọn hoặc xóa các Gmail thread chưa đọc bằng các script trong thư mục này.

## Khả Năng

- Kiểm tra Gmail unread threads bằng `gog` CLI.
- Xóa unread threads theo workflow script có sẵn.
- Retry khi Gmail/gog trả trạng thái không ổn định.
- Debug các lỗi auth/account/search liên quan Gmail cleanup.

## Ngữ Cảnh Quan Trọng

- Các script hiện dùng `gog` CLI.
- Account hiện được hardcode trong script: `duyhieu9898@gmail.com`.
- Một số script dùng `gog gmail batch delete ... --force`, tức là thao tác destructive.
- Command được phép chạy do agent quản lý ở `agent/commands.json`, không nằm trong file này.

## File Liên Quan

- Delete unread script: `{baseDir}/scripts/delete_unread_gmail.py`
- Delete unread v2 script: `{baseDir}/scripts/delete_unread_gmail_v2.py`
- Clear unread script: `{baseDir}/scripts/clear_unread_gmail.py`

## Biến Môi Trường Và Công Cụ

- Cần `gog` CLI đã cài và đã login Gmail account tương ứng.
- Không có API key trong skill này.

## Lưu Ý An Toàn

- Xóa Gmail unread threads là thao tác phá hủy dữ liệu.
- Không xóa email nếu user chỉ hỏi kiểm tra, thống kê hoặc xem trạng thái.
- Trước khi chạy script xóa, cần user xác nhận rõ trong cuộc hội thoại hiện tại.
- Không tự đổi account email hardcoded nếu user chưa yêu cầu sửa code.
- Không in nội dung email ra response trừ khi user yêu cầu rõ và nội dung đó cần thiết.
- Nếu `gog` trả lỗi auth/account, dừng và báo user kiểm tra cấu hình `gog`.
