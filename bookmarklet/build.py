#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 chsi_bookmarklet.js 压成单行 bookmarklet。

bookmarklet 必须是单行：换行后的 // 行注释会把后面所有代码吞掉。
本脚本先剥离注释再压缩，并用 node --check 验证压缩结果语法正确。

    python3 bookmarklet/build.py
"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "chsi_bookmarklet.js"
OUT = HERE / "bookmarklet.txt"

src = SRC.read_text(encoding="utf-8")

# 1) 去掉块注释
s = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
# 2) 去掉行注释（必须在压成单行之前做，否则 // 会吞掉后面所有代码）
s = re.sub(r"//[^\n]*", "", s)
# 3) 压成单行
s = re.sub(r"\s+", " ", s).strip()
# 4) 去掉 } 后多余空格、; 前空格等
s = re.sub(r"\s*([{}();,])\s*", r"\1", s)
# 5) 保护必要的空格（关键字后）
s = re.sub(r"\b(var|function|return|typeof|new|in|of|if|else|for|while)\b", r" \1 ", s)
s = re.sub(r"\s+", " ", s).strip()

out = "javascript:" + s
OUT.write_text(out, encoding="utf-8")

# 验证：去掉 javascript: 前缀后必须是合法 JS
body = out[len("javascript:"):]
r = subprocess.run(["node", "--check", "-"], input=body, text=True,
                   capture_output=True)
if r.returncode != 0:
    print("语法检查失败:", r.stderr[:400], file=sys.stderr)
    sys.exit(1)

print(f"已生成 {OUT}  （{len(out)} 字符）")
print("语法检查: 通过")
