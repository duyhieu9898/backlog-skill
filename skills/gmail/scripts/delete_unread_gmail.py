#!/usr/bin/env python3
"""
Script to DELETE (permanently) all unread emails in Gmail account.
Usage: python3 delete_unread_gmail.py
"""
import time
import subprocess
import json
import sys

USER_EMAIL = "duyhieu9898@gmail.com"

def get_unread_threads():
    """Get list of unread email threads."""
    queries = ["is:unread", "label:unread"]
    for query in queries:
        cmd = ["gog", "gmail", "search", query, "--account", USER_EMAIL, "--json"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                threads = data.get("threads", [])
                if threads:
                    return threads
            except json.JSONDecodeError:
                pass
    return []

def delete_thread(thread_id):
    """Permanently delete a thread using batch delete."""
    print(f"Deleting thread {thread_id}...", flush=True)
    cmd = ["gog", "gmail", "batch", "delete", thread_id, "--account", USER_EMAIL, "--force"]
    
    for attempt in range(3):
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return True
        else:
            if "notFound" in result.stderr:
                time.sleep(0.2)
                continue
            else:
                print(f"  Error: {result.stderr.strip()}", flush=True)
                break
    return False

def main():
    total_deleted = 0
    consecutive_empty = 0
    consecutive_failures = 0
    
    print(f"=== Starting to DELETE all unread emails for {USER_EMAIL} ===", flush=True)
    print("WARNING: This will PERMANENTLY delete emails!", flush=True)
    print("", flush=True)
    
    while True:
        threads = get_unread_threads()
        if not threads:
            consecutive_empty += 1
            if consecutive_empty > 30:  # 30 retries before giving up
                break
            time.sleep(0.1)
            continue
        
        consecutive_empty = 0
        print(f"Found {len(threads)} unread threads. Deleting...", flush=True)
        
        batch_deleted = 0
        for thread in threads:
            thread_id = thread["id"]
            if delete_thread(thread_id):
                total_deleted += 1
                batch_deleted += 1
                consecutive_failures = 0
            else:
                consecutive_failures += 1
                if consecutive_failures > 100:
                    print("Too many consecutive failures. Stopping.", flush=True)
                    print(f"Total deleted so far: {total_deleted}", flush=True)
                    return
        
        if batch_deleted == 0:
            time.sleep(0.2)
    
    print(f"", flush=True)
    print(f"=== COMPLETE ===", flush=True)
    print(f"Total emails/threads DELETED: {total_deleted}", flush=True)

if __name__ == "__main__":
    main()
