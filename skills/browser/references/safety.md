# Chính Sách An Toàn Trình Duyệt

Để bảo vệ quyền riêng tư và an toàn hệ thống, các hoạt động trình duyệt của Agent phải tuân thủ nghiêm ngặt các quy tắc sau.

## Giới Hạn Phạm Vi (Network Boundaries)

1. **Không truy cập mạng nội bộ (LAN / Localhost)**:
   - Nghiêm cấm truy cập mọi địa chỉ IP thuộc dải Private/Local như `127.0.0.1`, `localhost`, `192.168.x.x`, `10.x.x.x`.
   - Mọi nỗ lực truy cập các địa chỉ này sẽ bị chặn bởi Permission Policy.

2. **Chỉ chấp nhận Public HTTPS**:
   - Tất cả các URL phải dùng giao thức `https://` và trỏ tới mạng Internet công cộng.

## Các Hành Động Có Ảnh Hưởng Lớn (Consequential Actions)

1. **Yêu cầu Xác nhận từ Người dùng (Human Confirmation)**:
   - Các hành động mang tính chất thay đổi trạng thái tài khoản quan trọng (như xóa tài khoản, thanh toán, thay đổi mật khẩu) hoặc chuyển tiền/tài sản bắt buộc phải được người dùng xác nhận thông qua flow `confirm`.
   - Khi có yêu cầu xác nhận, Agent sẽ tạm dừng và cung cấp nút bấm/lệnh xác nhận cho người dùng.

2. **Bảo mật Thông tin cá nhân**:
   - Agent không được tự ý điền thông tin thẻ tín dụng, mật khẩu cá nhân, hoặc dữ liệu nhạy cảm trừ khi được người dùng chỉ thị rõ ràng và cung cấp trực tiếp trong ngữ cảnh hiện tại.
