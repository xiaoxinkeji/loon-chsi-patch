#!/usr/bin/env bash
# 把证书发布到 OpenList / AList 的 /ios 目录，供手机直接下载安装
#
#   ./certkit/publish.sh                 自动探测本机 AList/OpenList
#   OPENLIST_DIR="/path/to/dir" ./certkit/publish.sh   直接指定目录
#
# 发布后打印局域网直链，手机浏览器打开即可安装。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
CERTDIR="$HERE/out"

[[ -f "$CERTDIR/chsi-ca.mobileconfig" ]] || { echo "缺描述文件，先跑 $HERE/make_certs.sh" >&2; exit 1; }

# ---- 定位目标目录 ----
DEST="${OPENLIST_DIR:-}"
if [[ -z "$DEST" ]]; then
  # 从运行中的 alist 进程取 --data 目录，再读库里的 /ios 挂载点
  DATA_DIR="$(ps -eo args 2>/dev/null | grep -oE 'alist server --data [^ ]+' | head -1 | awk '{print $NF}')"
  if [[ -n "${DATA_DIR:-}" && -f "$DATA_DIR/data.db" ]]; then
    ROOT_FOLDER="$(python3 - "$DATA_DIR/data.db" <<'PY'
import sqlite3, sys, json, os, shutil, tempfile
db = sys.argv[1]
tmp = tempfile.mktemp(suffix=".db")
try:
    shutil.copy(db, tmp)
    for e in ("-wal", "-shm"):
        p = db + e
        if os.path.exists(p):
            shutil.copy(p, tmp + e)
    con = sqlite3.connect(tmp); cur = con.cursor()
    cur.execute("SELECT addition FROM x_storages WHERE mount_path='/ios'")
    row = cur.fetchone()
    print(json.loads(row[0])["root_folder_path"] if row else "")
    con.close()
except Exception:
    print("")
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY
)"
    [[ -n "$ROOT_FOLDER" && -d "$ROOT_FOLDER" ]] && DEST="$ROOT_FOLDER"
  fi
fi

if [[ -z "$DEST" || ! -d "$DEST" ]]; then
  echo "探测不到 /ios 目录，请用 OPENLIST_DIR 指定，例如:" >&2
  echo "  OPENLIST_DIR=\"/vol2/1000/backup/iOS彩信直连的描述文件\" $0" >&2
  exit 1
fi

echo "[+] 目标目录: $DEST"

# ---- 复制 ----
cp "$CERTDIR/chsi-ca.mobileconfig" "$DEST/"
cp "$CERTDIR/ca.crt" "$DEST/chsi-ca.crt"
chmod 644 "$DEST/chsi-ca.mobileconfig" "$DEST/chsi-ca.crt"
echo "[+] 已发布: chsi-ca.mobileconfig, chsi-ca.crt"

# ---- 直链 ----
PORT="$(ss -tlnp 2>/dev/null | grep -oE ':5244\s' >/dev/null && echo 5244 || echo 5244)"
LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')"

# AList 挂载点 /ios 对应的子路径 = 目标目录相对 root_folder_path 的部分
SUB="$(basename "$DEST")"
BASE="http://${LAN_IP:-<本机IP>}:${PORT}/d/ios/${SUB}"

echo
echo "================ 手机端直链 ================"
python3 - "$BASE" <<'PY'
import sys, urllib.parse
b = sys.argv[1]
for name in ("chsi-ca.mobileconfig", "chsi-ca.crt"):
    print(urllib.parse.quote(b, safe=":/") + "/" + name)
PY
echo "============================================"
echo
echo "手机 Safari 打开上面的 mobileconfig 链接 → 安装 → 锁屏密码"
echo "然后: 设置 > 通用 > 关于本机 > 证书信任设置 > 打开「完全信任」"
echo
echo "若下载返回 401（{\"code\":401,\"expire missing\"}），说明 AList 开了全局签名，"
echo "需在管理后台关闭「全局签名」(sign_all)，或改用带签名的链接。"
