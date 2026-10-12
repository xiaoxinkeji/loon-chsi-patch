const fs = require('fs');

function runScript(file, ctx) {
  const src = fs.readFileSync(file, 'utf8');
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.length === 1 ? a[0] : a) },
    $argument: ctx.$argument,
    $request: ctx.$request,
    $response: ctx.$response,
    $persistentStore: ctx.$persistentStore,
    $notification: { post: (...a) => logs.push({ notify: a }) },
    $done: (r) => { sandbox.__done = r; },
    $loon: 'test 3.5.1(983)',
    __done: undefined,
  };
  const fn = new Function(...Object.keys(sandbox), src + '\n');
  fn(...Object.values(sandbox));
  return { done: sandbox.__done, logs };
}

const PATCH = '/vol2/1000/海底捞/loon-chsi-patch/scripts/chsi_patch.js';
const SNIFF = '/vol2/1000/海底捞/loon-chsi-patch/scripts/chsi_sniffer.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name, extra !== undefined ? JSON.stringify(extra).slice(0,300) : ''); }
}

const base = { urlPattern: 'chsi', gradDate: '', yearShift: 4, pairs: '', extraKeys: '', extraLabels: '', aggressive: false, htmlMode: true, observerSec: 600, notify: false, debug: false };
const ps = { read: () => null, write: () => true };

function resp(url, ct, body) {
  return { $argument: base, $request: { url, method: 'GET' }, $response: { status: 200, headers: { 'Content-Type': ct }, body }, $persistentStore: ps };
}

// 1. yearShift on JSON
let r = runScript(PATCH, resp('https://my.chsi.com.cn/api/x', 'application/json',
  JSON.stringify({ data: { graduationDate: '2024-06-30', byrq: '2024年6月30日', name: 'x', nested: { endDate: '2024-06-30' }, list: [{ graduateTime: '2024-06-30' }] } })));
let o = r.done && r.done.body ? JSON.parse(r.done.body) : null;
check('yearShift json: graduationDate', o && o.data.graduationDate === '2028-06-30', o && o.data.graduationDate);
check('yearShift json: chinese format kept', o && o.data.byrq === '2028年6月30日', o && o.data.byrq);
check('yearShift json: nested', o && o.data.nested.endDate === '2028-06-30');
check('yearShift json: array', o && o.data.list[0].graduateTime === '2028-06-30');
check('yearShift json: untouched', o && o.data.name === 'x');

// 2. yearShift negative
r = runScript(PATCH, { $argument: Object.assign({}, base, { yearShift: -2 }), $request: { url: 'https://my.chsi.com.cn/a', method: 'GET' }, $response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"graduationDate":"2024-06-30"}' }, $persistentStore: ps });
check('negative yearShift', r.done && r.done.body.indexOf('2022-06-30') !== -1, r.done && r.done.body);

// 3. gradDate fallback (yearShift=0)
r = runScript(PATCH, { $argument: Object.assign({}, base, { yearShift: 0, gradDate: '2028-06-30' }), $request: { url: 'https://my.chsi.com.cn/a', method: 'GET' }, $response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"graduationDate":"2024-06-30"}' }, $persistentStore: ps });
check('gradDate fallback', r.done && r.done.body.indexOf('"graduationDate":"2028-06-30"') !== -1, r.done && r.done.body);

// 4. both empty -> no change
r = runScript(PATCH, { $argument: Object.assign({}, base, { yearShift: 0, gradDate: '' }), $request: { url: 'https://my.chsi.com.cn/a', method: 'GET' }, $response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"graduationDate":"2024-06-30"}' }, $persistentStore: ps });
check('no rule: unchanged', r.done && !r.done.body, r.done);

// 5. HTML injection contains config + observer
const html = '<html><head><title>t</title></head><body><script>var s={"graduationDate":"2024-06-30"};<\/script><div>毕业时间 2024-06-30</div></body></html>';
r = runScript(PATCH, resp('https://my.chsi.com.cn/p', 'text/html; charset=utf-8', html));
const h = r.done && r.done.body ? r.done.body : '';
check('html: inline replaced to 2028', h.indexOf('"graduationDate":"2028-06-30"') !== -1, h.slice(0,200));
check('html: injector present', h.indexOf('[chsi-shot]') !== -1);
check('html: yearShift config', h.indexOf('"yearShift":4') !== -1);
check('html: observerMs computed', h.indexOf('"observerMs":600000') !== -1);
check('html: labels present', h.indexOf('\\u6bd5\\u4e1a\\u65f6\\u95f4') !== -1 || h.indexOf('毕业') !== -1);
check('html: MutationObserver', h.indexOf('MutationObserver') !== -1);
check('html: head preserved', h.indexOf('</head>') !== -1);
check('html: script close not broken', h.indexOf('<\/script>') !== -1);

// 6. pairs parsing
r = runScript(PATCH, { $argument: Object.assign({}, base, { pairs: '学籍状态=在读||学制=4' }), $request: { url: 'https://my.chsi.com.cn/p', method: 'GET' }, $response: { status: 200, headers: { 'Content-Type': 'text/html' }, body: html }, $persistentStore: ps });
const h2 = r.done && r.done.body ? r.done.body : '';
check('pairs: injected as object', h2.indexOf('"pairs":{') !== -1, h2.slice(h2.indexOf('"pairs"'), h2.indexOf('"pairs"')+180));
check('pairs: value present', h2.indexOf('"pairs":{"学籍状态":"在读","学制":"4"}') !== -1);

// 7. aggressive
r = runScript(PATCH, { $argument: Object.assign({}, base, { aggressive: true }), $request: { url: 'https://my.chsi.com.cn/t', method: 'GET' }, $response: { status: 200, headers: { 'Content-Type': 'text/plain' }, body: '入学 2020-09-01 毕业 2024-06-30' }, $persistentStore: ps });
check('aggressive: both shifted', r.done && r.done.body.indexOf('2024-09-01') !== -1 && r.done.body.indexOf('2028-06-30') !== -1, r.done && r.done.body);

// 8. url miss
r = runScript(PATCH, { $argument: Object.assign({}, base, { urlPattern: 'nomatch' }), $request: { url: 'https://my.chsi.com.cn/a', method: 'GET' }, $response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"graduationDate":"2024-06-30"}' }, $persistentStore: ps });
check('url miss: empty', r.done && !r.done.body, r.done);

// 9. binary skip
r = runScript(PATCH, { $argument: base, $request: { url: 'https://my.chsi.com.cn/b', method: 'GET' }, $response: { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([1,2,3]) }, $persistentStore: ps });
check('binary: empty done', r.done && !r.done.body, r.done);

// 10. selftest
r = runScript(PATCH, { $argument: base, $request: undefined, $response: undefined, $persistentStore: ps });
const st = r.logs.find(l => l && l.mode === 'self-test');
check('selftest: ran', !!st);
check('selftest: yearShift shown', st && st.yearShift === 4, st && st.yearShift);
check('selftest: replacements > 0', st && st.jsonReplacements > 0, st && st.jsonReplacements);
check('selftest: chinese format kept', st && st.jsonResult && st.jsonResult.data.byrq === '2028年6月30日', st && st.jsonResult && st.jsonResult.data.byrq);
check('selftest: html inline replaced', st && st.htmlInlineReplaced === true, st && st.htmlInlineReplaced);
check('selftest: html injector present', st && st.htmlInjectorPresent === true, st && st.htmlInjectorPresent);

// 11. sniffer still works
let store = null;
const ps2 = { read: () => store, write: (v) => { store = v; return true; } };
r = runScript(SNIFF, { $argument: { urlPattern: 'chsi', snippet: 600, maxKeep: 5, debug: false }, $request: { url: 'https://my.chsi.com.cn/api/v', method: 'POST' }, $response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"graduationDate":"2024-06-30","byrq":"2024-06-30"}' }, $persistentStore: ps2 });
const rec = store ? JSON.parse(store) : [];
check('sniff: saved one', rec.length === 1);
check('sniff: keys extracted', rec[0] && rec[0].dateKeys.indexOf('graduationDate = 2024-06-30') !== -1, rec[0] && rec[0].dateKeys);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
