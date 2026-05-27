#!/usr/bin/env python3
import os
import subprocess
import json
import argparse


def run_cmd(cmd):
    try:
        return subprocess.check_output(cmd, text=True).strip()
    except Exception:
        return ""


def get_cpu_load():
    top_output = run_cmd(["top", "-bn1"])
    for line in top_output.splitlines():
        if "Cpu(s)" not in line:
            continue
        parts = line.replace(",", " ").split()
        values = {}
        for index, part in enumerate(parts[:-1]):
            try:
                value = float(part)
            except ValueError:
                continue
            label = parts[index + 1]
            values[label] = value
        return f"{values.get('us', 0) + values.get('sy', 0):.1f}"
    return ""

def get_health():
    # Disk usage
    disk_lines = run_cmd(["df", "-h", "/"]).splitlines()
    disk = disk_lines[-1].split() if len(disk_lines) > 1 else []
    if len(disk) < 5:
        disk_info = {"total": "", "used": "", "free": "", "percent": ""}
    else:
        disk_info = {"total": disk[1], "used": disk[2], "free": disk[3], "percent": disk[4]}
    
    # Memory usage
    mem_lines = run_cmd(["free", "-m"]).splitlines()
    mem = next((line.split() for line in mem_lines if line.startswith("Mem:")), [])
    if len(mem) < 4:
        mem_info = {"total_mb": "", "used_mb": "", "free_mb": "", "percent": ""}
    else:
        mem_info = {"total_mb": mem[1], "used_mb": mem[2], "free_mb": mem[3], "percent": f"{int(mem[2])/int(mem[1])*100:.1f}%"}
    
    # CPU load
    cpu = get_cpu_load()
    
    return {"disk": disk_info, "memory": mem_info, "cpu_load_percent": cpu}

def get_top_procs():
    procs = run_cmd(["ps", "-eo", "pid,ppid,cmd,%mem,%cpu", "--sort=-%cpu"])
    lines = procs.split('\n')
    result = []
    for line in lines[1:6]:
        parts = line.split()
        if len(parts) >= 5:
            result.append({
                "pid": parts[0],
                "cpu": parts[-1],
                "mem": parts[-2],
                "cmd": " ".join(parts[2:-2])
            })
    return result

def get_large_logs():
    result = []
    log_dir = "/var/log"
    min_size = 100 * 1024 * 1024

    for root, _, files in os.walk(log_dir):
        for name in files:
            path = os.path.join(root, name)
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            if size >= min_size:
                result.append({"size_bytes": size, "path": path})

    result.sort(key=lambda item: item["size_bytes"], reverse=True)
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["health", "processes", "logs", "all"])
    args = parser.parse_args()

    res = {}
    if args.command in ["health", "all"]: res["health"] = get_health()
    if args.command in ["processes", "all"]: res["top_processes"] = get_top_procs()
    if args.command in ["logs", "all"]: res["large_logs"] = get_large_logs()
    
    print(json.dumps(res, indent=2))

if __name__ == "__main__":
    main()
