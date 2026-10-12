/**
 * chsi_bookmarklet.js — Safari/Chrome 书签脚本（bookmarklet）版本
 *
 * 用法：
 *   1. Safari 里新建一个书签，名称随意（如 "改毕业时间"）
 *   2. 把本文件压缩后的单行代码粘进书签的 URL 栏，以 javascript: 开头
 *   3. 在学信网页面打开后点这个书签 → 页面上的毕业时间被改写 → 截图
 *
 * 与 Loon 插件 / mitmproxy addon 的改写逻辑完全一致：
 *   - yearShift 优先，只换年份保留原格式
 *   - pairs 按标签改相邻单元格
 *   - MutationObserver 持续兜住异步渲染
 *
 * 优点：完全不依赖网络劫持，不需要证书、不需要电脑、不触发 VPN 检测。
 * 判定只认截图内容时，这条路最直接。
 */

(function () {
  'use strict';

  // ===== 配置（改书签时按需调整这几行） =====
  var C = {
    yearShift: 4,            // 只换年份，保留原格式：2024年6月30日 -> 2028年6月30日
    targetDate: '',          // 整串替换值，留空则用 yearShift
    pairs: {                 // 标签 -> 目标值，改标签相邻的单元格
      // '学籍状态': '在读',
      // '学制': '4'
    },
    keys: ['byrq', 'graduationDate', 'graduateDate', 'graduation', 'graduate',
           'endDate', 'endTime', 'byTime', 'graduateTime', 'xxjsrq', 'jssj',
           'xjsj', 'bysj', 'finishDate', 'expectedGraduationDate',
           '毕业时间', '毕业年月', '预计毕业时间'],
    labels: ['毕业时间', '毕业年月', '预计毕业', '结业时间',
             '学籍状态', '入学年月', '入学时间', '学制'],
    aggressive: false,       // true = 不限标签改所有日期（会误伤）
    observerMs: 600000       // 持续改写时长，覆盖到截图完成
  };

  var N = 0;

  var YEAR_RE = /(\d{4})(?=[-/.]\s*\d{1,2}|年\s*\d{1,2})/g;
  var FULL_RE = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日?|\d{4}年\d{1,2}月/g;

  function rw(t) {
    if (t === undefined || t === null) return t;
    var s = String(t);
    if (C.yearShift) {
      return s.replace(YEAR_RE, function (m, y) { return String(parseInt(y, 10) + C.yearShift); });
    }
    if (C.targetDate) return s.replace(FULL_RE, C.targetDate);
    return s;
  }

  function ctxOf(node) {
    var s = '', p = node, g = 0;
    while (p && g < 4) {
      if (p.nodeType === 1) {
        var pt = p.textContent || '';
        if (pt.length < 400) s += pt + ' ';
      }
      var pv = p.previousSibling;
      if (pv && pv.nodeType === 1) s += (pv.textContent || '') + ' ';
      p = p.parentNode; g++;
    }
    return s;
  }

  function hasLabel(ctx) {
    for (var i = 0; i < C.labels.length; i++) {
      if (ctx.indexOf(C.labels[i]) !== -1) return true;
    }
    return false;
  }

  function setText(node, v) {
    if (node.nodeType === 3) { node.nodeValue = v; return true; }
    if (node.nodeType === 1 && node.children.length === 0) { node.textContent = v; return true; }
    return false;
  }

  function nextValue(el) {
    var c = el.nextElementSibling;
    if (c) return c;
    var p = el.parentElement;
    if (!p) return null;
    c = p.nextElementSibling;
    if (c) return c;
    var gp = p.parentElement;
    if (!gp) return null;
    c = gp.nextElementSibling;
    if (c) return c;
    return null;
  }

  function applyPairs() {
    var ks = Object.keys(C.pairs || {});
    if (!ks.length) return;
    var els = document.querySelectorAll('td,th,span,div,li,p,label,em,i,b');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], txt = (el.textContent || '').trim();
      if (!txt || txt.length > 60) continue;
      for (var j = 0; j < ks.length; j++) {
        var k = ks[j];
        if (txt === k || (txt.indexOf(k) === 0 && txt.length <= k.length + 8)) {
          var tv = nextValue(el);
          if (tv && setText(tv, C.pairs[k])) N++;
        }
      }
    }
  }

  function walkState(o) {
    if (!o || typeof o !== 'object') return;
    if (Object.prototype.toString.call(o) === '[object Array]') {
      for (var i = 0; i < o.length; i++) walkState(o[i]);
      return;
    }
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (typeof v === 'string' || typeof v === 'number') {
        var hit = false;
        for (var i = 0; i < C.keys.length; i++) {
          if (k === C.keys[i] || String(k).toLowerCase() === String(C.keys[i]).toLowerCase()) { hit = true; break; }
        }
        if (hit) {
          var nv = rw(v);
          if (nv !== String(v)) { o[k] = nv; N++; }
        }
      }
      walkState(v);
    });
  }

  function scanText() {
    var root = document.body || document.documentElement;
    if (!root) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var list = [];
    while (w.nextNode()) list.push(w.currentNode);
    list.forEach(function (n) {
      var t = n.nodeValue;
      if (!t) return;
      FULL_RE.lastIndex = 0;
      if (!FULL_RE.test(t)) return;
      FULL_RE.lastIndex = 0;
      if (!C.aggressive && !hasLabel(ctxOf(n))) return;
      var nt = rw(t);
      if (nt !== t) { n.nodeValue = nt; N++; }
    });
    var ins = document.querySelectorAll('input,textarea');
    for (var i = 0; i < ins.length; i++) {
      var el = ins[i];
      if (!el.value) continue;
      var nv = rw(el.value);
      if (nv !== el.value) { el.value = nv; N++; }
    }
  }

  function run() {
    try {
      walkState(window.__INITIAL_STATE__);
      walkState(window.__NUXT__);
      walkState(window.__DATA__);
      walkState(window.__NEXT_DATA__);
    } catch (e) {}
    applyPairs();
    scanText();
  }

  run();

  // 持续兜住异步渲染
  var timer = null;
  function kick() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; run(); }, 80);
  }
  try {
    var mo = new MutationObserver(kick);
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setTimeout(function () { mo.disconnect(); }, C.observerMs);
  } catch (e) {}

  // 提示改了几处
  var tip = document.createElement('div');
  tip.textContent = '已改写 ' + N + ' 处';
  tip.style.cssText = 'position:fixed;z-index:99999;top:12px;right:12px;padding:8px 14px;'
    + 'background:#000;color:#fff;font:14px/1.4 -apple-system,sans-serif;border-radius:8px;opacity:.92';
  document.body.appendChild(tip);
  setTimeout(function () { tip.remove(); }, 3000);
})();
