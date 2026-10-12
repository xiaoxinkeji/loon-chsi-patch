#!/usr/bin/env bash
# 生成「一个文件搞定」的 iOS 描述文件 —— 证书 + HTTP 代理 打包在一起
#
#   ./certkit/make_profile.sh
#
# 这就是「别人只下载一个证书」的形态：
#   那个「证书」其实是 .mobileconfig 描述文件，里面同时装了
#     ① CA 根证书（解密 HTTPS 用）
#     ② HTTP 代理配置（把流量引到本机 mitmproxy）
#   装完代理自动生效，手机上没有任何 VPN 配置/图标/utun。
#
# 产出:
#   certkit/out/chsi-profile.mobileconfig   ← 手机上就装这一个
#
# 环境:
#   PROXY_HOST   代理地址（默认自动取本机 LAN IP）
#   PROXY_PORT   代理端口（默认 8080）
#   CA_PEM       CA 证书（默认用 mitmproxy 自己的 ~/.mitmproxy/mitmproxy-ca-cert.pem）

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
VENV="$ROOT/.mitm-venv"
mkdir -p "$HERE/out"

# ---- CA：优先用 mitmproxy 自带的，跟 mitm.it 下载的是同一张 ----
CA_PEM="${CA_PEM:-$HOME/.mitmproxy/mitmproxy-ca-cert.pem}"
if [[ ! -f "$CA_PEM" ]]; then
  echo "[*] mitmproxy CA 不存在，先就地生成..."
  [[ -x "$VENV/bin/mitmdump" ]] || { echo "缺 mitmproxy，先装：$VENV/bin/pip install mitmproxy" >&2; exit 1; }
  timeout 6 "$VENV/bin/mitmdump" --listen-host 127.0.0.1 -p "$((20000 + RANDOM % 20000))" -q >/dev/null 2>&1 || true
  [[ -f "$CA_PEM" ]] || { echo "CA 生成失败: $CA_PEM" >&2; exit 1; }
fi
echo "[1/4] CA: $CA_PEM"

# ---- 代理地址 ----
PROXY_HOST="${PROXY_HOST:-}"
if [[ -z "$PROXY_HOST" ]]; then
  PROXY_HOST="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')"
fi
source "$HERE/portlib.sh"
PROXY_PORT="$(pick_port "${PROXY_PORT:-}")" || exit 1
[[ -n "$PROXY_HOST" ]] || { echo "拿不到本机 IP，请设 PROXY_HOST" >&2; exit 1; }
echo "[2/4] 代理: $PROXY_HOST:$PROXY_PORT"

echo "[3/4] 生成描述文件（证书 + 代理 两个 payload）"
python3 - "$CA_PEM" "$PROXY_HOST" "$PROXY_PORT" "$HERE/out/chsi-profile.mobileconfig" <<'PY'
import base64, plistlib, sys, uuid

ca_pem, host, port, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
ca_b64 = base64.b64encode(open(ca_pem, "rb").read()).decode()

root_uuid   = str(uuid.uuid4()).upper()
cert_uuid   = str(uuid.uuid4()).upper()
proxy_uuid  = str(uuid.uuid4()).upper()

profile = {
    "PayloadDisplayName": "CHSI 学历核验",
    "PayloadDescription": "安装根证书并配置 HTTP 代理（非 VPN）",
    "PayloadIdentifier": f"com.chsi.patch.profile.{root_uuid}",
    "PayloadOrganization": "CHSI-Patch",
    "PayloadRemovalDisallowed": False,
    "PayloadType": "Configuration",
    "PayloadUUID": root_uuid,
    "PayloadVersion": 1,
    "PayloadContent": [
        # ① 根证书：让手机信任 mitmproxy 重签后的证书
        {
            "PayloadDisplayName": "CHSI 根证书",
            "PayloadDescription": "用于本地流量调试的根证书",
            "PayloadIdentifier": f"com.chsi.patch.cert.{cert_uuid}",
            "PayloadType": "com.apple.security.root",
            "PayloadUUID": cert_uuid,
            "PayloadVersion": 1,
            "PayloadCertificateFileName": "chsi-ca.crt",
            "PayloadContent": base64.b64decode(ca_b64),   # plistlib 会写成 <data>
        },
        # ② HTTP 代理：普通代理，不建 VPN 隧道，故无 utun / 无 VPN 图标
        {
            "PayloadDisplayName": "CHSI 代理",
            "PayloadDescription": f"HTTP 代理 {host}:{port}",
            "PayloadIdentifier": f"com.chsi.patch.proxy.{proxy_uuid}",
            "PayloadType": "com.apple.settings.httpproxy",
            "PayloadUUID": proxy_uuid,
            "PayloadVersion": 1,
            "Proxies": [{
                "ProxyType": "Manual",
                "HTTPEnable": 1,
                "HTTPPort": int(port),
                "HTTPProxy": host,
                "HTTPSEnable": 1,
                "HTTPSPort": int(port),
                "HTTPSProxy": host,
                # 本机直连的地址不走代理
                "ExceptionsList": ["127.0.0.1", "localhost", "*.local"],
                "AuthEnabled": 0,
            }],
        },
    ],
}

with open(out, "wb") as f:
    plistlib.dump(profile, f, fmt=plistlib.FMT_XML)
print("    已写入", out)
PY

echo "[4/4] 校验"
python3 - "$HERE/out/chsi-profile.mobileconfig" <<'PY'
import plistlib, sys
d = plistlib.load(open(sys.argv[1], "rb"))
assert d["PayloadType"] == "Configuration"
types = [c["PayloadType"] for c in d["PayloadContent"]]
assert "com.apple.security.root" in types, types
assert "com.apple.settings.httpproxy" in types, types
p = [c for c in d["PayloadContent"] if c["PayloadType"] == "com.apple.settings.httpproxy"][0]
pr = p["Proxies"][0]
print("    payload:", types)
print("    代理:", pr["HTTPProxy"], ":", pr["HTTPPort"], "HTTPS:", bool(pr["HTTPSEnable"]))
print("    校验: OK")
PY

echo
echo "=== 完成 ==="
echo "描述文件: $HERE/out/chsi-profile.mobileconfig"
echo
echo "手机端:"
echo "  1. Safari 打开这个文件 → 安装 → 锁屏密码"
echo "  2. 设置 > 通用 > 关于本机 > 证书信任设置 → 打开完全信任"
echo "  3. 代理已随描述文件自动配好，不用手动填"
echo "  4. 开支付宝进学信网"
echo
echo "用完后：设置 > 通用 > VPN 与设备管理 → 移除该描述文件（代理一并撤销）"
