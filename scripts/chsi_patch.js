/**
 * chsi_patch.js — 毕业时间字段改写（Loon Response Script）
 *
 * 触发方式
 *   1) Response Script：Loon 解密 HTTPS 后把 $response.body 交给本脚本
 *   2) Generic Script：手动点「参数自检」，打印当前配置并试跑一次样例
 *
 * 改写策略（按响应内容类型分流）
 *   JSON  : 递归遍历，命中键名表即改值
 *   HTML  : 先替换内联 JSON 的串值（"key":"2024-06-30"），
 *           再注入一段 DOM 脚本兜住前端渲染后再写入的值
 *   其他文本: JSON 试解析，失败则在激进模式下做日期正则替换
 *
 * 退出约定
 *   只调用一次 $done()。改写成功传 { body }，否则传 {} 保留原响应。
 */

'use strict';

/* ---------- 默认键名表 ---------- */

var DEFAULT_KEYS = [
  'byrq', 'graduationDate', 'graduateDate', 'graduation', 'graduate',
  'endDate', 'endTime', 'byTime', 'graduateTime', 'xxjsrq', 'jssj',
  'xjsj', 'bysj', 'finishDate', 'expectedGraduationDate',
  '\u6bd5\u4e1a\u65f6\u95f4', '\u6bd5\u4e1a\u5e74\u6708', '\u9884\u8ba1\u6bd5\u4e1a\u65f6\u95f4',
];

var DATE_RE = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g;

/* ---------- 参数解析 ---------- */

function readArgs() {
  var a = (typeof $argument !== 'undefined' && $argument && typeof $argument === 'object') ? $argument : {};
  var rawKeys = String(a.extraKeys || '');
  var extra = rawKeys.split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });

  // 去掉首尾空白与包裹斜杠，让用户填 "chsi\.com\.cn" 或 "/chsi/i" 都能用
  var pattern = String(a.urlPattern === undefined || a.urlPattern === null ? '' : a.urlPattern).trim();

  return {
    urlPattern: pattern,
    gradDate: String(a.gradDate || '2028-06-30'),
    keys: DEFAULT_KEYS.concat(extra),
    aggressive: a.aggressive === true,
    htmlMode: a.htmlMode !== false,
    notify: a.notify === true,
    debug: a.debug === true,
  };
}

/* ---------- URL 命中判断 ---------- */

function urlMatches(url, pattern) {
  if (!pattern) return true;
  // 先当正则用；用户没写 /.../ 时补上
  try {
    var src = pattern;
    var flags = '';
    var m = /^\/(.*)\/([ims]*)$/.exec(pattern);
    if (m) { src = m[1]; flags = m[2]; }
    if (new RegExp(src, flags).test(url)) return true;
  } catch (e) { /* 正则非法，退回子串匹配 */ }
  return url.indexOf(pattern) !== -1;
}

/* ---------- 递归改 JSON ---------- */

function patchJSON(node, args, counter) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) patchJSON(node[i], args, counter);
    return node;
  }
  Object.keys(node).forEach(function (key) {
    var lower = key.toLowerCase();
    var hit = args.keys.some(function (k) {
      return key === k || lower === String(k).toLowerCase();
    });
    if (hit && (typeof node[key] === 'string' || typeof node[key] === 'number')) {
      if (String(node[key]) !== args.gradDate) {
        node[key] = args.gradDate;
        counter.count += 1;
      }
    }
    patchJSON(node[key], args, counter);
  });
  return node;
}

/* ---------- HTML: 内联 JSON 串值替换 ---------- */

function patchInlineJSON(html, args, counter) {
  var keys = args.keys.map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
  var re = new RegExp('("(?:' + keys.join('|') + ')"\\s*:\\s*")([^"]*)(")', 'gi');
  return html.replace(re, function (all, head, value, tail) {
    if (value === args.gradDate) return all;
    counter.count += 1;
    return head + args.gradDate + tail;
  });
}

/* ---------- HTML: 注入 DOM 改写脚本 ---------- */

function buildInjector(args) {
  var keys = JSON.stringify(args.keys);
  var date = JSON.stringify(args.gradDate);
  return [
    '<script>(function(){',
    'var K=' + keys + ',V=' + date + ',N=0;',
    'function lower(s){return String(s).toLowerCase();}',
    'function isKey(k){for(var i=0;i<K.length;i++){if(k===K[i]||lower(k)===lower(K[i]))return true;}return false;}',
    'function walk(o){if(!o||typeof o!=="object")return;',
    'if(Object.prototype.toString.call(o)==="[object Array]"){for(var i=0;i<o.length;i++)walk(o[i]);return;}',
    'Object.keys(o).forEach(function(k){if(isKey(k)&&(typeof o[k]==="string"||typeof o[k]==="number")){if(String(o[k])!==V){o[k]=V;N++;}}walk(o[k]);});}',
    'function patchDOM(){var els=document.querySelectorAll("[data-grad],[data-graduation],td,span,div");',
    'els.forEach(function(el){var t=el.textContent||"";K.forEach(function(k){if(t.indexOf(k)!==-1)return;});',
    'if(/\\d{4}[-\\/.]\\d{1,2}[-\\/.]\\d{1,2}/.test(t)&&el.children.length===0){',
    'var nt=t.replace(/\\d{4}[-\\/.]\\d{1,2}[-\\/.]\\d{1,2}/g,V);if(nt!==t){el.textContent=nt;N++;}}});}',
    'try{walk(window.__INITIAL_STATE__||null);walk(window.__NUXT__||null);walk(window.__DATA__||null);}catch(e){}',
    'patchDOM();',
    'var mo=new MutationObserver(function(){patchDOM();});',
    'try{mo.observe(document.documentElement,{childList:true,subtree:true});}catch(e){}',
    'setTimeout(function(){mo.disconnect();},8000);',
    'console.log("[chsi-patch] injected replacements: "+N);',
    '})();</script>',
  ].join('');
}

function injectScript(html, args) {
  var tag = buildInjector(args);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, tag + '</head>');
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, tag + '</body>');
  return tag + html;
}

/* ---------- 通用日期替换（激进模式） ---------- */

function patchAllDates(text, args, counter) {
  return text.replace(DATE_RE, function (hit) {
    counter.count += 1;
    return args.gradDate;
  });
}

/* ---------- 自检（Generic 入口） ---------- */

function selfTest(args) {
  var sample = {
    code: 0,
    data: {
      name: 'sample',
      graduationDate: '2024-06-30',
      byrq: '2024-06-30',
      nested: { endDate: '2024-06-30' },
      list: [{ graduateTime: '2024-06-30' }],
    },
  };
  var counter = { count: 0 };
  var patched = patchJSON(JSON.parse(JSON.stringify(sample)), args, counter);

  var html = '<html><head><title>t</title></head><body>'
    + '<script>var s={"graduationDate":"2024-06-30"};</script>'
    + '<div>2024-06-30</div></body></html>';

  console.log({
    mode: 'self-test',
    runtime: typeof $loon !== 'undefined' ? $loon : 'unknown',
    urlPattern: args.urlPattern,
    gradDate: args.gradDate,
    keyCount: args.keys.length,
    aggressive: args.aggressive,
    htmlMode: args.htmlMode,
    jsonReplacements: counter.count,
    jsonResult: patched,
    htmlSample: args.htmlMode
      ? injectScript(patchInlineJSON(html, args, { count: 0 }), args).slice(0, 400)
      : '(htmlMode off)',
    hint: 'Response 模式下本脚本只处理 urlPattern 命中的请求',
  });
  $done();
}

/* ---------- 主流程 ---------- */

function main() {
  var args = readArgs();

  // 没有 $response 说明是从 Generic 入口手动执行
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

  // binary_body_mode 下是 Uint8Array，本脚本只处理文本
  if (typeof body !== 'string') {
    if (args.debug) console.log('[skip] binary body');
    $done({});
    return;
  }

  var contentType = '';
  var headers = $response.headers || {};
  contentType = headers['Content-Type'] || headers['content-type'] || '';

  var counter = { count: 0 };
  var out = body;

  if (/json/i.test(contentType)) {
    try {
      var obj = JSON.parse(body);
      patchJSON(obj, args, counter);
      out = JSON.stringify(obj);
    } catch (e) {
      // 标了 json 但解析失败，退回内联串值替换
      out = patchInlineJSON(body, args, counter);
    }
  } else if (/html/i.test(contentType)) {
    if (args.htmlMode) {
      out = patchInlineJSON(body, args, counter);
      out = injectScript(out, args);
    }
    if (args.aggressive) out = patchAllDates(out, args, counter);
  } else {
    try {
      var obj2 = JSON.parse(body);
      patchJSON(obj2, args, counter);
      out = JSON.stringify(obj2);
    } catch (e2) {
      out = patchInlineJSON(body, args, counter);
      if (args.aggressive) out = patchAllDates(out, args, counter);
    }
  }

  if (counter.count > 0 && args.notify) {
    $notification.post(
      '毕业时间已改写',
      '替换 ' + counter.count + ' 处',
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

  if (out !== body) {
    $done({ body: out });
  } else {
    $done({});
  }
}

main();
