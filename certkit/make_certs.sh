#!/usr/bin/env bash
# 生成自签 CA + 服务器证书，产出 iOS 可安装的 .mobileconfig
#
#   ./certkit/make_certs.sh
#
# 产出:
#   certkit/ca.crt                 CA 根证书（手机装这个）
#   certkit/server.crt / .key      服务器证书
#   certkit/chsi-ca.mobileconfig   iOS 描述文件（装这个 = 装 CA + 信任开关）
#
# 手机端: AirDrop / 邮件 打开 mobileconfig → 安装 → 输入锁屏密码
#         → 设置 > 通用 > 关于本机 > 证书信任设置 > 打开完全信任

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
mkdir -p out

SUBJ_CA="/C=CN/O=CHSI-Patch/CN=CHSI-Patch CA"
DAYS=3650
UUID_CA=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
UUID_PAYLOAD=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)

echo "[1/4] 生成 CA 私钥"
openssl genrsa -out out/ca.key 2048 2>/dev/null

echo "[2/4] 生成 CA 根证书"
openssl req -x509 -new -nodes -key out/ca.key -sha256 -days "$DAYS" \
  -subj "$SUBJ_CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out out/ca.crt 2>/dev/null

echo "[3/4] 生成服务器证书（含 chsi 域名的 SAN）"
openssl genrsa -out out/server.key 2048 2>/dev/null
cat > out/server.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
C  = CN
O  = CHSI-Patch
CN = chsi.com.cn
[ext]
subjectAltName = DNS:chsi.com.cn,DNS:*.chsi.com.cn,DNS:chsi.cn,DNS:*.chsi.cn
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EOF
openssl req -new -key out/server.key -out out/server.csr -config out/server.cnf 2>/dev/null
openssl x509 -req -in out/server.csr -CA out/ca.crt -CAkey out/ca.key \
  -CAcreateserial -out out/server.crt -days "$DAYS" -sha256 \
  -extfile out/server.cnf -extensions ext 2>/dev/null

echo "[4/5] 合并成 mitmproxy 需要的 PEM（证书+私钥同一文件）"
# mitmproxy --certs 要求私钥与证书在同一文件，分开传会报
# "Unable to find private key in ..."
cat out/server.crt out/server.key > out/server.pem
chmod 600 out/server.pem

echo "[5/5] 生成 iOS 描述文件"
CERT_B64=$(base64 -w0 < out/ca.crt)
cat > out/chsi-ca.mobileconfig <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>chsi-ca.crt</string>
      <key>PayloadContent</key>
      <data>${CERT_B64}</data>
      <key>PayloadDescription</key>
      <string>添加 CHSI-Patch 根证书，用于本地流量调试</string>
      <key>PayloadDisplayName</key>
      <string>CHSI-Patch CA</string>
      <key>PayloadIdentifier</key>
      <string>com.chsi.patch.cert.${UUID_PAYLOAD}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${UUID_PAYLOAD}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>CHSI-Patch 根证书</string>
  <key>PayloadIdentifier</key>
  <string>com.chsi.patch.profile.${UUID_CA}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${UUID_CA}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
EOF

echo
echo "=== 完成 ==="
echo "CA 证书:        $HERE/out/ca.crt"
echo "服务器证书:     $HERE/out/server.crt"
echo "服务器 PEM:     $HERE/out/server.pem（证书+私钥，mitmproxy 用）"
echo "iOS 描述文件:   $HERE/out/chsi-ca.mobileconfig"
echo
echo "手机端三步:"
echo "  1. 打开 chsi-ca.mobileconfig → 安装 → 输入锁屏密码"
echo "  2. 设置 > 通用 > 关于本机 > 证书信任设置 > 打开「完全信任」"
echo "  3. WiFi > 配置 IP 手动 > 路由器填本机 IP（系统代理栏留空）"
