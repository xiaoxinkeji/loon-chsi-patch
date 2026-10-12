#!/usr/bin/env bash
# 一键透明网关：自签 CA + mitmproxy + iptables 重定向
#
#   ./certkit/serve.sh         启动
#   ./certkit/serve.sh stop    停止并回滚
#
# 手机端只需三步，装完不留 VPN 配置、不出现 VPN 图标、无 utun 接口:
#   1. AirDrop/邮件打开 certkit/out/chsi-ca.mobileconfig → 安装 → 锁屏密码
#   2. 设置 > 通用 > 关于本机 > 证书信任设置 > 打开「完全信任」
#   3. WiFi > 配置 IP 手动 > 路由器填本机 IP（系统代理栏留空）
#
# 环境:
#   LAN_IFACE     接手机的网卡（默认自动探测）
#   MITM_PORT     mitmproxy 端口（默认 8080）
#   CHSI_YEAR_SHIFT / CHSI_PAIRS / ...  见 README

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
VENV="$ROOT/.mitm-venv"
ADDON="$ROOT/gateway/chsi_rewrite.py"
CERTDIR="$HERE/out"
PORT="${MITM_PORT:-8080}"

if [[ "${1:-}" == "stop" ]]; then
  exec "$ROOT/gateway/stop.sh"
fi

# ---- 前置检查 ----
[[ -x "$VENV/bin/mitmdump" ]] || { echo "缺 mitmproxy: python3 -m venv $VENV && $VENV/bin/pip install mitmproxy" >&2; exit 1; }
[[ -f "$ADDON" ]] || { echo "缺 addon: $ADDON" >&2; exit 1; }

# ---- 首次运行自动生成证书 ----
if [[ ! -f "$CERTDIR/ca.crt" || ! -f "$CERTDIR/chsi-ca.mobileconfig" ]]; then
  echo "[*] 首次运行，生成 CA 与 iOS 描述文件..."
  "$HERE/make_certs.sh" >/dev/null
fi
echo "[+] CA:          $CERTDIR/ca.crt"
echo "[+] iOS 描述文件: $CERTDIR/chsi-ca.mobileconfig"

# ---- 探测网卡 ----
LAN_IFACE="${LAN_IFACE:-}"
if [[ -z "$LAN_IFACE" ]]; then
  LAN_IFACE="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}')"
fi
[[ -n "$LAN_IFACE" ]] || { echo "探测不到网卡，请设 LAN_IFACE" >&2; exit 1; }
LAN_IP="$(ip -4 addr show dev "$LAN_IFACE" 2>/dev/null | awk '/inet /{split($2,a,"/"); print a[1]; exit}')"
echo "[+] 网卡: $LAN_IFACE  本机 IP: ${LAN_IP:-未知}"

# ---- IP 转发 ----
sysctl -w net.ipv4.ip_forward=1 >/dev/null
echo "[+] IP 转发已开"

# ---- iptables ----
for dport in 80 443; do
  iptables -t nat -C PREROUTING -i "$LAN_IFACE" -p tcp --dport "$dport" -j REDIRECT --to-port "$PORT" 2>/dev/null \
    || iptables -t nat -A PREROUTING -i "$LAN_IFACE" -p tcp --dport "$dport" -j REDIRECT --to-port "$PORT"
done
iptables -C FORWARD -i "$LAN_IFACE" -j ACCEPT 2>/dev/null || iptables -A FORWARD -i "$LAN_IFACE" -j ACCEPT
echo "[+] iptables 已重定向 80/443 -> $PORT"

export CHSI_YEAR_SHIFT="${CHSI_YEAR_SHIFT:-4}"
export CHSI_DEBUG="${CHSI_DEBUG:-1}"
export SSLKEYLOGFILE="${SSLKEYLOGFILE:-$ROOT/gateway/sslkeys.log}"

cat <<EOF

================ 手机端设置 ================
1. 把 $CERTDIR/chsi-ca.mobileconfig 传到手机并打开
   → 安装 → 输入锁屏密码
2. 设置 > 通用 > 关于本机 > 证书信任设置
   → 对 CHSI-Patch CA 打开「完全信任」
3. 设置 > 无线局域网 > 当前 WiFi
   → 配置 IP: 手动
   → 路由器:  ${LAN_IP:-<本机IP>}
   → 系统代理栏保持关闭/留空
============================================

停止: $HERE/serve.sh stop
日志: $ROOT/gateway/mitm.log

EOF

exec "$VENV/bin/mitmdump" \
  -m transparent \
  --listen-host 0.0.0.0 -p "$PORT" \
  --set block_global=false \
  --certs "chsi.com.cn=$CERTDIR/server.pem" \
  -s "$ADDON" 2>&1 | tee -a "$ROOT/gateway/mitm.log"
