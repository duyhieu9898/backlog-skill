#!/usr/bin/env python3
import subprocess
import json
import sys
import time

USER_EMAIL = "duyhieu9898@gmail.com"

def get_unread_messages():
    # Sử dụng query "label:unread" thay vì "is:unread" để xem có khác biệt không
    # Hoặc đơn giản là query rỗng nhưng lọc bằng script
    cmd = ["gog", "gmail", "search", "is:inbox", "--max", "50", "--account", USER_EMAIL, "--json"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return []
    try:
        data = json.loads(result.stdout)
        # Chỉ lấy những thread có label UNREAD
        return [t["id"] for t in data.get("threads", []) if "UNREAD" in t.get("labels", [])]
    except:
        return []

def delete_batch(ids):
    if not ids:
        return 0
    # Chia nhỏ batch nếu cần, nhưng 50 cái một lúc là ổn
    cmd = ["gog", "gmail", "batch", "delete"] + ids + ["--account", USER_EMAIL, "--force"]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode == 0:
        return len(ids)
    return 0

def main():
    total_deleted = 0
    print(f"Bắt đầu dọn dẹp mail chưa đọc cho {USER_EMAIL}...")
    
    # Thử xóa bằng query trực tiếp trước (nếu gog hỗ trợ, nhưng thường là theo ID)
    while True:
        ids = get_unread_messages()
        if not ids:
            break
        
        print(f"Đang xóa {len(ids)} mail chưa đọc...")
        deleted = delete_batch(ids)
        total_deleted += deleted
        if deleted == 0:
            break
        time.sleep(1) # Tránh rate limit
            
    print(f"Hoàn thành! Đã xóa tổng cộng {total_deleted} mail chưa đọc.")

if __name__ == "__main__":
    main()
