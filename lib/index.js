/**
 * @dsh-external/dsh-agent-outputs-reader — host half（纯 JS，零依赖）。
 *
 * 定位：阅读 agent 产出的任何文件（文本类 + PDF + DOCX/XLSX/PPTX 文本预览）。
 *
 * 接口（均带同源校验；新路径 + 旧 dsh-report-card 路径别名兼容历史 chips）：
 *   GET .../api/info    -> { ok, root, roots, exps, limits, suggest }
 *   GET .../api/tree?path=<rel> -> { root, path, entries }
 *   GET .../api/file?path=<rel> -> 文本:JSON | office:{type,kind,text} | pdf:{type,rawUrl} | 浏览器直开:HTML
 *   GET .../api/raw?path=<rel>  -> PDF 原始字节（application/pdf）
 *   GET .../api/beacon?msg=..   -> 诊断日志
 *
 * 安全：realpath 防 junction 穿透；Host/Origin 白名单；白名单扩展名；≤10MB。
 */
import {
  readdirSync, readFileSync, statSync, lstatSync,
  appendFileSync, renameSync, realpathSync,
} from 'node:fs'
import { join, resolve, normalize, sep } from 'node:path'
import { homedir } from 'node:os'
import { inflateRawSync } from 'node:zlib'

export const name = '@dsh-external/dsh-agent-outputs-reader'
export const inject = ['webServer']

const API = '/@dsh-external/dsh-agent-outputs-reader/api'
const LEGACY_API = '/@dsh-external/dsh-report-card/api'
const MAX_FILE_BYTES = 10 * 1024 * 1024
const BEACON_MSG_MAX = 512
const BEACON_LOG_MAX = 1024 * 1024
const TRUSTED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])
const DEFAULT_ROOT = 'C:/Projects/Quant/reports'
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.log',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh', '.bash', '.bat', '.ps1',
  '.py', '.js', '.ts', '.tsx', '.jsx', '.html', '.css', '.xml', '.rst', '.sql',
  '.ipynb',
])
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx'])
const PDF_EXT = '.pdf'

export function extOf(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i).toLowerCase() : ''
}

function isFile(p) {
  try { return statSync(p).isFile() } catch { return false }
}

function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

function realOf(p) {
  try { return realpathSync(p) } catch { return null }
}

/** 路径解析（可单测）：三根 + realpath 防穿透；wsRoot 仅 .md/.markdown。 */
export function resolveReaderPath(root, sentRoot, wsRoot, raw) {
  const src = String(raw || '').trim()
  const bases = [root, sentRoot, wsRoot]
  const resolvedBases = bases.map((b) => realOf(b) || normalize(resolve(b)))
  let abs = null
  let rel = ''
  const absLike = /^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('/')
  if (!absLike) {
    rel = src.replace(/\\/g, '/').replace(/^\/+/, '')
    let base = root
    let rest = rel
    if (rel === 'sent-files' || rel.startsWith('sent-files/')) {
      base = sentRoot
      rest = rel.slice('sent-files'.length).replace(/^\/+/, '')
    }
    abs = normalize(join(base, rest))
  } else {
    abs = normalize(src)
    rel = abs
  }
  const realAbs = realOf(abs)
  if (realAbs === null) return null
  const realReports = resolvedBases[0]
  const realSent = resolvedBases[1]
  const realWs = resolvedBases[2]
  const inReports = realAbs === realReports || realAbs.startsWith(realReports + sep)
  const inSent = realAbs === realSent || realAbs.startsWith(realSent + sep)
  const inWs = realAbs === realWs || realAbs.startsWith(realWs + sep)
  if (!inReports && !inSent && !inWs) return null
  if (inWs && !inSent && !inReports && !/\.(md|markdown)$/i.test(rel)) return null
  for (let k = 0; k < bases.length; k++) {
    const realBase = resolvedBases[k]
    if (realAbs === realBase || realAbs.startsWith(realBase + sep)) {
      const relAbs = realAbs.slice(realBase.length).replace(/^[\\/]+/, '')
      if (k === 1) rel = 'sent-files/' + relAbs
      else if (k === 2) rel = relAbs
      else if (!absLike) { /* 保持传入相对形式 */ } else rel = relAbs
      return { rel, abs: realAbs }
    }
  }
  return null
}

/** 建议默认打开的报告（实验目录优先，可单测）。 */
export function suggestReport(root) {
  if (!isDir(root)) return null
  let dirs
  try { dirs = readdirSync(root) } catch { return null }
  const tierOf = (dir, file) => (/^v\d/i.test(dir) || /v\d+(\.\d+)?[_-]/i.test(file)) ? 0 : 1
  const verOf = (file) => {
    const m = /v(\d+)(?:\.(\d+))?/i.exec(file)
    return m ? [Number(m[1]), Number(m[2] || 0)] : [-1, -1]
  }
  const better = (a, b) => (
    a.tier < b.tier
    || (a.tier === b.tier && (a.ver[0] > b.ver[0] || (a.ver[0] === b.ver[0] && (a.ver[1] > b.ver[1] || (a.ver[1] === b.ver[1] && a.mtimeMs > b.mtimeMs)))))
  )
  let best = null
  for (const d of dirs) {
    const full = join(root, d)
    if (!isDir(full)) continue
    let files
    try { files = readdirSync(full) } catch { continue }
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.md')) continue
      const p = join(full, f)
      if (!isFile(p)) continue
      try {
        const st = statSync(p)
        const cand = {
          tier: tierOf(d, f), ver: verOf(f), path: d + '/' + f, name: f, dir: d,
          size: st.size, mtime: new Date(st.mtimeMs).toISOString(), mtimeMs: st.mtimeMs,
        }
        if (!best || better(cand, best)) best = cand
      } catch { /* 忽略不可读条目 */ }
    }
  }
  return best
}

/* ================= Office 文本提取（纯 JS zip 解析） ================= */

const XML_ENTS = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")

/** 手工解析 zip：中央目录 + 本地头；仅支持 stored(0) 与 deflate(8)。可单测导出。 */
export function zipEntries(buf) {
  const u8 = new Uint8Array(buf)
  if (u8.length < 22) throw new Error('无效的 zip 文件')
  let eocd = -1
  const min = Math.max(0, u8.length - 65557)
  for (let i = u8.length - 22; i >= min; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('无效的 zip 文件')
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const total = dv.getUint16(eocd + 10, true)
  const cdOffset = dv.getUint32(eocd + 16, true)
  const entries = []
  let off = cdOffset
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break
    const method = dv.getUint16(off + 10, true)
    const compSize = dv.getUint32(off + 20, true)
    const nameLen = dv.getUint16(off + 28, true)
    const extraLen = dv.getUint16(off + 30, true)
    const commentLen = dv.getUint16(off + 32, true)
    const localOff = dv.getUint32(off + 42, true)
    const name = Buffer.from(u8.slice(off + 46, off + 46 + nameLen)).toString('utf8')
    const lNameLen = dv.getUint16(localOff + 26, true)
    const lExtraLen = dv.getUint16(localOff + 28, true)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = Buffer.from(u8.slice(dataStart, dataStart + compSize))
    entries.push({ name, method, raw })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export function unzipEntry(entry) {
  if (entry.method === 0) return entry.raw
  if (entry.method === 8) return inflateRawSync(entry.raw)
  throw new Error('不支持的压缩方式：' + entry.method)
}

export function docxToText(buf) {
  const doc = zipEntries(buf).find((e) => e.name === 'word/document.xml')
  if (!doc) throw new Error('无效的 docx 文件')
  const xml = unzipEntry(doc).toString('utf8')
  const paras = xml.split(/<w:p[\s>]/).slice(1)
  return paras.map((p) => {
    const texts = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => XML_ENTS(m[1]))
    return texts.join('')
  }).filter((l) => l.trim()).join('\n')
}

export function xlsxToText(buf) {
  const entries = zipEntries(buf)
  const shared = entries.find((e) => e.name === 'xl/sharedStrings.xml')
  const sharedArr = []
  if (shared) {
    const xml = unzipEntry(shared).toString('utf8')
    for (const block of xml.split(/<si[\s>]/).slice(1)) {
      const texts = [...block.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => XML_ENTS(m[1]))
      sharedArr.push(texts.join(''))
    }
  }
  const sheet = entries.find((e) => /^xl\/worksheets\/sheet1\.xml$/.test(e.name))
    || entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
  if (!sheet) throw new Error('无效的 xlsx 文件')
  const xml = unzipEntry(sheet).toString('utf8')
  const rows = xml.split(/<row[\s>]/).slice(1)
  const lines = rows.map((r) => {
    const cells = [...r.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)].map((m) => {
      const open = m[0].slice(0, m[0].indexOf('>') + 1)
      const t = /t="([^"]+)"/.exec(open)
      const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(m[1])
      let val = v ? XML_ENTS(v[1]) : ''
      if (t && t[1] === 's' && /^\d+$/.test(val)) val = sharedArr[Number(val)] || ''
      return val
    })
    return cells.join('\t')
  }).filter((l) => l.trim())
  return lines.join('\n')
}

export function pptxToText(buf) {
  const entries = zipEntries(buf)
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => {
      const na = Number(/slide(\d+)/.exec(a.name)[1])
      const nb = Number(/slide(\d+)/.exec(b.name)[1])
      return na - nb
    })
  if (!slides.length) throw new Error('无效的 pptx 文件')
  return slides.map((s, i) => {
    const xml = unzipEntry(s).toString('utf8')
    const texts = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => XML_ENTS(m[1]))
    return '— 第 ' + (i + 1) + ' 页 —\n' + texts.join(' ')
  }).join('\n\n')
}

/* ================= 工具与安全 ================= */

function sendJson(res, data, status = 200) {
  const text = JSON.stringify(data)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(text))
  res.end(text)
}

function sendError(res, message, status = 400) {
  sendJson(res, { error: message }, status)
}

function isTrustedRequest(req) {
  try {
    const hostHeader = String(req.headers.host || '')
    const hostname = hostHeader.split(':')[0]
    if (!TRUSTED_HOSTNAMES.has(hostname)) return false
    const origin = String(req.headers.origin || '')
    if (origin) {
      const u = new URL(origin)
      if (!TRUSTED_HOSTNAMES.has(u.hostname)) return false
    }
    return true
  } catch {
    return false
  }
}

export function apply(ctx, config) {
  const conf = config || {}
  const root = resolve(String(conf.root || process.env.DSH_REPORTS_ROOT || DEFAULT_ROOT))
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const sentRoot = join(dshHome, 'sent-files')
  const wsRoot = dshHome
  const beaconFile = join(dshHome, 'dsh-agent-outputs-reader-beacon.log')

  const writeBeacon = (msg) => {
    const clean = String(msg || '').replace(/[\r\n\t]+/g, ' ').slice(0, BEACON_MSG_MAX)
    try {
      const st = statSync(beaconFile)
      if (st && st.size > BEACON_LOG_MAX) {
        try { renameSync(beaconFile, beaconFile + '.old') } catch { /* 忽略 */ }
      }
    } catch { /* 文件不存在 */ }
    try {
      appendFileSync(beaconFile, new Date().toISOString() + ' ' + clean + '\n')
    } catch { /* 写盘失败不影响 */ }
  }

  const listDir = (realDir, rel) => {
    const names = readdirSync(realDir)
    const entries = names.map((name) => {
      const full = join(realDir, name)
      let type = 'file'
      let size = null
      let mtime = null
      try {
        if (lstatSync(full).isSymbolicLink()) {
          return { name, type: 'link', size: null, mtime: null }
        }
        const st = statSync(full)
        if (st.isDirectory()) type = 'dir'
        else size = st.size
        mtime = new Date(st.mtimeMs).toISOString()
      } catch { /* 单个条目失败不拖垮列表 */ }
      return { name, type, size, mtime }
    }).sort((a, b) => (
      a.type === b.type
        ? a.name.localeCompare(b.name, 'zh-Hans-CN')
        : (a.type === 'dir' ? -1 : 1)
    ))
    return { root, path: rel, entries }
  }

  const handlers = {
    '/info': (req, res, q) => {
      const ok = isDir(root)
      sendJson(res, {
        ok,
        root,
        roots: { reports: root, sent: sentRoot, ws: wsRoot },
        exps: Array.from(TEXT_EXT).concat(Array.from(OFFICE_EXT)).concat([PDF_EXT]),
        limits: { maxFileBytes: MAX_FILE_BYTES },
        suggest: ok ? suggestReport(root) : null,
      })
    },
    '/tree': (req, res, q) => {
      const loc = resolveReaderPath(root, sentRoot, wsRoot, q.get('path') || '')
      if (!loc || !isDir(loc.abs)) {
        return sendError(res, '目录不存在：' + (loc ? loc.rel : '未知路径'), 404)
      }
      try {
        sendJson(res, listDir(loc.abs, loc.rel))
      } catch (e) {
        writeBeacon('tree-error ' + String((e && e.message) || e))
        sendError(res, '目录读取失败', 500)
      }
    },
    '/file': (req, res, q) => {
      const loc = resolveReaderPath(root, sentRoot, wsRoot, q.get('path') || '')
      if (!loc) return sendError(res, '非法路径', 400)
      if (!isFile(loc.abs)) return sendError(res, '文件不存在：' + loc.rel, 404)
      const ext = extOf(loc.rel)
      const readable = TEXT_EXT.has(ext) || OFFICE_EXT.has(ext) || ext === PDF_EXT
      if (!readable) return sendError(res, '不支持的文件类型：' + (ext || '(无扩展名)'), 415)
      let st
      try { st = statSync(loc.abs) } catch { return sendError(res, '无法读取文件：' + loc.rel, 500) }
      if (st.size > MAX_FILE_BYTES) {
        return sendError(res, '文件过大（>10MB），请在本地打开：' + loc.rel, 413)
      }
      try {
        const name = loc.rel.split('/').pop()
        const mtime = new Date(st.mtimeMs).toISOString()
        // PDF：返回 rawUrl，由客户端 iframe 渲染
        if (ext === PDF_EXT) {
          const rawUrl = API + '/raw?path=' + encodeURIComponent(loc.rel)
          if (String(req.headers.accept || '').includes('text/html')) {
            const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
              + '<title>' + escHtml(name) + '</title>'
              + '<style>body{margin:0;background:#0f1115}iframe{width:100vw;height:100vh;border:0}</style>'
              + '</head><body><iframe src="' + rawUrl + '"></iframe></body></html>'
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.setHeader('X-Content-Type-Options', 'nosniff')
            res.setHeader('X-Frame-Options', 'DENY')
            res.setHeader('Content-Length', Buffer.byteLength(html))
            res.end(html)
            return
          }
          return sendJson(res, { type: 'pdf', path: loc.rel, name, size: st.size, mtime, rawUrl })
        }
        // Office：文本预览
        if (OFFICE_EXT.has(ext)) {
          const buf = readFileSync(loc.abs)
          const kind = ext === '.docx' ? 'docx' : ext === '.xlsx' ? 'xlsx' : 'pptx'
          let text = ''
          try {
            if (kind === 'docx') text = docxToText(buf)
            else if (kind === 'xlsx') text = xlsxToText(buf)
            else text = pptxToText(buf)
          } catch (e) {
            writeBeacon('office-error ' + loc.rel + ' ' + String((e && e.message) || e))
            return sendError(res, '无法解析该文件：' + (ext || ''), 500)
          }
          if (String(req.headers.accept || '').includes('text/html')) {
            const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
              + '<title>' + escHtml(name) + '</title>'
              + '<style>body{margin:0;font-family:ui-monospace,Consolas,monospace;background:#0f1115;color:#d6dae2}'
              + 'header{padding:10px 16px;border-bottom:1px solid #262b36;font-size:13px;color:#8b93a3}'
              + 'pre{margin:0;padding:16px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}'
              + '</style></head><body><header>' + escHtml(loc.rel) + ' · ' + st.size + ' B · 文本预览</header><pre>'
              + escHtml(text) + '</pre></body></html>'
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.setHeader('X-Content-Type-Options', 'nosniff')
            res.setHeader('X-Frame-Options', 'DENY')
            res.setHeader('Content-Length', Buffer.byteLength(html))
            res.end(html)
            return
          }
          return sendJson(res, { type: 'office', kind, path: loc.rel, name, size: st.size, mtime, text })
        }
        // 文本类
        const content = readFileSync(loc.abs, 'utf8')
        if (String(req.headers.accept || '').includes('text/html')) {
          const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
            + '<title>' + escHtml(name) + '</title>'
            + '<style>body{margin:0;font-family:ui-monospace,Consolas,monospace;background:#0f1115;color:#d6dae2}'
            + 'header{padding:10px 16px;border-bottom:1px solid #262b36;font-size:13px;color:#8b93a3;position:sticky;top:0;background:#0f1115}'
            + 'pre{margin:0;padding:16px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}'
            + '</style></head><body><header>' + escHtml(loc.rel) + ' · ' + st.size + ' B</header><pre>'
            + escHtml(content) + '</pre></body></html>'
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('X-Content-Type-Options', 'nosniff')
          res.setHeader('X-Frame-Options', 'DENY')
          res.setHeader('Content-Length', Buffer.byteLength(html))
          res.end(html)
          return
        }
        sendJson(res, { type: 'text', path: loc.rel, name, size: st.size, mtime, content })
      } catch (e) {
        writeBeacon('file-error ' + String((e && e.message) || e))
        sendError(res, '文件读取失败', 500)
      }
    },
    '/raw': (req, res, q) => {
      const loc = resolveReaderPath(root, sentRoot, wsRoot, q.get('path') || '')
      if (!loc || !isFile(loc.abs)) return sendError(res, '非法路径', 400)
      const ext = extOf(loc.rel)
      if (ext !== PDF_EXT) return sendError(res, '仅支持 PDF 原始读取', 415)
      try {
        const st = statSync(loc.abs)
        if (st.size > MAX_FILE_BYTES) return sendError(res, '文件过大（>10MB）', 413)
        const body = readFileSync(loc.abs)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Content-Length', body.length)
        res.end(body)
      } catch (e) {
        writeBeacon('raw-error ' + String((e && e.message) || e))
        sendError(res, '文件读取失败', 500)
      }
    },
    '/beacon': (req, res, q) => {
      if (req.method !== 'GET') return sendError(res, '不支持的请求方法', 405)
      writeBeacon(q.get('msg') || '')
      sendJson(res, { ok: true })
    },
  }

  // 新旧两个前缀均注册（旧前缀兼容历史 chips）
  for (const prefix of [API, LEGACY_API]) {
    for (const [suffix, handler] of Object.entries(handlers)) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: prefix + suffix,
        handler: (req, res) => {
          if (!isTrustedRequest(req)) {
            return sendError(res, '拒绝访问：来源不受信任', 403)
          }
          const q = new URL(req.url || '/', 'http://localhost').searchParams
          Promise.resolve().then(() => handler(req, res, q)).catch((e) => {
            writeBeacon('route-error ' + suffix + ' ' + String((e && e.message) || e))
            sendError(res, '服务器内部错误', 500)
          })
        },
      }), '@dsh-external/dsh-agent-outputs-reader: route ' + prefix + suffix)
    }
  }
}
