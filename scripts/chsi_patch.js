/**
 * chsi_patch.js v2 — 面向截图的毕业信息改写（Loon Response Script）
 *
 * 适用场景：认证结果以客户端截图上传为准。判定点在你手机屏幕上，
 * 所以本脚本的目标是「让渲染后的页面显示成想要的样子」，而不是改接口数据。
 *
 * 触发方式
 *   1) Response Script：Loon 解密 HTTPS 后把 $response.body 交给本脚本
 *   2) Generic Script：手动点「参数自检」，打印配置并跑一遍样例
 *
 * 三条改写通道
 *   A. 响应层 JSON   —— 递归改命中键名的值
 *   B. 响应层 HTML   —— 替换内联 JSON 串值
 *   C. 页面层 DOM    —— 注入脚本，改渲染后的文本节点、input 值、框架 state
 *
 * 截图保真是 C 通道的重点：
 *   - yearShift 模式只换年份，保留原格式（2024年6月30日 -> 2028年6月30日）
 *     比整串替换更不容易在截图里露馅
 *   - MutationObserver 常驻，兜住前端异步渲染后再写入的值
 *   - pairs 支持按标签改相邻单元格（学籍状态 在读 之类）
 *
 * 退出约定：只调用一次 $done()。有改动传 { body }，否则传 {} 保留原响应。
 */

'use strict';

/* ---------- 默认键名与标签（ASCII 源，中文用 \u 转义） ---------- */

var DEFAULT_KEYS = [
  'byrq', 'graduationDate', 'graduateDate', 'graduation', 'graduate',
  'endDate', 'endTime', 'byTime', 'graduateTime', 'xxjsrq', 'jssj',
  'xjsj', 'bysj', 'finishDate', 'expectedGraduationDate',
  '\u6bd5\u4e1a\u65f6\u95f4', '\u6bd5\u4e1a\u5e74\u6708', '\u9884\u8ba1\u6bd5\u4e1a\u65f6\u95f4',
];

var DEFAULT_LABELS = [
  '\u6bd5\u4e1a\u65f6\u95f4', '\u6bd5\u4e1a\u5e74\u6708', '\u9884\u8ba1\u6bd5\u4e1a',
  '\u7ed3\u4e1a\u65f6\u95f4', '\u5b66\u7c4d\u72b6\u6001', '\u5165\u5b66\u5e74\u6708',
  '\u5165\u5b66\u65f6\u95f4', '\u5b66\u5236',
];

// 年份后紧跟分隔符+月份，说明这是个日期；只替换年份可完整保留格式
var YEAR_RE = /(\d{4})(?=[-\/.]\s*\d{1,2}|\u5e74\s*\d{1,2})/g;
var FULL_RE = /\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}|\d{4}\u5e74\d{1,2}\u6708\d{1,2}\u65e5?|\d{4}\u5e74\d{1,2}\u6708/g;

/* ---------- 参数 ---------- */

function readArgs() {
  var a = (typeof $argument !== 'undefined' && $argument && typeof $argument === 'object') ? $argument : {};

  var rawKeys = String(a.extraKeys || '');
  var extraKeys = rawKeys.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });

  var rawLabels = String(a.extraLabels || '');
  var extraLabels = rawLabels.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });

  // pairs 格式: 标签=值||标签=值
  var pairs = {};
  String(a.pairs || '').split('||').forEach(function (seg) {
    var idx = seg.indexOf('=');
    if (idx <= 0) return;
    var k = seg.slice(0, idx).trim();
    var v = seg.slice(idx + 1).trim();
    if (k.length > 0) pairs[k] = v;
  });

  var yearShift = Number(a.yearShift);
  if (!isFinite(yearShift)) yearShift = 0;
  yearShift = Math.trunc(yearShift);

  var observerSec = Number(a.observerSec);
  if (!isFinite(observerSec) || observerSec <= 0) observerSec = 600;

  return {
    urlPattern: String(a.urlPattern === undefined || a.urlPattern === null ? '' : a.urlPattern).trim(),
    gradDate: String(a.gradDate || ''),
    yearShift: yearShift,
    pairs: pairs,
    keys: DEFAULT_KEYS.concat(extraKeys),
    labels: DEFAULT_LABELS.concat(extraLabels),
    aggressive: a.aggressive === true,
    htmlMode: a.htmlMode !== false,
    notify: a.notify === true,
    debug: a.debug === true,
    observerSec: observerSec,
  };
}

function urlMatches(url, pattern) {
  if (!pattern) return true;
  try {
    var src = pattern;
    var flags = '';
    var m = /^\/(.*)\/([ims]*)$/.exec(pattern);
    if (m) { src = m[1]; flags = m[2]; }
    if (new RegExp(src, flags).test(url)) return true;
  } catch (e) { /* 正则非法，退回子串匹配 */ }
  return url.indexOf(pattern) !== -1;
}

/* ---------- 日期改写：yearShift 优先（保格式） ---------- */

function rewriteDate(text, args) {
  if (text === undefined || text === null) return text;
  var s = String(text);
  if (args.yearShift !== 0) {
    return s.replace(YEAR_RE, function (all, y) {
      return String(parseInt(y, 10) + args.yearShift);
    });
  }
  if (args.gradDate) return s.replace(FULL_RE, args.gradDate);
  return s;
}

/* ---------- A. JSON 递归 ---------- */

function patchJSON(node, args, counter) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) patchJSON(node[i], args, counter);
    return node;
  }
  Object.keys(node).forEach(function (key) {
    var lower = String(key).toLowerCase();
    var hit = args.keys.some(function (k) {
      return key === k || lower === String(k).toLowerCase();
    });
    if (hit && (typeof node[key] === 'string' || typeof node[key] === 'number')) {
      var nv = rewriteDate(node[key], args);
      if (nv !== String(node[key])) {
        node[key] = nv;
        counter.count += 1;
      }
    }
    patchJSON(node[key], args, counter);
  });
  return node;
}

/* ---------- B. HTML 内联 JSON 串值 ---------- */

function patchInlineJSON(html, args, counter) {
  var keys = args.keys.map(function (k) { return String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
  var re = new RegExp('("(?:' + keys.join('|') + ')"\\s*:\\s*")([^"]*)(")', 'gi');
  return html.replace(re, function (all, head, value, tail) {
    var nv = rewriteDate(value, args);
    if (nv === value) return all;
    counter.count += 1;
    return head + nv + tail;
  });
}

/* ---------- C. 注入到页面的 DOM 改写脚本 ---------- */

var INJECT_LINES = [
  'var N=0;',
  'function L(m){if(C.debug&&window.console&&console.log)console.log("[chsi-shot] "+m);}',
  'var YEAR_RE=/(\\d{4})(?=[-\\/.]\\s*\\d{1,2}|\\u5e74\\s*\\d{1,2})/g;',
  'var FULL_RE=/\\d{4}[-\\/.]\\d{1,2}[-\\/.]\\d{1,2}|\\d{4}\\u5e74\\d{1,2}\\u6708\\d{1,2}\\u65e5?|\\d{4}\\u5e74\\d{1,2}\\u6708/g;',
  'function rw(t){',
  ' if(t===undefined||t===null)return t;',
  ' var s=String(t);',
  ' if(C.yearShift){return s.replace(YEAR_RE,function(m,y){return String(parseInt(y,10)+C.yearShift);});}',
  ' if(C.targetDate){return s.replace(FULL_RE,C.targetDate);}',
  ' return s;',
  '}',
  'function ctxOf(node){',
  ' var s="",p=node,g=0;',
  ' while(p&&g<4){',
  '  if(p.nodeType===1){var pt=p.textContent||"";if(pt.length<400)s+=pt+" ";}',
  '  var pv=p.previousSibling;if(pv&&pv.nodeType===1)s+=(pv.textContent||"")+" ";',
  '  p=p.parentNode;g++;',
  ' }',
  ' return s;',
  '}',
  'function hasLabel(ctx){for(var i=0;i<C.labels.length;i++){if(ctx.indexOf(C.labels[i])!==-1)return true;}return false;}',
  'function setText(node,v){',
  ' if(node.nodeType===3){node.nodeValue=v;return true;}',
  ' if(node.nodeType===1&&node.children.length===0){node.textContent=v;return true;}',
  ' return false;',
  '}',
  'function nextValue(el){',
  ' var c=el.nextElementSibling;if(c)return c;',
  ' var p=el.parentElement;if(!p)return null;',
  ' c=p.nextElementSibling;if(c)return c;',
  ' var gp=p.parentElement;if(!gp)return null;',
  ' c=gp.nextElementSibling;if(c)return c;',
  ' return null;',
  '}',
  'function applyPairs(){',
  ' var ks=Object.keys(C.pairs||{});if(!ks.length)return;',
  ' var els=document.querySelectorAll("td,th,span,div,li,p,label,em,i,b");',
  ' for(var i=0;i<els.length;i++){',
  '  var el=els[i],txt=(el.textContent||"").trim();',
  '  if(!txt||txt.length>60)continue;',
  '  for(var j=0;j<ks.length;j++){',
  '   var k=ks[j];',
  '   if(txt===k||(txt.indexOf(k)===0&&txt.length<=k.length+8)){',
  '    var tv=nextValue(el);',
  '    if(tv&&setText(tv,C.pairs[k])){N++;}',
  '   }',
  '  }',
  ' }',
  '}',
  'function walkState(o){',
  ' if(!o||typeof o!=="object")return;',
  ' if(Object.prototype.toString.call(o)==="[object Array]"){for(var i=0;i<o.length;i++)walkState(o[i]);return;}',
  ' Object.keys(o).forEach(function(k){',
  '  var v=o[k];',
  '  if(typeof v==="string"||typeof v==="number"){',
  '   var hit=false;',
  '   for(var i=0;i<C.keys.length;i++){if(k===C.keys[i]||String(k).toLowerCase()===String(C.keys[i]).toLowerCase()){hit=true;break;}}',
  '   if(hit){var nv=rw(v);if(nv!==String(v)){o[k]=nv;N++;}}',
  '  }',
  '  walkState(v);',
  ' });',
  '}',
  'function scanText(){',
  ' var root=document.body||document.documentElement;if(!root)return;',
  ' var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null,false);',
  ' var list=[];while(w.nextNode())list.push(w.currentNode);',
  ' list.forEach(function(n){',
  '  var t=n.nodeValue;if(!t)return;',
  '  FULL_RE.lastIndex=0;',
  '  if(!FULL_RE.test(t))return;',
  '  FULL_RE.lastIndex=0;',
  '  if(!C.aggressive&&!hasLabel(ctxOf(n)))return;',
  '  var nt=rw(t);',
  '  if(nt!==t){n.nodeValue=nt;N++;}',
  ' });',
  ' var ins=document.querySelectorAll("input,textarea");',
  ' for(var i=0;i<ins.length;i++){',
  '  var el=ins[i];if(!el.value)continue;',
  '  var nv=rw(el.value);if(nv!==el.value){el.value=nv;N++;}',
  ' }',
  '}',
  'function run(){',
  ' try{walkState(window.__INITIAL_STATE__);walkState(window.__NUXT__);',
  '  walkState(window.__DATA__);walkState(window.__NEXT_DATA__);}catch(e){}',
  ' applyPairs();scanText();',
  '}',
  'run();',
  'document.addEventListener("DOMContentLoaded",run,false);',
  'window.addEventListener("load",run,false);',
  'var timer=null;',
  'function kick(){if(timer)return;timer=setTimeout(function(){timer=null;run();},80);}',
  'try{',
  ' var mo=new MutationObserver(kick);',
  ' mo.observe(document.documentElement,{childList:true,subtree:true,characterData:true});',
  ' setTimeout(function(){mo.disconnect();},C.observerMs);',
  '}catch(e){}',
  'setTimeout(function(){L("total replacements="+N);},1500);',
];

function buildInjector(args) {
  var cfg = {
    targetDate: args.gradDate,
    yearShift: args.yearShift,
    pairs: args.pairs,
    keys: args.keys,
    labels: args.labels,
    aggressive: args.aggressive,
    observerMs: args.observerSec * 1000,
    debug: args.debug,
  };
  return '<script>(function(){var C=' + JSON.stringify(cfg) + ';'
    + INJECT_LINES.join('')
    + '})();<\/script>';
}

function injectScript(html, args) {
  var tag = buildInjector(args);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, tag + '</head>');
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, tag + '</body>');
  return tag + html;
}

/* ---------- 自检 ---------- */

function selfTest(args) {
  var sample = {
    code: 0,
    data: {
      name: 'sample',
      graduationDate: '2024-06-30',
      byrq: '2024\u5e746\u670830\u65e5',
      nested: { endDate: '2024-06-30' },
      list: [{ graduateTime: '2024-06-30' }],
    },
  };
  var counter = { count: 0 };
  var patched = patchJSON(JSON.parse(JSON.stringify(sample)), args, counter);

  var html = '<html><head><title>t</title></head><body>'
    + '<script>var s={"graduationDate":"2024-06-30"};<\/script>'
    + '<div>\u6bd5\u4e1a\u65f6\u95f4 2024-06-30</div></body></html>';

  var htmlPatched = args.htmlMode
    ? injectScript(patchInlineJSON(html, args, { count: 0 }), args)
    : html;

  console.log({
    mode: 'self-test',
    runtime: typeof $loon !== 'undefined' ? $loon : 'unknown',
    urlPattern: args.urlPattern,
    gradDate: args.gradDate,
    yearShift: args.yearShift,
    pairs: args.pairs,
    keyCount: args.keys.length,
    labelCount: args.labels.length,
    aggressive: args.aggressive,
    observerSec: args.observerSec,
    jsonReplacements: counter.count,
    jsonResult: patched,
    // 注入脚本很长，正文会被挤到后面，单独给个判定字段比截断样本可靠
    htmlHasTarget: /2028|202\d/.test(htmlPatched),
    htmlInlineReplaced: htmlPatched.indexOf('"graduationDate":"2028-06-30"') !== -1,
    htmlInjectorPresent: htmlPatched.indexOf('chsi-shot') !== -1,
    htmlBytes: htmlPatched.length,
    htmlSample: htmlPatched.slice(0, 400),
    hint: 'yearShift 优先于 gradDate；只换年份可保留原格式',
  });
  $done();
}

/* ---------- 主流程 ---------- */

function main() {
  var args = readArgs();

  if (typeof $response === 'undefined' || !$response) {
    selfTest(args);
    return;
  }

  var url = $request && $request.url ? $request.url : '';
  if (!urlMatches(url, args.urlPattern)) {
    if (args.debug) console.log('[skip] url not matched: ' + url);
    $done({});
    return;
  }

  var body = $response.body;
  if (body === undefined || body === null) {
    $done({});
    return;
  }
  if (typeof body !== 'string') {
    if (args.debug) console.log('[skip] binary body');
    $done({});
    return;
  }

  var headers = $response.headers || {};
  var contentType = headers['Content-Type'] || headers['content-type'] || '';

  var counter = { count: 0 };
  var out = body;

  if (/json/i.test(contentType)) {
    try {
      var obj = JSON.parse(body);
      patchJSON(obj, args, counter);
      out = JSON.stringify(obj);
    } catch (e) {
      out = patchInlineJSON(body, args, counter);
    }
  } else if (/html/i.test(contentType)) {
    if (args.htmlMode) {
      out = patchInlineJSON(body, args, counter);
      out = injectScript(out, args);
    }
    if (args.aggressive) out = rewriteDate(out, args);
  } else {
    try {
      var obj2 = JSON.parse(body);
      patchJSON(obj2, args, counter);
      out = JSON.stringify(obj2);
    } catch (e2) {
      out = patchInlineJSON(body, args, counter);
      if (args.aggressive) out = rewriteDate(out, args);
    }
  }

  if (counter.count > 0 && args.notify) {
    $notification.post(
      '\u6bd5\u4e1a\u4fe1\u606f\u5df2\u6539\u5199',
      '\u66ff\u6362 ' + counter.count + ' \u5904',
      url.slice(0, 120),
      null,
      0
    );
  }

  if (args.debug) {
    console.log({
      mode: 'response',
      url: url,
      status: $response.status,
      contentType: contentType,
      replacements: counter.count,
    });
  }

  $done(out !== body ? { body: out } : {});
}

main();
