# -*- coding: utf-8 -*-
"""gateway/chsi_rewrite.py 的本地测试。

本机没装 mitmproxy 时注入最小 stub 让模块可导入，
只测纯逻辑（改写、host 匹配、注入构造），不测 mitmproxy 运行时。

    python3 tests/run_gateway_tests.py
"""

import importlib.util
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ADDON = os.path.join(ROOT, "gateway", "chsi_rewrite.py")


def load_addon(env=None):
    for k, v in (env or {}).items():
        os.environ[k] = v
    if "mitmproxy" not in sys.modules:
        stub = types.ModuleType("mitmproxy")
        http_mod = types.ModuleType("mitmproxy.http")
        ctx_mod = types.ModuleType("mitmproxy.ctx")
        http_mod.HTTPFlow = type("HTTPFlow", (), {})

        class _Log:
            def info(self, *a):
                pass

        ctx_mod.log = _Log()
        stub.http = http_mod
        stub.ctx = ctx_mod
        sys.modules["mitmproxy"] = stub
        sys.modules["mitmproxy.http"] = http_mod
        sys.modules["mitmproxy.ctx"] = ctx_mod

    spec = importlib.util.spec_from_file_location("chsi_rewrite", ADDON)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FAILS = [0]


def chk(name, cond, extra=None):
    if cond:
        print("PASS  " + name)
    else:
        FAILS[0] += 1
        tail = json.dumps(extra, ensure_ascii=False)[:200] if extra is not None else ""
        print("FAIL  " + name + "  " + tail)


m = load_addon({"CHSI_YEAR_SHIFT": "4"})

# --- JSON 递归改写 ---
c = [0]
d = {
    "graduationDate": "2024-06-30",
    "byrq": "2024年6月30日",
    "name": "x",
    "nested": {"endDate": "2024-06-30"},
    "list": [{"graduateTime": "2024-06-30"}],
}
m.patch_json(d, c)
chk("json graduationDate", d["graduationDate"] == "2028-06-30", d["graduationDate"])
chk("json 中文格式保留", d["byrq"] == "2028年6月30日", d["byrq"])
chk("json nested", d["nested"]["endDate"] == "2028-06-30")
chk("json array", d["list"][0]["graduateTime"] == "2028-06-30")
chk("json 未命名字段不动", d["name"] == "x")
chk("counter == 4", c[0] == 4, c[0])

# --- host 匹配 ---
chk("host chsi.com.cn", bool(m.HOST_RE.search("my.chsi.com.cn")))
chk("host www.chsi.cn", bool(m.HOST_RE.search("www.chsi.cn")))
chk("host 排除 alipay", not m.HOST_RE.search("mobilegw.alipay.com"))
chk("host 排除伪装后缀", not m.HOST_RE.search("chsi.com.cn.evil.com"))

# --- 内联 JSON ---
h = '<script>var s={"graduationDate":"2024-06-30"};</script>'
chk("inline 替换", '"graduationDate":"2028-06-30"' in m.patch_inline_json(h, [0]))

# --- 注入脚本构造 ---
inj = m.build_injector()
chk("injector yearShift", '"yearShift": 4' in inj, inj[:130])
chk("injector observerMs", '"observerMs": 600000' in inj)
chk("injector MutationObserver", "MutationObserver" in inj)
chk("injector 占位已替换", "__CFG__" not in inj)

# 这条是回归用例：re.sub 传字符串会把 \d 当反向引用，抛 bad escape
html = "<html><head><title>t</title></head><body>x</body></html>"
try:
    r = m.inject_script(html)
    chk("inject_script 不崩", True)
    chk("注入到 head", "<script>" in r and "</head>" in r)
    chk("注入位置在 /head 前", r.index("<script>") < r.index("</head>"))
    chk("正则转义完好", r"(\d{4})" in r or "\\d{4}" in r)
except Exception as e:
    chk("inject_script 不崩", False, str(e))

# --- rewrite_date ---
chk("rewrite 普通", m.rewrite_date("2024-06-30") == "2028-06-30")
chk("rewrite 中文", m.rewrite_date("2024年6月30日") == "2028年6月30日")
chk("rewrite 无日期", m.rewrite_date("abc") == "abc")

print()
print("ALL PASS" if FAILS[0] == 0 else str(FAILS[0]) + " FAILED")
sys.exit(1 if FAILS[0] else 0)
