#!/usr/bin/env bash
# 停止网关 MitM 并回滚防火墙规则
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${MITM_PORT:-8080}"

if [[ -z "${LAN_IFACE:-}" ]]; then
  LAN_IFACE="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}')"
fi

echo "[+] 杀掉 mitmdump"
pkill -f "mitmdump.*$PORT" 2>/dev/null || true

if [[ -n "${LAN_IFACE:-}" ]]; then
  echo "[+] 回滚 iptables ($LAN_IFACE)"
  for dport in 80 443; do
    while iptables -t nat -C PREROUTING -i "$LAN_IFACE" -p tcp --dport "$dport" -j REDIRECT --to-port "$PORT" 2>/dev/null; do
      iptables -t nat -D PREROUTING -i "$LAN_IFACE" -p tcp --dport "$dport" -j REDIRECT --to-port "$PORT"
    done
  done
  while iptables -C FORWARD -i "$LAN_IFACE" -j ACCEPT 2>/dev/null; do
    iptables -D FORWARD -i "$LAN_IFACE" -j ACCEPT
  done
fi

echo "[+] 关 IP 转发（如需上网请自行恢复）"
sysctl -w net.ipv4.ip_forward=0 >/dev/null 2>&1 || true

echo "[+] 已停止"
