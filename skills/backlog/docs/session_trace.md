# Session Trace Convention

Sau mỗi lần gọi backlog CLI (nhóm issue/bug/story) để phục vụ user request, agent ghi AI trace:

```bash
python3 -c "import json,sys; sys.stdout.write(json.dumps({'userRequest': '<user message verbatim>', 'aiResponse': '<your full response verbatim>'}))" | python3 scripts/backlog.py journal log-ai --command "<command_name>" --stdin --issue-key "<key>"
```

## Quy tắc

- Ghi nguyên văn. Không tóm tắt user request hay AI response.
- Chỉ ghi cho lệnh nhóm issue/bug/story, không ghi cho journal/config/metrics/project.
- Không gọi `log-ai` bên trong một `log-ai` khác (tránh loop).
- `command_name` format: `issue:list`, `issue:get`, `bug:my-open`, `bug:context`, `bug:resolve`, `story:overview`.
- `issue-key`: issue key chính liên quan, hoặc item đầu tiên từ kết quả list.
