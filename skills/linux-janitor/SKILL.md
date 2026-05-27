---
name: Linux Janitor
description: Read-only Linux and Ubuntu health checks for disk, memory, CPU, processes, and large logs.
---

# Linux Janitor

## Khi Nào Dùng

Dùng skill này khi user muốn kiểm tra tình trạng Linux/Ubuntu machine, ví dụ disk, memory, CPU, process nặng hoặc log lớn.

## Khả Năng

- Kiểm tra root disk usage.
- Kiểm tra memory usage.
- Kiểm tra CPU load hiện tại.
- Liệt kê process dùng CPU cao.
- Tìm file log lớn trong `/var/log` theo quyền đọc hiện có.
- Trả output dạng JSON để agent tóm tắt.

## Ngữ Cảnh Quan Trọng

- Skill này mặc định read-only.
- Script chính là Python.
- Không sửa file, service, package, process hoặc user data.
- Command được phép chạy do agent quản lý ở `agent/commands.json`, không nằm trong file này.

## File Liên Quan

- Main script: `{baseDir}/scripts/janitor.py`

## Output Cần Tóm Tắt

- Disk: used percent và free space.
- Memory: used percent và dấu hiệu bất thường nếu có.
- CPU: load hiện tại và process CPU cao nhất nếu có.
- Logs: path/size của file log lớn; nếu không có thì nói rõ.

## Lưu Ý An Toàn

- Giữ skill này ở chế độ read-only.
- Không tự đề xuất hoặc chạy cleanup nếu user chỉ yêu cầu kiểm tra.
- Nếu path không đọc được do permission, báo limitation thay vì dùng sudo.
- Nếu output rỗng hoặc thiếu dữ liệu, nói rõ phần nào không lấy được.
