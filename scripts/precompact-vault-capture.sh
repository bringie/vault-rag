#!/bin/bash
# precompact-vault-capture - hook PreCompact: summarize transcript via Haiku, save to vault-rag.
# Stdin: {session_id, transcript_path, hook_event_name, trigger, custom_instructions, cwd}
# Always exits 0 so /compact never blocks. Logs to /tmp/vault-capture-hook.log.

set -uo pipefail
LOG=/tmp/vault-capture-hook.log
exec 2>>"$LOG"

if [ -n "${VAULT_RAG_CAPTURE_RUNNING:-}" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] recursion guard: skipping" >&2
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "[$(ts)] hook fired" >&2

INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "manual"' 2>/dev/null || true)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)

emit_ok() { echo '{"continue":true,"suppressOutput":true}'; exit 0; }

[ -z "$TRANSCRIPT" ] && { echo "[$(ts)] no transcript_path" >&2; emit_ok; }
[ ! -f "$TRANSCRIPT" ] && { echo "[$(ts)] transcript missing: $TRANSCRIPT" >&2; emit_ok; }

TOKEN=$(grep '^VAULT_RAG_API_TOKEN=' /opt/vault-rag/.env 2>/dev/null | cut -d= -f2-)
if [ -z "$TOKEN" ]; then echo "[$(ts)] no VAULT_RAG_API_TOKEN" >&2; emit_ok; fi

curl -fsS -m 3 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5679/healthz >/dev/null 2>&1 \
  || { echo "[$(ts)] rag-api unreachable" >&2; emit_ok; }

DATE=$(date -u +%Y-%m-%d)
TIME=$(date -u +%H%M)
SHORT_ID=${SESSION_ID:0:8}
PATH_REL="05-sessions/${DATE}-${TIME}-${SHORT_ID:-unknown}.md"

TRANSCRIPT_TEXT=$(python3 - "$TRANSCRIPT" <<'PY' 2>>"$LOG"
import json, sys
path = sys.argv[1]
out = []
with open(path, 'r', errors='replace') as f:
    for line in f:
        try:
            obj = json.loads(line)
        except Exception:
            continue
        msg = obj.get('message') or {}
        role = msg.get('role') or obj.get('type') or 'unknown'
        content = msg.get('content', obj.get('content'))
        if isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, dict) and c.get('type') == 'text':
                    parts.append(str(c.get('text', '')))
            content = '\n'.join(parts).strip()
        if not isinstance(content, str) or not content.strip():
            continue
        snippet = content[:4000]
        out.append(f"[{role}]\n{snippet}")
out = out[-200:]
print('\n\n---\n\n'.join(out)[:80000])
PY
)

if [ -z "$TRANSCRIPT_TEXT" ]; then
  echo "[$(ts)] empty transcript text" >&2
  emit_ok
fi

PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" <<EOF
Суммаризируй сессию Claude Code ниже в один markdown-документ.

Формат строго:
---
title: <короткий заголовок без даты>
tags: [session, <2-4 тематических тега>]
session_id: $SESSION_ID
trigger: $TRIGGER
cwd: $CWD
---

# <тот же title>

## Цель
<1-3 предложения - чего хотел юзер>

## Что сделано
<маркированный список ключевых действий и артефактов>

## Решения
<принятые решения и их обоснование, либо "нет">

## Хвосты
<что осталось/блокирует, либо "нет">

Ничего вокруг (никаких "Конечно, вот..."). Только документ.

---

$TRANSCRIPT_TEXT
EOF

SUMMARY=$(VAULT_RAG_CAPTURE_RUNNING=1 timeout 50 claude -p --model haiku --max-turns 1 --max-budget-usd 0.10 < "$PROMPT_FILE" 2>>"$LOG")
RC=$?
rm -f "$PROMPT_FILE"

if [ $RC -ne 0 ] || [ -z "$SUMMARY" ]; then
  echo "[$(ts)] haiku failed rc=$RC, summary=${#SUMMARY}b" >&2
  emit_ok
fi

PAYLOAD=$(jq -n \
  --arg path "$PATH_REL" \
  --arg content "$SUMMARY" \
  '{path: $path, content: $content, mode: "upsert", reindex: false}')

RESP=$(curl -fsS -m 30 -X POST http://127.0.0.1:5679/put \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>>"$LOG") || {
    echo "[$(ts)] PUT failed" >&2
    emit_ok
  }

echo "[$(ts)] saved: $RESP" >&2
emit_ok
