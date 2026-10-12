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
  else { fail++; console.log('FAIL  ' + name, extra !== undefined ? extra : ''); }
}

// --- 1. patch: JSON response ---
const argsJson = { urlPattern: 'chsi', gradDate: '2028-06-30', extraKeys: '', aggressive: false, htmlMode: true, notify: false, debug: false };
const bodyJson = JSON.stringify({ code: 0, data: { graduationDate: '2024-06-30', byrq: '2024-06-30', name: 'x', nested: { endDate: '2024-06-30' }, list: [{ graduateTime: '2024-06-30' }] } });
let r = runScript(PATCH, {
  $argument: argsJson,
  $request: { url: 'https://my.chsi.com.cn/api/xjxl', method: 'GET' },
  $response: { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: bodyJson },
  $persistentStore: { read: () => null, write: () => true },
});
check('json: body returned', r.done && typeof r.done.body === 'string');
const outJson = r.done ? JSON.parse(r.done.body) : null;
check('json: graduationDate', outJson && outJson.data.graduationDate === '2028-06-30', outJson);
check('json: byrq', outJson && outJson.data.byrq === '2028-06-30');
check('json: nested endDate', outJson && outJson.data.nested.endDate === '2028-06-30');
check('json: array item', outJson && outJson.data.list[0].graduateTime === '2028-06-30');
check('json: untouched field', outJson && outJson.data.name === 'x');

// --- 2. patch: url miss → no change ---
r = runScript(PATCH, {
  $argument: Object.assign({}, argsJson, { urlPattern: 'nomatch' }),
  $request: { url: 'https://my.chsi.com.cn/api/xjxl', method: 'GET' },
  $response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: bodyJson },
  $persistentStore: { read: () => null, write: () => true },
});
check('url miss: empty done', r.done && !r.done.body, r.done);

// --- 3. patch: HTML ---
const bodyHtml = '<html><head><title>t</title></head><body><script>var s={"graduationDate":"2024-06-30"};</script><div>2024-06-30</div></body></html>';
r = runScript(PATCH, {
  $argument: argsJson,
  $request: { url: 'https://my.chsi.com.cn/xjxl/report', method: 'GET' },
  $response: { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: bodyHtml },
  $persistentStore: { read: () => null, write: () => true },
});
const h = r.done && r.done.body ? r.done.body : '';
check('html: inline json replaced', h.indexOf('"graduationDate":"2028-06-30"') !== -1, h.slice(0, 200));
check('html: injector present', h.indexOf('[chsi-patch] injected replacements') !== -1);
check('html: head preserved', h.indexOf('</head>') !== -1);

// --- 4. patch: aggressive mode on text ---
r = runScript(PATCH, {
  $argument: Object.assign({}, argsJson, { aggressive: true }),
  $request: { url: 'https://my.chsi.com.cn/a.txt', method: 'GET' },
  $response: { status: 200, headers: { 'Content-Type': 'text/plain' }, body: '入学年月 2020-09-01 毕业 2024-06-30' },
  $persistentStore: { read: () => null, write: () => true },
});
check('aggressive: dates replaced', r.done && r.done.body.indexOf('2028-06-30') !== -1 && r.done.body.indexOf('2024-06-30') === -1, r.done);

const idx = r.done ? r.done.body.indexOf('2020-09-01') : 0;
check('aggressive: replaces all dates', idx === -1);

// --- 5. patch: non-200 skipped by plugin but guard test ---
r = runScript(PATCH, {
  $argument: argsJson,
  $request: { url: 'https://my.chsi.com.cn/api/x', method: 'GET' },
  $response: { status: 404, headers: { 'Content-Type': 'application/json' }, body: bodyJson },
  $persistentStore: { read: () => null, write: () => true },
});
check('404: still patches (script trusts guard)', r.done && r.done.body && r.done.body.indexOf('2028-06-30') !== -1, r.done);

// --- 6. patch: self test (generic) ---
r = runScript(PATCH, { $argument: argsJson, $request: undefined, $response: undefined, $persistentStore: { read: () => null, write: () => true } });
check('selftest: no throw', r.logs.length > 0);
const st = r.logs.find(l => l && l.mode === 'self-test');
check('selftest: jsonReplacements > 0', st && st.jsonReplacements > 0, st && st.jsonReplacements);
check('selftest: html sample patched', st && String(st.htmlSample).indexOf('2028-06-30') !== -1);

// --- 7. sniffer: record ---
let store = null;
const ps = { read: () => store, write: (v) => { store = v; return true; } };
r = runScript(SNIFF, {
  $argument: { urlPattern: 'chsi', snippet: 600, maxKeep: 5, debug: false },
  $request: { url: 'https://my.chsi.com.cn/api/v', method: 'POST' },
  $response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"graduationDate":"2024-06-30","byrq":"2024-06-30"}' },
  $persistentStore: ps,
});
check('sniff: saved', !!store);
const rec = store ? JSON.parse(store) : [];
check('sniff: one record', rec.length === 1, rec.length);
check('sniff: keys extracted', rec[0] && rec[0].dateKeys.indexOf('graduationDate = 2024-06-30') !== -1, rec[0] && rec[0].dateKeys);
check('sniff: byrq extracted', rec[0] && rec[0].dateKeys.indexOf('byrq = 2024-06-30') !== -1);

// --- 8. sniffer: export ---
r = runScript(SNIFF, { $argument: { urlPattern: 'chsi', snippet: 600, maxKeep: 5, debug: false }, $request: undefined, $response: undefined, $persistentStore: ps });
const notify = r.logs.find(l => l && l.notify);
check('sniff export: clipboard set', notify && String(notify.notify[3].clipboard).indexOf('graduationDate') !== -1, notify && notify.notify[3]);

// --- 9. sniffer: maxKeep trim ---
store = JSON.stringify(Array.from({length: 5}, (_, i) => ({ url: 'u' + i, time: 't', method: 'GET', status: 200, contentType: '', length: 0, dateKeys: [], snippet: '' })));
r = runScript(SNIFF, {
  $argument: { urlPattern: 'chsi', snippet: 600, maxKeep: 5, debug: false },
  $request: { url: 'https://my.chsi.com.cn/new', method: 'GET' },
  $response: { status: 200, headers: { 'Content-Type': 'text/html' }, body: 'x' },
  $persistentStore: ps,
});
const rec2 = JSON.parse(store);
check('sniff: trimmed to maxKeep', rec2.length === 5, rec2.length);
check('sniff: oldest dropped', rec2[0].url !== 'u0');
check('sniff: newest kept', rec2[rec2.length - 1].url === 'https://my.chsi.com.cn/new');

// --- 10. patch: binary body skipped ---
r = runScript(PATCH, {
  $argument: argsJson,
  $request: { url: 'https://my.chsi.com.cn/x', method: 'GET' },
  $response: { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([1,2,3]) },
  $persistentStore: { read: () => null, write: () => true },
});
check('binary: empty done', r.done && !r.done.body, r.done);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
