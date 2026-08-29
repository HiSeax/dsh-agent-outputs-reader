/**
 * @dsh-external/dsh-agent-outputs-reader 宿主回归测试（node --test）。
 * 覆盖：路径解析（junction 穿透）、suggest、路由（新旧双前缀、Host 白名单、office/pdf/raw）。
 */
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execSync } = require('node:child_process')

const SRC = path.join(__dirname, '..', 'src', 'index.js')

let mod = null
test.before(async () => {
  mod = await import('file://' + SRC.replace(/\\/g, '/'))
})

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aor-test-'))
  const reports = path.join(base, 'reports')
  const sent = path.join(base, 'ws', 'sent-files')
  const ws = path.join(base, 'ws')
  fs.mkdirSync(path.join(reports, 'v1', 'sub'), { recursive: true })
  fs.mkdirSync(sent, { recursive: true })
  fs.writeFileSync(path.join(reports, 'v1', 'r.md'), '# R')
  fs.writeFileSync(path.join(reports, 'top.md'), '# TOP')
  fs.writeFileSync(path.join(reports, 'v1', 'stats.json'), '{"a":1}')
  fs.writeFileSync(path.join(reports, 'v1', 'doc.pdf'), '%PDF-1.4 fake')
  fs.writeFileSync(path.join(sent, 's.md'), '# S')
  fs.writeFileSync(path.join(ws, 'note.md'), '# N')
  fs.writeFileSync(path.join(ws, 'secret.txt'), 'x')
  return { base, reports, sent, ws }
}

test('extOf 小写扩展名', () => {
  assert.equal(mod.extOf('A.MD'), '.md')
  assert.equal(mod.extOf('X.Docx'), '.docx')
})

test('resolveReaderPath：穿越/越界拒绝', () => {
  const fx = makeFixture()
  assert.equal(mod.resolveReaderPath(fx.reports, fx.sent, fx.ws, '../ws/secret.txt'), null)
  assert.equal(mod.resolveReaderPath(fx.reports, fx.sent, fx.ws, 'C:\\Windows\\win.ini'), null)
  fs.rmSync(fx.base, { recursive: true, force: true })
})

test('resolveReaderPath：sent-files 与工作区规则', () => {
  const fx = makeFixture()
  assert.equal(mod.resolveReaderPath(fx.reports, fx.sent, fx.ws, 'sent-files/s.md').rel, 'sent-files/s.md')
  assert.ok(mod.resolveReaderPath(fx.reports, fx.sent, fx.ws, path.join(fx.ws, 'note.md')))
  assert.equal(mod.resolveReaderPath(fx.reports, fx.sent, fx.ws, path.join(fx.ws, 'secret.txt')), null)
  fs.rmSync(fx.base, { recursive: true, force: true })
})

test('resolveReaderPath：junction 穿透拒绝', (t) => {
  const fx = makeFixture()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aor-out-'))
  fs.writeFileSync(path.join(out, 'note.md'), '# OUT')
  try {
    execSync('cmd /c mklink /J "' + path.join(fx.reports, 'evil') + '" "' + out + '"', { stdio: 'pipe' })
  } catch {
    t.skip('mklink 不可用')
    fs.rmSync(fx.base, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
    return
  }
  assert.equal(mod.resolveReaderPath(fx.reports, fx.sent, fx.ws, 'evil/note.md'), null)
  fs.rmSync(fx.base, { recursive: true, force: true })
  fs.rmSync(out, { recursive: true, force: true })
})

test('suggestReport：实验目录优先', () => {
  const fx = makeFixture()
  fs.mkdirSync(path.join(fx.reports, 'v2'), { recursive: true })
  fs.writeFileSync(path.join(fx.reports, 'v2', 'V2.1_report.md'), '# v21')
  const s = mod.suggestReport(fx.reports)
  assert.ok(s && s.path === 'v2/V2.1_report.md')
  fs.rmSync(fx.base, { recursive: true, force: true })
})

/* ---------- Office 文本提取（纯函数，手工 stored zip fixture） ---------- */

function crc32(buf) {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  let c = 0xffffffff
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function makeStoredZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.from(e.data, 'utf8')
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    locals.push(Buffer.concat([lh, name, data]))
    centrals.push(Buffer.concat([ch, name]))
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

test('docxToText 提取段落', () => {
  const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
    + '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> World</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>&amp; 实体</w:t></w:r></w:p>'
    + '</w:body></w:document>'
  const text = mod.docxToText(makeStoredZip([{ name: 'word/document.xml', data: xml }]))
  assert.ok(text.includes('Hello World'))
  assert.ok(text.includes('& 实体'))
})

test('xlsxToText 提取行列（sharedStrings）', () => {
  const shared = '<?xml version="1.0"?><sst xmlns="x"><si><t>名称</t></si><si><t>数值</t></si></sst>'
  const sheet = '<?xml version="1.0"?><worksheet xmlns="x"><sheetData>'
    + '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>'
    + '<row><c t="s"><v>0</v></c><c><v>42</v></c></row>'
    + '</sheetData></worksheet>'
  const text = mod.xlsxToText(makeStoredZip([
    { name: 'xl/sharedStrings.xml', data: shared },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]))
  assert.ok(text.includes('名称\t数值'))
  assert.ok(text.includes('名称\t42'))
})

test('pptxToText 按页分组', () => {
  const text = mod.pptxToText(makeStoredZip([
    { name: 'ppt/slides/slide1.xml', data: '<p:sld xmlns:a="x"><a:t>第一页内容</a:t></p:sld>' },
    { name: 'ppt/slides/slide2.xml', data: '<p:sld xmlns:a="x"><a:t>第二页内容</a:t></p:sld>' },
  ]))
  assert.ok(text.includes('第 1 页'))
  assert.ok(text.includes('第一页内容'))
  assert.ok(text.includes('第 2 页'))
})

test('zipEntries：损坏文件抛错', () => {
  assert.throws(() => mod.zipEntries(Buffer.from('not a zip at all')))
})

/* ---------- 路由集成 ---------- */

const API_NEW = '/@dsh-external/dsh-agent-outputs-reader/api'
const API_LEGACY = '/@dsh-external/dsh-report-card/api'

function makeCtx() {
  const routes = new Map()
  return {
    routes,
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => routes.delete(spec.path)
      },
    },
    effect(fn) { fn() },
  }
}

function makeReq(url, opts = {}) {
  return {
    url,
    method: opts.method || 'GET',
    headers: { host: '127.0.0.1:3080', accept: '*/*', ...(opts.headers || {}) },
  }
}

async function dispatch(handler, url, opts) {
  return new Promise((resolveDone) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) { resolveDone({ status: res.statusCode, body: body ? Buffer.from(body).toString('utf8') : '' }) },
    }
    handler(makeReq(url, opts), res)
  })
}

let FX = null
test.before(() => {
  FX = makeFixture()
  process.env.DSH_REPORTS_ROOT = FX.reports
  process.env.DSH_HOME = FX.ws
})

test('路由：新旧双前缀均注册', () => {
  const ctx = makeCtx()
  mod.apply(ctx, {})
  for (const p of [API_NEW, API_LEGACY]) {
    assert.ok(ctx.routes.get(p + '/info'), p + '/info 未注册')
    assert.ok(ctx.routes.get(p + '/file'), p + '/file 未注册')
    assert.ok(ctx.routes.get(p + '/raw'), p + '/raw 未注册')
  }
})

test('路由：/file 文本读取与穿越拒绝', async () => {
  const ctx = makeCtx()
  mod.apply(ctx, {})
  const file = ctx.routes.get(API_NEW + '/file')
  const ok = await dispatch(file, '/x?path=' + encodeURIComponent('v1/r.md'))
  assert.equal(ok.status, 200)
  assert.ok(JSON.parse(ok.body).content.includes('# R'))
  const bad = await dispatch(file, '/x?path=' + encodeURIComponent('../../ws/secret.txt'))
  assert.equal(bad.status, 400)
})

test('路由：Host 白名单拒绝非本机来源', async () => {
  const ctx = makeCtx()
  mod.apply(ctx, {})
  const info = ctx.routes.get(API_NEW + '/info')
  const bad = await dispatch(info, '/x', { headers: { host: 'evil.example.com', accept: '*/*' } })
  assert.equal(bad.status, 403)
  const ok = await dispatch(info, '/x')
  assert.equal(ok.status, 200)
  const body = JSON.parse(ok.body)
  assert.ok(body.roots && body.roots.reports && body.roots.sent && body.roots.ws)
  assert.ok(body.exps.includes('.pdf') && body.exps.includes('.docx') && body.exps.includes('.xlsx') && body.exps.includes('.pptx'))
})

test('路由：PDF 返回 rawUrl，/raw 出字节', async () => {
  const ctx = makeCtx()
  mod.apply(ctx, {})
  const file = ctx.routes.get(API_NEW + '/file')
  const r = await dispatch(file, '/x?path=' + encodeURIComponent('v1/doc.pdf'))
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.equal(body.type, 'pdf')
  assert.ok(body.rawUrl.includes('/api/raw'))
  const raw = ctx.routes.get(API_NEW + '/raw')
  const rr = await dispatch(raw, '/x?path=' + encodeURIComponent('v1/doc.pdf'))
  assert.equal(rr.status, 200)
  assert.ok(rr.body.startsWith('%PDF'))
})

test('路由：docx 文本预览与损坏文件不泄露路径', async () => {
  const docx = makeStoredZip([{
    name: 'word/document.xml',
    data: '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Agent 产出文档</w:t></w:r></w:p></w:body></w:document>',
  }])
  fs.writeFileSync(path.join(FX.reports, 'v1', 'doc.docx'), docx)
  fs.writeFileSync(path.join(FX.reports, 'v1', 'bad.docx'), 'not a zip')
  const ctx = makeCtx()
  mod.apply(ctx, {})
  const file = ctx.routes.get(API_NEW + '/file')
  const r = await dispatch(file, '/x?path=' + encodeURIComponent('v1/doc.docx'))
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.equal(body.type, 'office')
  assert.equal(body.kind, 'docx')
  assert.ok(body.text.includes('Agent 产出文档'))
  const bad = await dispatch(file, '/x?path=' + encodeURIComponent('v1/bad.docx'))
  assert.equal(bad.status, 500)
  assert.ok(!bad.body.includes(FX.reports))
})

test('路由：非白名单 415', async () => {
  fs.writeFileSync(path.join(FX.reports, 'v1', 'x.bin'), 'bin')
  const ctx = makeCtx()
  mod.apply(ctx, {})
  const file = ctx.routes.get(API_NEW + '/file')
  const r = await dispatch(file, '/x?path=' + encodeURIComponent('v1/x.bin'))
  assert.equal(r.status, 415)
})
