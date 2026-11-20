// 零依赖验收：实测 app-base.js 的 esc / safeImageUrl 对注入载荷的处理。
// 用 vm + 最小 DOM 桩真实加载浏览器脚本，不做纯字符串断言。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-base.js'), 'utf8');
const sandbox = {
  window: {},
  document: { querySelector: () => null, baseURI: 'http://localhost/' },
  location: { protocol: 'http:' },
  URL
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const esc = sandbox.window.esc;
const safe = sandbox.window.safeImageUrl;
let pass = 0;
let total = 0;

function check(name, ok, detail) {
  total++;
  if (ok) pass++;
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  -> ' + detail : ''));
}

// H2：用户可控字段作为文本/属性插入 innerHTML 前必须被转义
const payloads = [
  '<img src=x onerror=alert(1)>',
  '" onmouseover="alert(1)',
  '<script>alert(1)</script>',
  'A&B<C>"D\'E',
  'javascript:alert(1)'
];
for (const p of payloads) {
  const out = esc(p);
  // 判定标准：所有能闭合标签/属性的字符（< > " '）都必须被编码成实体。
  // 转义后残留的 onerror= 等字样只是纯文本，浏览器不会再当作属性解析。
  const clean = !/[<>"']/.test(out);
  check('esc: ' + p, clean, JSON.stringify(out));
}
check('esc: null 安全', esc(null) === '');
check('esc: 数字', esc(123) === '123');

// H2 建议3：图片 URL 白名单
const urls = [
  ['data:image/jpeg;base64,AAAA', true],
  ['data:image/png;base64,AAAA', true],
  ['/uploads/a.png', true],
  ['/images/a.png', true],
  ['/api/image/1', true],
  ['data:text/html;base64,AAAA', false],
  ['javascript:alert(1)', false],
  ['https://evil.example/x.png', false],
  ['//evil.example/x.png', false]
];
for (const [u, want] of urls) {
  const got = Boolean(safe(u));
  check('safeImageUrl: ' + u, got === want, JSON.stringify(safe(u)));
}

console.log('\n汇总：' + pass + '/' + total + ' 项通过');
if (pass !== total) process.exit(1);
