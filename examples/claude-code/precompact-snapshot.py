#!/usr/bin/env python3
"""PreCompact hook: dump full transcript to vault-rag 03-sessions/ before lossy summary."""

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

ENV_FILE = Path(os.environ.get("VAULT_ENV_FILE", str(Path.home() / ".vault-rag.env")))
LOG_FILE = Path(os.environ.get("VAULT_PRECOMPACT_LOG", str(Path.home() / ".claude" / "precompact-snapshot.log")))
MAX_BODY_CHARS = 120_000  # ~30k tokens, balances detail vs index time
HTTP_TIMEOUT = 60


def log(msg: str) -> None:
    try:
        with LOG_FILE.open("a") as f:
            f.write(f"{datetime.now(timezone.utc).isoformat()} {msg}\n")
    except Exception:
        pass


def load_env() -> dict:
    """Prefer process env; fallback to .env file if VAULT_RAG_API_URL not set there."""
    env = dict(os.environ)
    if env.get("VAULT_RAG_API_URL") and env.get("VAULT_RAG_API_TOKEN"):
        return env
    if not ENV_FILE.exists():
        return env
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def truncate_text(s: str, limit: int = 4000) -> str:
    if len(s) <= limit:
        return s
    return s[:limit] + f"\n... [truncated {len(s) - limit} chars]"


def render_content(content) -> str:
    """Claude transcript message content → readable markdown."""
    if isinstance(content, str):
        return truncate_text(content)
    if not isinstance(content, list):
        return truncate_text(str(content))
    parts = []
    for blk in content:
        if not isinstance(blk, dict):
            parts.append(truncate_text(str(blk)))
            continue
        btype = blk.get("type", "")
        if btype == "text":
            parts.append(truncate_text(blk.get("text", "")))
        elif btype == "thinking":
            parts.append("[thinking]\n" + truncate_text(blk.get("thinking", ""), 1500))
        elif btype == "tool_use":
            name = blk.get("name", "?")
            inp = blk.get("input", {})
            parts.append(f"[tool_use: {name}]\n```json\n{truncate_text(json.dumps(inp, ensure_ascii=False, indent=2), 1500)}\n```")
        elif btype == "tool_result":
            tid = blk.get("tool_use_id", "?")
            res = blk.get("content", "")
            if isinstance(res, list):
                res = "\n".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in res)
            parts.append(f"[tool_result {tid}]\n{truncate_text(str(res), 2000)}")
        else:
            parts.append(f"[{btype}]")
    return "\n\n".join(parts)


def parse_transcript(path: Path) -> list:
    """Read JSONL transcript, yield turn dicts."""
    turns = []
    if not path.exists():
        return turns
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                turns.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return turns


def render_markdown(turns: list, session_id: str, trigger: str) -> str:
    lines = [
        "---",
        f"session_id: {session_id}",
        f"timestamp: {datetime.now(timezone.utc).isoformat()}",
        f"trigger: {trigger}",
        f"turns: {len(turns)}",
        "type: precompact-snapshot",
        "---",
        "",
        f"# PreCompact snapshot {session_id[:8]}",
        f"trigger: **{trigger}** | turns: **{len(turns)}**",
        "",
    ]
    for i, t in enumerate(turns):
        msg = t.get("message", {})
        if not isinstance(msg, dict):
            continue
        role = msg.get("role") or t.get("type", "?")
        content = msg.get("content", t.get("content", ""))
        rendered = render_content(content)
        if not rendered.strip():
            continue
        lines.append(f"## [{i}] {role}")
        lines.append("")
        lines.append(rendered)
        lines.append("")
    body = "\n".join(lines)
    if len(body) > MAX_BODY_CHARS:
        # keep header + tail (most recent turns are most useful pre-compact)
        head_size = 8000
        tail_size = MAX_BODY_CHARS - head_size - 200
        head = body[:head_size]
        tail = body[-tail_size:]
        body = f"{head}\n\n... [middle truncated, original {len(body)} chars] ...\n\n{tail}"
    return body


def post_to_vault(env: dict, vault_path: str, content: str) -> tuple[bool, str]:
    url = env.get("VAULT_RAG_API_URL")
    token = env.get("VAULT_RAG_API_TOKEN")
    if not url or not token:
        return False, "no VAULT_RAG_API_URL/TOKEN"
    payload = json.dumps({
        "path": vault_path,
        "content": content,
        "mode": "create",
        "reindex": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{url.rstrip('/')}/api/put",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return True, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def main() -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        data = {}

    transcript_path = data.get("transcript_path") or os.environ.get("CLAUDE_TRANSCRIPT_PATH", "")
    session_id = data.get("session_id") or "unknown"
    trigger = data.get("trigger") or "unknown"

    log(f"start session={session_id} trigger={trigger} transcript={transcript_path}")

    if not transcript_path:
        log("no transcript_path - skip")
        return 0

    turns = parse_transcript(Path(transcript_path))
    if not turns:
        log("empty transcript - skip")
        return 0

    body = render_markdown(turns, session_id, trigger)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    short = session_id[:8] if session_id != "unknown" else "anon"
    vault_path = f"03-sessions/{ts}-precompact-{short}.md"

    env = load_env()
    ok, msg = post_to_vault(env, vault_path, body)
    log(f"done path={vault_path} ok={ok} msg={msg} body_chars={len(body)}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"fatal {type(e).__name__}: {e}")
        sys.exit(0)  # never block compact
