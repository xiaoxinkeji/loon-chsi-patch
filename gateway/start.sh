#!/usr/bin/env bash
# 启动透明网关 MitM：手机侧零 VPN 配置，规避 App 的 getifaddrs/utun 检测
#
#   ./gateway/start.sh            启动
#   ./gateway/stop.sh             停止并回滚防火墙
#
# 环境变量（可选覆盖）:
#   LAN_IFACE      接手机的网卡，默认自动探测
#   MITM_PORT      mitmproxy 监听端口，默认 8080
#   CHSI_YEAR_SHIFT / CHSI_PAIRS / ... 见 README

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
VENV="$ROOT/.mitm-venv"
ADDON="$HERE/chsi_rewrite.py"
PORT="${MITM_PORT:-8080}"
LOG="$ROOT/gateway/mitm.log"

if [[ ! -x "$VENV/bin/mitmdump" ]]; then
  echo "mitmproxy 未安装，先跑: python3 -m venv $VENV && $VENV/bin/pip install mitmproxy" >&2
  exit 1
fi
if [[ ! -f "$ADDON" ]]; then
  echo "缺少 addon: $ADDON" >&2
  exit 1
fi

# 生成 CA（首次运行），手机要装这个并开完全信任
if [[ ! -f "$HOME/.mitmproxy/mitmproxy-ca-cert.pem" ]]; then
  echo "[*] 首次运行，先启动一次生成 CA..."
  timeout 8 "$VENV/bin/mitmdump" -q -p "$PORT" >/dev/null 2>&1 || true
fi
echo "[+] CA: $HOME/.mitmproxy/mitmproxy-ca-cert.pem"

# 探测接手机的网卡：取默认路由的出接口
if [[ -z "${LAN_IFACE:-}" ]]; then
  LAN_IFACE="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}')"
fi
if [[ -z "$LAN_IFACE" ]]; then
  echo "无法探测网卡，请显式设置 LAN_IFACE" >&2
  exit 1
fi
echo "[+] 网卡: $LAN_IFACE"

# 开 IP 转发
echo "[+] 开 IP 转发"
sysctl -w net.ipv4.ip_forward=1 >/dev/null

# 重定向 80/443 到 mitmproxy（仅来自 LAN 口的流量）
echo "[+] 设置 iptables REDIRECT -> $PORT"
iptables -t nat -C PREROUTING -i "$LAN_IFACE" -p tcp --dport 80  -j REDIRECT --to-port "$PORT" 2>/dev/null \
  || iptables -t nat -A PREROUTING -i "$LAN_IFACE" -p tcp --dport 80  -j REDIRECT --to-port "$PORT"
iptables -t nat -C PREROUTING -i "$LAN_IFACE" -p tcp --dport 443 -j REDIRECT --to-port "$PORT" 2>/dev/null \
  || iptables -t nat -A PREROUTING -i "$LAN_IFACE" -p tcp --dport 443 -j REDIRECT --to-port "$PORT"

# 放行转发
iptables -C FORWARD -i "$LAN_IFACE" -j ACCEPT 2>/dev/null || iptables -A FORWARD -i "$LAN_IFACE" -j ACCEPT

export CHSI_YEAR_SHIFT="${CHSI_YEAR_SHIFT:-4}"
export CHSI_DEBUG="${CHSI_DEBUG:-1}"

echo "[+] 启动 mitmdump (transparent) -> 日志 $LOG"
echo "[+] 手机: WiFi 配置 IP 手动，路由器填本机 IP，系统代理留空"
echo "[+] 停止: $HERE/stop.sh"
echo

exec "$VENV/bin/mitmdump" -m transparent --listen-host 0.0.0.0 -p "$PORT" \
  --set block_global=false -s "$ADDON" 2>&1 | tee -a "$LOG"
