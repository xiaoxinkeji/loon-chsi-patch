/**
 * chsi_sniffer.js — 只记录不改写（Loon Response Script）
 *
 * 用途：在动手改写之前，先确认三件事
 *   1) 学信网页面到底向哪些接口发了请求
 *   2) 响应里有没有明文 JSON / HTML
 *   3) 毕业时间字段的真实键名是什么
 *
 * 记录存在 $persistentStore，键 chsi_sniffer_log，最多保留 maxKeep 条。
 * Generic 入口手动执行即导出全部记录并复制到剪贴板。
 */

'use strict';

var STORE_KEY = 'chsi_sniffer_log';

function readArgs() {
  var a = (typeof $argument !== 'undefined' && $argument && typeof $argument === 'object') ? $argument : {};
  return {
    urlPattern: String(a.urlPattern === undefined || a.urlPattern === null ? '' : a.urlPattern).trim(),
    snippet: Number(a.snippet) > 0 ? Number(a.snippet) : 600,
    maxKeep: Number(a.maxKeep) > 0 ? Number(a.maxKeep) : 30,
    debug: a.debug === true,
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
  } catch (e) { /* 退回子串匹配 */ }
  return url.indexOf(pattern) !== -1;
}

function loadLog() {
  var raw = $persistentStore.read(STORE_KEY);
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveLog(list, maxKeep) {
  while (list.length > maxKeep) list.shift();
  $persistentStore.write(JSON.stringify(list), STORE_KEY);
}

/* ---------- 从文本里挖出疑似日期字段名 ---------- */

var KEY_HINT = /(?:^|[^a-zA-Z])("?[a-zA-Z_\u4e00-\u9fa5]{2,24}"?\s*[:=]\s*["']?\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/g;

function extractDateKeys(text) {
  var found = {};
  var m;
  // 同时兼容 {"key":"2024-06-30"} 与 key=2024-06-30 两种写法
  var re = /([a-zA-Z_\u4e00-\u9fa5]{2,24})["']?\s*[:=]\s*["']?(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/g;
  var guard = 0;
  while ((m = re.exec(text)) !== null && guard < 200) {
    guard += 1;
    found[m[1]] = m[2];
  }
  return Object.keys(found).map(function (k) { return k + ' = ' + found[k]; });
}

/* ---------- 导出（Generic 入口） ---------- */

function exportLog(args) {
  var list = loadLog();
  var text = list.map(function (item, i) {
    return [
      '--- #' + (i + 1) + ' ---',
      'time   : ' + item.time,
      'method : ' + item.method,
      'url    : ' + item.url,
      'status : ' + item.status,
      'type   : ' + item.contentType,
      'bytes  : ' + item.length,
      'keys   : ' + (item.dateKeys || []).join(' | '),
      'body   : ' + item.snippet,
    ].join('\n');
  }).join('\n\n');

  var out = text || '(no records yet)';

  $notification.post(
    '学信网嗅探结果',
    '共 ' + list.length + ' 条',
    '点击复制到剪贴板',
    { clipboard: out },
    0
  );

  console.log(out.slice(0, 4000));
  $done();
}

/* ---------- 主流程 ---------- */

function main() {
  var args = readArgs();

  if (typeof $response === 'undefined' || !$response) {
    exportLog(args);
    return;
  }

  var url = $request && $request.url ? $request.url : '';
  if (!urlMatches(url, args.urlPattern)) {
    $done({});
    return;
  }

  var headers = $response.headers || {};
  var contentType = headers['Content-Type'] || headers['content-type'] || '';
  var body = $response.body;

  var snippet = '';
  var length = 0;
  var dateKeys = [];

  if (typeof body === 'string') {
    length = body.length;
    snippet = body.slice(0, args.snippet);
    dateKeys = extractDateKeys(body);
  } else if (body && body.length !== undefined) {
    length = body.length;
    snippet = '(binary ' + body.length + ' bytes)';
  }

  var list = loadLog();
  list.push({
    time: new Date().toISOString(),
    method: $request && $request.method ? $request.method : '',
    url: url,
    status: $response.status,
    contentType: contentType,
    length: length,
    dateKeys: dateKeys,
    snippet: snippet,
  });
  saveLog(list, args.maxKeep);

  console.log({
    captured: url,
    status: $response.status,
    contentType: contentType,
    length: length,
    dateKeys: dateKeys,
  });

  $done({});
}

main();
