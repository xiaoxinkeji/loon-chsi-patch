# -*- coding: utf-8 -*-
"""
chsi_rewrite.py — 学信网毕业信息改写（mitmproxy addon，网关机运行）

这是 chsi_patch.js 的 mitmproxy 版本，逻辑与 Loon 插件保持一致：
  - yearShift 优先：只换年份，保留原格式（2024年6月30日 -> 2028年6月30日）
  - pairs：按标签改相邻单元格（学籍状态 之类）
  - HTML 注入 DOM 脚本，带 MutationObserver 兜住前端异步渲染
  - JSON 递归改命中键名

为什么需要它：iOS 本机 MitM 必须走 NetworkExtension（VPN），支付宝/学信网
能枚举 utun 接口检测到。把 MitM 挪到网关机后，手机上没有任何 VPN 配置。

用法:
    mitmdump -m transparent --listen-host 0.0.0.0 -p 8080 -s chsi_rewrite.py
    mitmweb  -m transparent --listen-host 0.0.0.0 -p 8080 -s chsi_rewrite.py

配置通过环境变量或改下面的常量。
"""

import json
import os
import re

from mitmproxy import http, ctx

# ---------- 配置 ----------

HOST_RE = re.compile(os.environ.get("CHSI_HOST_RE", r"(^|\.)(chsi\.com\.cn|chsi\.cn)$"))

YEAR_SHIFT = int(os.environ.get("CHSI_YEAR_SHIFT", "4"))
TARGET_DATE = os.environ.get("CHSI_TARGET_DATE", "")      # 整串替换，留空则用年份偏移
AGGRESSIVE = os.environ.get("CHSI_AGGRESSIVE", "0") == "1"
HTML_MODE = os.environ.get("CHSI_HTML_MODE", "1") == "1"
OBSERVER_SEC = int(os.environ.get("CHSI_OBSERVER_SEC", "600"))
DEBUG = os.environ.get("CHSI_DEBUG", "0") == "1"

# 标签改写对，格式 "标签=值||标签=值"
PAIRS = {}
for seg in os.environ.get("CHSI_PAIRS", "").split("||"):
    if "=" in seg:
        k, v = seg.split("=", 1)
        k, v = k.strip(), v.strip()
        if k:
            PAIRS[k] = v

DEFAULT_KEYS = [
    "byrq", "graduationDate", "graduateDate", "graduation", "graduate",
    "endDate", "endTime", "byTime", "graduateTime", "xxjsrq", "jssj",
    "xjsj", "bysj", "finishDate", "expectedGraduationDate",
    "毕业时间", "毕业年月", "预计毕业时间",
]

DEFAULT_LABELS = [
    "毕业时间", "毕业年月", "预计毕业", "结业时间",
    "学籍状态", "入学年月", "入学时间", "学制",
]

EXTRA_KEYS = [s.strip() for s in os.environ.get("CHSI_EXTRA_KEYS", "").split(",") if s.strip()]
EXTRA_LABELS = [s.strip() for s in os.environ.get("CHSI_EXTRA_LABELS", "").split(",") if s.strip()]
KEYS = DEFAULT_KEYS + EXTRA_KEYS
LABELS = DEFAULT_LABELS + EXTRA_LABELS

# 年份后紧跟分隔符+月份才认为是日期
YEAR_RE = re.compile(r"(\d{4})(?=[-/.]\s*\d{1,2}|年\s*\d{1,2})")
FULL_RE = re.compile(
    r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}"
    r"|\d{4}年\d{1,2}月\d{1,2}日?"
    r"|\d{4}年\d{1,2}月"
)


def rewrite_date(value):
    """年份偏移优先，保留原格式。"""
    if value is None:
        return value
    s = str(value)
    if YEAR_SHIFT:
        return YEAR_RE.sub(lambda m: str(int(m.group(1)) + YEAR_SHIFT), s)
    if TARGET_DATE:
        return FULL_RE.sub(TARGET_DATE, s)
    return s


# ---------- A. JSON 递归 ----------

def patch_json(node, counter):
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if key in KEYS and isinstance(value, (str, int, float)):
                new_value = rewrite_date(value)
                if str(new_value) != str(value):
                    node[key] = new_value
                    counter[0] += 1
            patch_json(value, counter)
    elif isinstance(node, list):
        for item in node:
            patch_json(item, counter)


# ---------- B. HTML 内联 JSON 串值 ----------

def patch_inline_json(html, counter):
    pattern = re.compile(
        r'("(?:' + "|".join(re.escape(k) for k in KEYS) + r')"\s*:\s*")([^"]*)(")',
        re.IGNORECASE,
    )

    def repl(m):
        head, value, tail = m.group(1), m.group(2), m.group(3)
        new_value = rewrite_date(value)
        if new_value == value:
            return m.group(0)
        counter[0] += 1
        return head + new_value + tail

    return pattern.sub(repl, html)


# ---------- C. 注入 DOM 改写脚本 ----------

INJECT_JS = r"""
(function(){
var C=__CFG__,N=0;
function L(m){if(C.debug&&window.console&&console.log)console.log("[chsi-shot] "+m);}
var YEAR_RE=/(\d{4})(?=[-\/.\u0020]*\d{1,2}|\u5e74\u0020*\d{1,2})/g;
var FULL_RE=/\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}|\d{4}\u5e74\d{1,2}\u6708\d{1,2}\u65e5?|\d{4}\u5e74\d{1,2}\u6708/g;
function rw(t){
  if(t===undefined||t===null)return t;
  var s=String(t);
  if(C.yearShift){return s.replace(YEAR_RE,function(m,y){return String(parseInt(y,10)+C.yearShift);});}
  if(C.targetDate){return s.replace(FULL_RE,C.targetDate);}
  return s;
}
function ctxOf(node){
  var s="",p=node,g=0;
  while(p&&g<4){
    if(p.nodeType===1){var pt=p.textContent||"";if(pt.length<400)s+=pt+" ";}
    var pv=p.previousSibling;if(pv&&pv.nodeType===1)s+=(pv.textContent||"")+" ";
    p=p.parentNode;g++;
  }
  return s;
}
function hasLabel(ctx){for(var i=0;i<C.labels.length;i++){if(ctx.indexOf(C.labels[i])!==-1)return true;}return false;}
function setText(node,v){
  if(node.nodeType===3){node.nodeValue=v;return true;}
  if(node.nodeType===1&&node.children.length===0){node.textContent=v;return true;}
  return false;
}
function nextValue(el){
  var c=el.nextElementSibling;if(c)return c;
  var p=el.parentElement;if(!p)return null;
  c=p.nextElementSibling;if(c)return c;
  var gp=p.parentElement;if(!gp)return null;
  c=gp.nextElementSibling;if(c)return c;
  return null;
}
function applyPairs(){
  var ks=Object.keys(C.pairs||{});
  if(!ks.length)return;
  var els=document.querySelectorAll("td,th,span,div,li,p,label,em,i,b");
  for(var i=0;i<els.length;i++){
    var el=els[i],txt=(el.textContent||"").trim();
    if(!txt||txt.length>60)continue;
    for(var j=0;j<ks.length;j++){
      var k=ks[j];
      if(txt===k||(txt.indexOf(k)===0&&txt.length<=k.length+8)){
        var tv=nextValue(el);
        if(tv&&setText(tv,C.pairs[k])){N++;}
      }
    }
  }
}
function walkState(o){
  if(!o||typeof o!=="object")return;
  if(Object.prototype.toString.call(o)==="[object Array]"){
    for(var i=0;i<o.length;i++)walkState(o[i]);
    return;
  }
  Object.keys(o).forEach(function(k){
    var v=o[k];
    if(typeof v==="string"||typeof v==="number"){
      var hit=false;
      for(var i=0;i<C.keys.length;i++){
        if(k===C.keys[i]||String(k).toLowerCase()===String(C.keys[i]).toLowerCase()){hit=true;break;}
      }
      if(hit){var nv=rw(v);if(nv!==String(v)){o[k]=nv;N++;}}
    }
    walkState(v);
  });
}
function scanText(){
  var root=document.body||document.documentElement;
  if(!root)return;
  var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null,false);
  var list=[];
  while(w.nextNode())list.push(w.currentNode);
  list.forEach(function(n){
    var t=n.nodeValue;
    if(!t)return;
    FULL_RE.lastIndex=0;
    if(!FULL_RE.test(t))return;
    FULL_RE.lastIndex=0;
    if(!C.aggressive&&!hasLabel(ctxOf(n)))return;
    var nt=rw(t);
    if(nt!==t){n.nodeValue=nt;N++;}
  });
  var ins=document.querySelectorAll("input,textarea");
  for(var i=0;i<ins.length;i++){
    var el=ins[i];
    if(!el.value)continue;
    var nv=rw(el.value);
    if(nv!==el.value){el.value=nv;N++;}
  }
}
function run(){
  try{
    walkState(window.__INITIAL_STATE__);
    walkState(window.__NUXT__);
    walkState(window.__DATA__);
    walkState(window.__NEXT_DATA__);
  }catch(e){}
  applyPairs();
  scanText();
}
run();
document.addEventListener("DOMContentLoaded",run,false);
window.addEventListener("load",run,false);
var timer=null;
function kick(){if(timer)return;timer=setTimeout(function(){timer=null;run();},80);}
try{
  var mo=new MutationObserver(kick);
  mo.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  setTimeout(function(){mo.disconnect();},C.observerMs);
}catch(e){}
setTimeout(function(){L("total replacements="+N);},1500);
})();
"""


def build_injector():
    cfg = {
        "targetDate": TARGET_DATE,
        "yearShift": YEAR_SHIFT,
        "pairs": PAIRS,
        "keys": KEYS,
        "labels": LABELS,
        "aggressive": AGGRESSIVE,
        "observerMs": OBSERVER_SEC * 1000,
        "debug": DEBUG,
    }
    body = INJECT_JS.replace("__CFG__", json.dumps(cfg, ensure_ascii=False))
    return "<script>" + body + "</script>"


def inject_script(html):
    # 替换内容必须用 lambda：注入脚本里的 \d 等转义会被 re.sub 当作反向引用处理，
    # 直接传字符串会抛 re.error: bad escape
    tag = build_injector()
    if re.search(r"</head>", html, re.IGNORECASE):
        return re.sub(r"</head>", lambda _m: tag + "</head>", html, count=1, flags=re.IGNORECASE)
    if re.search(r"</body>", html, re.IGNORECASE):
        return re.sub(r"</body>", lambda _m: tag + "</body>", html, count=1, flags=re.IGNORECASE)
    return tag + html


# ---------- mitmproxy hooks ----------

def request(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    if HOST_RE.search(host) and DEBUG:
        ctx.log.info("[req] %s %s" % (flow.request.method, flow.request.pretty_url))


def response(flow: http.HTTPFlow) -> None:
    req = flow.request
    host = req.pretty_host
    if not HOST_RE.search(host):
        return

    counter = [0]

    try:
        text = flow.response.text
    except Exception:
        return
    if not text:
        return

    content_type = ""
    headers = flow.response.headers or {}
    content_type = headers.get("Content-Type", "") or headers.get("content-type", "")

    body = text
    out = body

    if "json" in content_type.lower():
        try:
            obj = json.loads(body)
            patch_json(obj, counter)
            out = json.dumps(obj, ensure_ascii=False)
        except Exception:
            out = patch_inline_json(body, counter)
    elif "html" in content_type.lower():
        if HTML_MODE:
            out = patch_inline_json(body, counter)
            out = inject_script(out)
        if AGGRESSIVE:
            out = rewrite_date(out)
    else:
        try:
            obj = json.loads(body)
            patch_json(obj, counter)
            out = json.dumps(obj, ensure_ascii=False)
        except Exception:
            out = patch_inline_json(body, counter)
            if AGGRESSIVE:
                out = rewrite_date(out)

    if out != body:
        flow.response.text = out
        ctx.log.info("[patched %d] %s" % (counter[0], req.pretty_url))
    elif DEBUG:
        ctx.log.info("[miss] %s" % req.pretty_url)
