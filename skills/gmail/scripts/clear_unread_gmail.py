#!/usr/bin/env python3
import time
import subprocess
import json
import sys

USER_EMAIL = "duyhieu9898@gmail.com"

def get_unread_threads():
    # Attempt to use is:unread first, then label:unread if it fails, and vice versa
    queries = ["is:unread", "label:unread"]
    for query in queries:
        cmd = ["gog", "gmail", "search", query, "--account", USER_EMAIL, "--json"]
        # Reduced retries here because main loop handles it better
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
    # Use batch delete to permanently delete the thread
    print(f"Deleting thread {thread_id}...", flush=True)
    cmd = ["gog", "gmail", "batch", "delete", thread_id, "--account", USER_EMAIL, "--force"]
    
    # Just try once, if it fails, move on. Flakiness is high.
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        return True
    else:
        # Don't print the error to keep logs clean unless it's NOT a 404
        if "notFound" not in result.stderr:
            print(f"Failed for {thread_id}: {result.stderr.strip()}", flush=True)
        return False

def main():
    total_processed = 0
    consecutive_empty = 0
    consecutive_failures = 0
    
    while True:
        print("Searching for unread threads...", flush=True)
        threads = get_unread_threads()
        if not threads:
            consecutive_empty += 1
            if consecutive_empty > 50: # Increased patience for flaky search
                print("No more unread emails found.", flush=True)
                break
            time.sleep(0.1)
            continue
        
        consecutive_empty = 0
        print(f"Found {len(threads)} unread threads. Processing...", flush=True)
        
        batch_processed_count = 0
        for thread in threads:
            thread_id = thread["id"]
            if delete_thread(thread_id):
                total_processed += 1
                batch_processed_count += 1
                consecutive_failures = 0
            else:
                consecutive_failures += 1
                if consecutive_failures > 500:
                    print("Too many consecutive failures. Exiting.", flush=True)
                    return
        
        # If we failed the whole batch, wait a tiny bit
        if batch_processed_count == 0:
            time.sleep(0.1)
    
    print(f"Finished. Total emails/threads DELETED: {total_processed}")

if __name__ == "__main__":
    main()
