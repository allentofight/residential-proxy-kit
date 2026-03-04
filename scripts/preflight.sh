#!/usr/bin/env bash
set -euo pipefail

EXPECTED_RESIDENTIAL_IP="${1:-}"
HTTP_PROXY_ADDR="127.0.0.1:18080"
LOG_FILE="$HOME/.claude/residential-proxy/proxy.log"

TARGETS=(
  "claude.ai"
  "chatgpt.com"
  "gemini.google.com"
  "daily-cloudcode-pa.googleapis.com"
)

fail() {
  echo "[FAIL] $1"
  exit 1
}

if [[ -z "$EXPECTED_RESIDENTIAL_IP" ]]; then
  echo "Usage: $(basename "$0") <expected_residential_ip>" >&2
  exit 1
fi

info() {
  echo "[INFO] $1"
}

pass() {
  echo "[PASS] $1"
}

info "Checking system proxy ports..."
scutil_output="$(scutil --proxy)"
[[ "$scutil_output" == *"HTTPPort : 18080"* ]] || fail "System HTTP proxy is not 18080."
[[ "$scutil_output" == *"HTTPSPort : 18080"* ]] || fail "System HTTPS proxy is not 18080."
[[ "$scutil_output" == *"SOCKSPort : 18081"* ]] || fail "System SOCKS proxy is not 18081."
pass "System proxy points to 18080/18081."

info "Checking local proxy listeners..."
lsof -nP -iTCP:18080 -sTCP:LISTEN >/dev/null || fail "Port 18080 is not listening."
lsof -nP -iTCP:18081 -sTCP:LISTEN >/dev/null || fail "Port 18081 is not listening."
pass "Local proxy is listening on 18080/18081."

info "Checking residential egress IP..."
residential_ip="$(curl -sS --max-time 20 -x "http://${HTTP_PROXY_ADDR}" http://ifconfig.me/ip || true)"
[[ -n "$residential_ip" ]] || fail "Cannot fetch residential IP via ifconfig.me."
[[ "$residential_ip" == "$EXPECTED_RESIDENTIAL_IP" ]] || fail "Residential IP mismatch. Expected ${EXPECTED_RESIDENTIAL_IP}, got ${residential_ip}."
pass "Residential IP is ${residential_ip}."

info "Checking non-residential route still works..."
normal_ip="$(curl -sS --max-time 20 -x "http://${HTTP_PROXY_ADDR}" https://api.ipify.org || true)"
[[ -n "$normal_ip" ]] || fail "Cannot fetch normal route IP via api.ipify.org."
if [[ "$normal_ip" == "$EXPECTED_RESIDENTIAL_IP" ]]; then
  echo "[WARN] Normal route IP equals residential IP (${normal_ip}). Check Clash default line if this is unexpected."
else
  pass "Normal route IP is ${normal_ip} (different from residential)."
fi

info "Probing target domains before login..."
for host in "${TARGETS[@]}"; do
  curl -sS -I --max-time 25 -x "http://${HTTP_PROXY_ADDR}" "https://${host}" >/dev/null 2>&1 || true
done
pass "Probe requests sent to all target domains."

info "Checking route decision in proxy log..."
[[ -f "$LOG_FILE" ]] || fail "Proxy log file not found: $LOG_FILE"
recent_log="$(tail -n 400 "$LOG_FILE")"
for host in "${TARGETS[@]}"; do
  echo "$recent_log" | grep -F "$host" | grep -Fq "via residential" \
    || fail "No recent residential route log for ${host}."
done
pass "All target domains are routed via residential in logs."

echo
echo "✅ PRECHECK PASSED"
echo "Now you can open/login clients."
echo "If any check fails next time, do NOT login first."
