#!/usr/bin/env bash
# CHSI 改写代理 —— 普通手机「连 WiFi 装证书」形态
#
#   ./certkit/serve.sh         启动
#   ./certkit/serve.sh stop    停止并回滚
#
# 原理：电脑跑 HTTP 代理，手机 WiFi 里填代理地址。
# HTTPS 走 CONNECT，mitmproxy 解密后用自签证书重签 —— 所以手机必须信任它的 CA，
# 这就是「连 WiFi 下载证书」这一步（访问 http://mitm.it）。
#
# 与「透明网关」的区别（关键）：
#   透明网关：手机改「路由器」= 网关，需 iptables REDIRECT + IP 转发，手机无代理
#   本脚本  ：手机填「代理」，普通 HTTP 代理，不产生 utun、不产生 VPN 图标
#             → 支付宝检测 VPN 的那一套（getifaddrs 枚举 utun）不会命中
#
# 手机端三步：
#   1. WiFi > 配置代理 > 手动 > 服务器 填本机 IP，端口填 8080
#   2. Safari 访问 http://mitm.it  → 选 Apple → 下载安装描述文件
#   3. 设置 > 通用 > 关于本机 > 证书信任设置 → 对 mitmproxy 打开「完全信任」
#
# 环境：
#   MITM_PORT         代理端口（默认 8080）
#   CHSI_YEAR_SHIFT   毕业年份偏移（默认 4）
#   CHSI_PAIRS 等     见 README

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
# venv 在仓库的上一级（/vol2/1000/海底捞/.mitm-venv），不在仓库内
VENV="${MITM_VENV:-}"
if [[ -z "$VENV" ]]; then
  for c in "$ROOT/../.mitm-venv" "$ROOT/.mitm-venv" "$HOME/.mitm-venv"; do
    if [[ -x "$c/bin/mitmdump" ]]; then VENV="$(cd "$c" && pwd)"; break; fi
  done
fi
[[ -n "${VENV:-}" ]] || VENV="$ROOT/../.mitm-venv"
ADDON="$ROOT/gateway/chsi_rewrite.py"
# 本机 8080 常被 docker-proxy 占用 —— 与 make_profile.sh 共用同一套探测
source "$HERE/portlib.sh"
PORT="$(pick_port "${MITM_PORT:-}")" || exit 1

if [[ "${1:-}" == "stop" ]]; then
  exec "$ROOT/gateway/stop.sh"
fi

# ---- 前置检查 ----
[[ -x "$VENV/bin/mitmdump" ]] || { echo "缺 mitmproxy: python3 -m venv $VENV && $VENV/bin/pip install mitmproxy" >&2; exit 1; }
[[ -f "$ADDON" ]] || { echo "缺 addon: $ADDON" >&2; exit 1; }
command -v openssl >/dev/null || { echo "缺 openssl" >&2; exit 1; }

# ---- 确认 mitmproxy 自己的 CA 存在 ----
# mitm.it 用它签发，手机装的就是它，不是我们另生成的 ca.crt
CA_DIR="${MITMPROXY_CA_DIR:-$HOME/.mitmproxy}"
if [[ ! -f "$CA_DIR/mitmproxy-ca-cert.pem" ]]; then
  echo "[*] 首次运行，生成 mitmproxy CA..."
  MITMPROXY_CA_DIR="$CA_DIR" "$VENV/bin/mitmdump" --listen-host 127.0.0.1 -p 1 -q \
    -s /dev/null --set block_global=false &
  GEN_PID=$!
  sleep 3
  kill "$GEN_PID" 2>/dev/null || true
  wait "$GEN_PID" 2>/dev/null || true
fi
[[ -f "$CA_DIR/mitmproxy-ca-cert.pem" ]] || { echo "CA 生成失败: $CA_DIR" >&2; exit 1; }
echo "[+] CA: $CA_DIR/mitmproxy-ca-cert.pem"

# ---- 本机 IP ----
LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')"
echo "[+] 代理地址: ${LAN_IP:-<本机IP>}:${PORT}"

export CHSI_YEAR_SHIFT="${CHSI_YEAR_SHIFT:-4}"
export CHSI_DEBUG="${CHSI_DEBUG:-1}"
export SSLKEYLOGFILE="${SSLKEYLOGFILE:-$ROOT/gateway/sslkeys.log}"

cat <<EOF

================= 手机端三步 =================
1. 设置 > 无线局域网 > 当前 WiFi
   → 配置代理: 手动
   → 服务器:   ${LAN_IP:-<本机IP>}
   → 端口:     ${PORT}
   （「路由器」那栏不要动，这是代理不是网关）

2. Safari 打开  http://mitm.it
   → 点 Apple → 允许 → 安装 → 锁屏密码

3. 设置 > 通用 > 关于本机 > 证书信任设置
   → 对 mitmproxy 打开「完全信任」
==============================================

改完毕业时间后记得把代理关回「关闭」，否则手机一直走本机。

停止: $HERE/serve.sh stop
日志: $ROOT/gateway/mitm.log
EOF

# 普通 HTTP 代理模式（不是 -m transparent）
# 注：本地自签后端做测试时需加 --set ssl_insecure=true；
#     线上学信网有真实证书，不需要。
exec "$VENV/bin/mitmdump" \
  --listen-host 0.0.0.0 -p "$PORT" \
  --set block_global=false \
  -s "$ADDON" 2>&1 | tee -a "$ROOT/gateway/mitm.log"
