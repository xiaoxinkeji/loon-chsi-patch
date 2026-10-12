#!/usr/bin/env bash
# 一键起全套：启动代理 → 生成描述文件（证书+代理）→ 发布到 OpenList → 打印链接
#
#   ./certkit/up.sh            启动（前台运行，Ctrl+C 停止）
#   ./certkit/up.sh stop       停止
#   ./certkit/up.sh bg         后台启动，打完链接就返回
#
# 跑完会打印一个链接，手机 Safari 打开装一下就完事。

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
PIDFILE="$ROOT/gateway/mitm.pid"

# ---------- stop ----------
if [[ "${1:-}" == "stop" ]]; then
  if [[ -f "$PIDFILE" ]]; then
    PID="$(cat "$PIDFILE")"
    kill "$PID" 2>/dev/null && echo "已停止 mitmproxy (pid $PID)" || echo "进程已不在"
    rm -f "$PIDFILE"
  else
    pkill -f "mitmdump.*chsi_rewrite" 2>/dev/null && echo "已停止" || echo "没有在跑"
  fi
  exit 0
fi

# ---------- 前置 ----------
[[ -x "$VENV/bin/mitmdump" ]] || { echo "缺 mitmproxy: python3 -m venv $VENV && $VENV/bin/pip install mitmproxy" >&2; exit 1; }
[[ -f "$ADDON" ]] || { echo "缺 addon: $ADDON" >&2; exit 1; }

source "$HERE/portlib.sh"
PORT="$(pick_port "${MITM_PORT:-}")" || exit 1

# ---------- 1. 生成描述文件（证书 + 代理）----------
echo "[1/4] 生成描述文件"
PROXY_PORT="$PORT" "$HERE/make_profile.sh" >/tmp/mkprofile.log 2>&1 \
  || { echo "生成失败:"; cat /tmp/mkprofile.log >&2; exit 1; }
PROFILE="$HERE/out/chsi-profile.mobileconfig"
[[ -f "$PROFILE" ]] || { echo "描述文件没生成" >&2; exit 1; }
echo "      $PROFILE"

# ---------- 2. 发布到 OpenList ----------
echo "[2/4] 发布到 OpenList"
OPENLIST_PORT=5244 PROFILE_ONLY=1 "$HERE/publish.sh" >/tmp/publish.log 2>&1 \
  || { echo "发布失败（不影响本机使用）:"; tail -3 /tmp/publish.log; }
grep -E "^http://.*chsi-profile" /tmp/publish.log | head -1 | sed 's/^/      /'

# ---------- 3. 启动代理 ----------
echo "[3/4] 启动代理 :$PORT"
export CHSI_YEAR_SHIFT="${CHSI_YEAR_SHIFT:-4}"
export CHSI_DEBUG="${CHSI_DEBUG:-1}"
# 学信网是真证书，默认不开；遇到上游证书链异常时 SSL_INSECURE=1 重启
export SSL_INSECURE="${SSL_INSECURE:-}"
export SSLKEYLOGFILE="${SSLKEYLOGFILE:-$ROOT/gateway/sslkeys.log}"

LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')"

if [[ "${1:-}" == "bg" ]]; then
  setsid nohup "$VENV/bin/mitmdump" \
    --listen-host 0.0.0.0 -p "$PORT" --set block_global=false \
    --allow-hosts 'chsi\.com\.cn' --allow-hosts 'chsi\.cn' \
    ${SSL_INSECURE:-} -s "$ADDON" >> "$ROOT/gateway/mitm.log" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  sleep 6
  port_free "$PORT" && { echo "启动失败，看 $ROOT/gateway/mitm.log" >&2; exit 1; }
  echo "      后台运行中 (pid $(cat "$PIDFILE"))"
fi

# ---------- 4. 打印用法 ----------
cat <<EOF

[4/4] 手机端 —— 就装一个文件
==============================================
1. 手机连家里 WiFi
2. Safari 打开：
   http://${LAN_IP:-<本机IP>}:5244/d/ios/chsi-profile.mobileconfig
3. 安装 → 锁屏密码
4. 设置 > 通用 > 关于本机 > 证书信任设置 → 打开「完全信任」
5. 开支付宝进学信网

代理已写在描述文件里（${LAN_IP:-<本机IP>}:${PORT}），不用手动填。
手机无 VPN 配置、无状态栏图标、无 utun。

用完移除：设置 > 通用 > VPN 与设备管理 → 移除描述文件
==============================================
EOF

# ---------- 前台运行 ----------
if [[ "${1:-}" != "bg" ]]; then
  echo "（前台运行，Ctrl+C 停止）"
  exec "$VENV/bin/mitmdump" \
    --listen-host 0.0.0.0 -p "$PORT" --set block_global=false \
    --allow-hosts 'chsi\.com\.cn' --allow-hosts 'chsi\.cn' \
    ${SSL_INSECURE:-} -s "$ADDON" 2>&1 | tee -a "$ROOT/gateway/mitm.log"
fi
