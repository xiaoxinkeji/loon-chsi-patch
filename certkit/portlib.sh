#!/usr/bin/env bash
# 公共片段：挑一个空闲的代理端口
# serve.sh 与 make_profile.sh 都 source 它，保证两边端口一致
#
#   source certkit/portlib.sh
#   PORT="$(pick_port "${MITM_PORT:-}")"

# 注意：不要写成 `ss -tln | grep -q ...`
# grep -q 命中后立即退出，ss 写管道被 SIGPIPE 杀掉，返回码不可靠 —— 在
# `set -o pipefail` 的子 shell 里会出现「同一个端口既占用又空闲」的错判。
# 先把 ss 输出整个读进变量，再做匹配。
_LISTEN_CACHE=""
port_free() {
  [[ -n "$_LISTEN_CACHE" ]] || _LISTEN_CACHE="$(ss -tln 2>/dev/null)"
  ! printf '%s\n' "$_LISTEN_CACHE" | grep -qE ":${1}[[:space:]]"
}

# 用法: pick_port [指定端口]
# 有指定就用指定（占用则报错）；没指定就从候选里挑第一个空闲的
pick_port() {
  local want="${1:-}"
  local p
  if [[ -n "$want" ]]; then
    port_free "$want" || { echo "端口 $want 被占用" >&2; return 1; }
    echo "$want"; return 0
  fi
  for p in 8080 8081 8888 8899 9090 18080 18081; do
    if port_free "$p"; then echo "$p"; return 0; fi
  done
  echo "8080"
}
