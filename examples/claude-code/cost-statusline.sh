#!/bin/bash
# Cost-aware statusline. Reads stdin JSON from Claude Code, preserves caveman badge,
# appends model tag + ctx% + session cost + burn rate.

INPUT=$(cat)

CAVEMAN_SCRIPT=$(find /root/.claude/plugins/cache/caveman -name "caveman-statusline.sh" 2>/dev/null | head -1)
if [ -n "$CAVEMAN_SCRIPT" ] && [ -x "$CAVEMAN_SCRIPT" ]; then
    CAVEMAN=$(bash "$CAVEMAN_SCRIPT" 2>/dev/null)
else
    CAVEMAN=""
fi

MODEL_ID=$(printf '%s' "$INPUT" | jq -r '.model.id // empty' 2>/dev/null)
case "$MODEL_ID" in
    *opus*)   MODEL_TAG=$'\033[38;5;213m[OPU]\033[0m' ;;
    *sonnet*) MODEL_TAG=$'\033[38;5;39m[SON]\033[0m' ;;
    *haiku*)  MODEL_TAG=$'\033[38;5;82m[HAI]\033[0m' ;;
    "")       MODEL_TAG="" ;;
    *)        MODEL_TAG="[?]" ;;
esac

# context window: opus-*-1m and similar = 1M, default = 200k
case "$MODEL_ID" in
    *1m*|*opus-4-7*) CTX_MAX=1000000 ;;
    *)               CTX_MAX=200000 ;;
esac

TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
CTX_OUT=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    # last assistant message with usage info
    USAGE=$(tac "$TRANSCRIPT" 2>/dev/null | while IFS= read -r line; do
        echo "$line" | jq -e -c 'select(.message.role == "assistant" and .message.usage != null) | .message.usage' 2>/dev/null && break
    done | head -1)
    if [ -n "$USAGE" ]; then
        CTX_USED=$(echo "$USAGE" | jq -r '((.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0))' 2>/dev/null)
        if [ -n "$CTX_USED" ] && [ "$CTX_USED" -gt 0 ] 2>/dev/null; then
            CTX_PCT=$(( CTX_USED * 100 / CTX_MAX ))
            if [ "$CTX_PCT" -lt 70 ]; then
                CTX_COLOR=$'\033[38;5;82m'   # green
            elif [ "$CTX_PCT" -lt 85 ]; then
                CTX_COLOR=$'\033[38;5;220m'  # yellow
            else
                CTX_COLOR=$'\033[38;5;196m'  # red
            fi
            CTX_USED_K=$(( CTX_USED / 1000 ))
            CTX_MAX_K=$(( CTX_MAX / 1000 ))
            CTX_RESET=$'\033[0m'
            CTX_OUT=" ${CTX_COLOR}ctx ${CTX_PCT}% (${CTX_USED_K}k/${CTX_MAX_K}k)${CTX_RESET}"
        fi
    fi
fi

COST=$(printf '%s' "$INPUT" | jq -r '.cost.total_cost_usd // 0' 2>/dev/null)
DURATION_MS=$(printf '%s' "$INPUT" | jq -r '.cost.total_duration_ms // 0' 2>/dev/null)

[ -z "$COST" ] && COST=0
[ -z "$DURATION_MS" ] && DURATION_MS=0

COST_INT=$(printf '%.0f' "$COST" 2>/dev/null || echo 0)
if [ "$COST_INT" -lt 1 ] 2>/dev/null; then
    COST_COLOR=$'\033[38;5;82m'   # green
elif [ "$COST_INT" -lt 5 ] 2>/dev/null; then
    COST_COLOR=$'\033[38;5;220m'  # yellow
else
    COST_COLOR=$'\033[38;5;196m'  # red
fi
RESET=$'\033[0m'

COST_STR=$(printf '$%.2f' "$COST" 2>/dev/null || echo '$?')

if [ "$DURATION_MS" -gt 60000 ] 2>/dev/null; then
    BURN=$(echo "scale=3; $COST * 60000 / $DURATION_MS" | bc 2>/dev/null)
    BURN_STR=$(printf '%.2f' "$BURN" 2>/dev/null || echo '?')
    BURN_OUT=" ~\$${BURN_STR}/min"
else
    BURN_OUT=""
fi

OUT=""
[ -n "$CAVEMAN" ] && OUT="${CAVEMAN} "
[ -n "$MODEL_TAG" ] && OUT="${OUT}${MODEL_TAG}"
OUT="${OUT}${CTX_OUT} ${COST_COLOR}${COST_STR}${RESET}${BURN_OUT}"

printf '%s' "$OUT"
