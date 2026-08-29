/**
 * @dsh-external/dsh-agent-outputs-reader — client half（阅读器 + 文件 chips）。
 *
 * 定位：阅读 agent 产出的任何文件。无任何常驻 UI。
 *   - 文本类（md/json/csv/yml/…）：GFM 子集渲染 + 大纲 + 全文搜索
 *   - PDF：面板内 iframe 渲染（宿主 /raw 出字节）
 *   - DOCX/XLSX/PPTX：面板内文本预览（宿主纯 JS 提取）
 *   - chips 链接与产物文件卡片点击拦截；ctx.workspaces.openPath 包装（卸载身份校验）
 *
 * 兼容旧插件路径 /@dsh-external/dsh-report-card/api/*（历史消息里的 chips 不失效）。
 * 无条件 window.__ModuleLoader__.load 注册（勿加守卫——守卫会导致整个 web 插件树启动失败）。
 */
const inject = ['workspaces', 'slots']

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-agent-outputs-reader',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const API = '/@dsh-external/dsh-agent-outputs-reader/api'
    const LEGACY_API = '/@dsh-external/dsh-report-card/api'
    const getJSON = (url) => fetch(url, { cache: 'no-store' }).then((res) => res.json())
    const apiTree = (path) => getJSON(API + '/tree?path=' + encodeURIComponent(path || ''))
    const apiFile = (path) => getJSON(API + '/file?path=' + encodeURIComponent(path || ''))
    const apiInfo = () => getJSON(API + '/info')

    /* ================= 常量集中 ================= */

    const LS = {
      size: 'dsh-aor:size', sizeOld: 'dsh-report-card:size',
      fs: 'dsh-aor:fs2', fsOld: 'dsh-report-card:fs2',
      lastFile: 'dsh-aor:lastFile', lastFileOld: 'dsh-report-card:lastFile',
      pos: (p) => 'dsh-aor:pos:' + p, posOld: (p) => 'dsh-report-card:pos:' + p,
    }
    const lsGet = (key, oldKey) => {
      try {
        const v = localStorage.getItem(key)
        if (v !== null && v !== undefined) return v
      } catch { /* ignore */ }
      try { return localStorage.getItem(oldKey) } catch { return null }
    }
    const CLAMP = {
      fsMin: 11, fsMax: 21, fsDefault: 14,
      wMin: 420, wMax: 1600, hMin: 320, hMax: 1000,
      dockWMin: 380, dockWMax: 1100,
    }
    const DEFAULT_SIZE = () => ({
      w: Math.min(1100, window.innerWidth - 80),
      h: Math.min(820, window.innerHeight - 100),
      dockW: 560,
    })

    /* ================= 迷你 markdown 渲染（GFM 子集） ================= */

    const esc = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    function inlineMd(s) {
      const segments = s.split(/(`[^`\n]*`)/g)
      return segments.map((seg, idx) => {
        if (idx % 2 === 1) return '<code>' + seg.slice(1, -1) + '</code>'
        let out = seg
        out = out.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, alt, u) => {
          const name = (alt || u).split('/').pop()
          return '<span class="rc-img">🖼 ' + esc(name) + '</span>'
        })
        out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
        out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
        out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
          const href = u.replace(/&amp;/g, '&')
          if (href.startsWith('//')) return t
          if (href.startsWith('#')) return '<span class="rc-anchor">' + t + '</span>'
          if (/^(https?:|mailto:|\/|\.{0,2}\/)/i.test(href)) {
            return '<a href="' + esc(href) + '" target="_blank" rel="noreferrer">' + t + '</a>'
          }
          return t
        })
        return out
      }).join('')
    }

    const isTableSep = (l) => {
      const t = l.trim()
      return t.includes('-') && /^[\s|:-]+$/.test(t)
    }

    const cellsOf = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

    function renderTable(rows) {
      const head = cellsOf(rows[0])
      const aligns = cellsOf(rows[1] || '').map((c) => (
        c.startsWith(':') && c.endsWith(':') ? 'center'
          : c.endsWith(':') ? 'right'
            : c.startsWith(':') ? 'left' : ''
      ))
      const body = rows.slice(2).filter((r) => !isTableSep(r))
      let out = '<table class="rc-tbl"><thead><tr>'
      for (let k = 0; k < head.length; k++) {
        out += '<th' + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inlineMd(esc(head[k])) + '</th>'
      }
      out += '</tr></thead><tbody>'
      for (const row of body) {
        const cs = cellsOf(row)
        out += '<tr>'
        for (let k = 0; k < cs.length; k++) {
          out += '<td' + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inlineMd(esc(cs[k])) + '</td>'
        }
        out += '</tr>'
      }
      return out + '</tbody></table>'
    }

    /** 单遍解析：html 与 toc 同源（围栏内标题不会错位）。 */
    function parseDocument(md) {
      const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n')
      const out = []
      const toc = []
      let i = 0
      let hid = 0
      const blockStart = (l) => /^(#{1,6}\s|```|>\s?|[-*+]\s+|\d+[.)]\s+)/.test(l) || /^\s*([-*_])\1{2,}\s*$/.test(l)
      while (i < lines.length) {
        const line = lines[i]
        if (/^```/.test(line)) {
          const buf = []
          i++
          while (i < lines.length && !/^```/.test(lines[i])) {
            buf.push(lines[i])
            i++
          }
          if (i < lines.length) i++
          out.push('<pre class="rc-code"><code>' + esc(buf.join('\n')) + '</code></pre>')
          continue
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(line)
        if (h) {
          const n = h[1].length
          out.push('<h' + n + ' id="rc-h' + hid + '">' + inlineMd(esc(h[2].trim())) + '</h' + n + '>')
          toc.push({ level: n, text: h[2].replace(/[*_`~[\]()#]/g, '').trim() || '(无标题)', id: 'rc-h' + hid })
          hid++
          i++
          continue
        }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
          out.push('<hr>')
          i++
          continue
        }
        if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          const rows = [line]
          i++
          while (i < lines.length && (lines[i].includes('|') || isTableSep(lines[i]))) {
            rows.push(lines[i])
            i++
          }
          out.push(renderTable(rows))
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            buf.push(lines[i].replace(/^\s*>\s?/, ''))
            i++
          }
          out.push('<blockquote>' + buf.map((l) => inlineMd(esc(l))).join('<br>') + '</blockquote>')
          continue
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            buf.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
            i++
          }
          out.push('<ul>' + buf.map((l) => '<li>' + inlineMd(esc(l)) + '</li>').join('') + '</ul>')
          continue
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            buf.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
            i++
          }
          out.push('<ol>' + buf.map((l) => '<li>' + inlineMd(esc(l)) + '</li>').join('') + '</ol>')
          continue
        }
        if (!line.trim()) {
          i++
          continue
        }
        const buf = []
        while (
          i < lines.length
          && lines[i].trim()
          && !blockStart(lines[i])
          && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
        ) {
          buf.push(lines[i])
          i++
        }
        out.push('<p>' + buf.map((l) => inlineMd(esc(l))).join('<br>') + '</p>')
      }
      return { html: out.join('\n'), toc }
    }

    /* ================= 小工具 ================= */

    const fmtSize = (n) => {
      if (n == null) return ''
      if (n < 1024) return n + ' B'
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1048576).toFixed(2) + ' MB'
    }

    const fmtTime = (iso) => {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      const p = (x) => String(x).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }

    const beacon = (msg) => {
      try {
        fetch(API + '/beacon?msg=' + encodeURIComponent(String(msg).slice(0, 400)), { keepalive: true }).catch(() => {})
      } catch {
        // 探针失败不影响功能。
      }
    }

    /* ================= 路由判定（以 /info 能力表为准） ================= */

    let readerRoots = null

    const normPath = (p) => String(p || '').replace(/\\/g, '/')

    const READER_EXTS = /\.(md|markdown|txt|json|csv|tsv|log|yml|yaml|pdf|docx|xlsx|pptx)$/i

    function isReaderPath(p) {
      const s = normPath(p)
      if (!READER_EXTS.test(s)) return false
      if (readerRoots) {
        for (const r of readerRoots) {
          const rs = normPath(r)
          if (s === rs || s.startsWith(rs + '/')) return true
        }
        return false
      }
      return /(^|\/)reports\//i.test(s) || /(^|\/)sent-files(\/|$)/i.test(s) || /(^|\/)\.dsh\//i.test(s)
    }

    const refreshRoots = (info) => {
      try {
        if (info && info.roots) {
          readerRoots = [info.roots.reports, info.roots.sent, info.roots.ws].filter(Boolean)
        }
      } catch { /* 保留回退判定 */ }
    }

    /* ================= 目录树 ================= */

    function TreeItem(props) {
      const { entry, dirPath, depth, selPath, onSelectFile, onToggleDir, expandedDirs, childrenMap, failedDirs, loadDir } = props
      const pad = { paddingLeft: 8 + depth * 14 + 'px' }
      if (entry.type === 'link') {
        return React.createElement('div', { className: 'rc-tree-row rc-tree-link', style: pad, title: '链接（不可展开）' },
          React.createElement('span', { className: 'rc-tree-caret' }, ' '),
          React.createElement('span', null, '🔗'),
          React.createElement('span', { className: 'rc-tree-name' }, entry.name))
      }
      if (entry.type === 'dir') {
        const expanded = !!expandedDirs[dirPath]
        const failed = !!failedDirs[dirPath]
        return React.createElement(React.Fragment, null,
          React.createElement('button', {
            type: 'button',
            className: 'rc-tree-row',
            style: pad,
            title: dirPath,
            onClick: () => {
              if (!expanded && !childrenMap[dirPath]) loadDir(dirPath)
              onToggleDir(dirPath)
            },
          },
            React.createElement('span', { className: 'rc-tree-caret' }, expanded ? '▾' : '▸'),
            React.createElement('span', null, '📁'),
            React.createElement('span', { className: 'rc-tree-name' }, entry.name)),
          expanded && failed
            ? React.createElement('button', {
                type: 'button',
                className: 'rc-tree-row rc-tree-retry',
                style: { paddingLeft: 8 + (depth + 1) * 14 + 'px' },
                onClick: () => loadDir(dirPath),
              }, '⚠ 加载失败，点击重试')
            : null,
          expanded
            ? (childrenMap[dirPath] || []).map((c) => React.createElement(TreeItem, {
                key: dirPath + '/' + c.name,
                entry: c,
                dirPath: dirPath + '/' + c.name,
                depth: depth + 1,
                selPath, onSelectFile, onToggleDir, expandedDirs, childrenMap, failedDirs, loadDir,
              }))
            : null)
      }
      const icon = /\.(docx|xlsx|pptx)$/i.test(entry.name) ? '📝' : /\.pdf$/i.test(entry.name) ? '📕' : '📄'
      return React.createElement('button', {
        type: 'button',
        className: 'rc-tree-row' + (selPath === dirPath ? ' rc-sel' : ''),
        style: pad,
        title: dirPath,
        onClick: () => onSelectFile(dirPath, entry.name),
      },
        React.createElement('span', { className: 'rc-tree-caret' }, ' '),
        React.createElement('span', null, icon),
        React.createElement('span', { className: 'rc-tree-name' }, entry.name),
        React.createElement('span', { className: 'rc-tree-size' }, fmtSize(entry.size)))
    }

    /* ================= 阅读器面板 ================= */

    function ReportPanel({ onClose, initialPath }) {
      const [info, setInfo] = React.useState(null)
      const [children, setChildren] = React.useState({})
      const [failedDirs, setFailedDirs] = React.useState({})
      const [expanded, setExpanded] = React.useState({ '': true })
      const [sel, setSel] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [showTree, setShowTree] = React.useState(false)
      const [zen, setZen] = React.useState(false)
      const [mode, setMode] = React.useState('popup')
      const [size, setSize] = React.useState(() => {
        try {
          const s = JSON.parse(lsGet(LS.size, LS.sizeOld) || 'null')
          if (s && s.w > 300 && s.h > 200 && s.dockW > 300) return s
        } catch { /* ignore */ }
        return DEFAULT_SIZE()
      })
      const sizeRef = React.useRef(size)
      const [fs, setFs] = React.useState(() => {
        try {
          const v = Number(lsGet(LS.fs, LS.fsOld))
          return Number.isFinite(v) && v >= CLAMP.fsMin && v <= CLAMP.fsMax ? v : CLAMP.fsDefault
        } catch { return CLAMP.fsDefault }
      })
      const [progress, setProgress] = React.useState(0)
      const [activeId, setActiveId] = React.useState('')
      const [findOpen, setFindOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [hitCount, setHitCount] = React.useState(0)
      const [hitIndex, setHitIndex] = React.useState(0)
      const [showTop, setShowTop] = React.useState(false)
      const mdRef = React.useRef(null)
      const findRef = React.useRef(null)
      const posTimer = React.useRef(null)
      const rafRef = React.useRef(null)
      const fileSeq = React.useRef(0)
      const keyHandlerRef = React.useRef(null)

      const parsed = React.useMemo(() => (
        sel && !sel.loading && !sel.error && sel.type === 'text'
          ? parseDocument(sel.content || '')
          : null
      ), [sel])
      const mdHtml = parsed ? parsed.html : ''
      const toc = parsed ? parsed.toc : []
      const isText = sel && sel.type === 'text'
      const isOffice = sel && sel.type === 'office'
      const isPdf = sel && sel.type === 'pdf'

      /* ---------- 文件/目录操作 ---------- */

      const loadDir = useCallback((dirPath) => {
        apiTree(dirPath).then((t) => {
          setChildren((prev) => ({ ...prev, [dirPath]: t.entries || [] }))
          setFailedDirs((prev) => ({ ...prev, [dirPath]: false }))
        }).catch(() => {
          setChildren((prev) => ({ ...prev, [dirPath]: [] }))
          setFailedDirs((prev) => ({ ...prev, [dirPath]: true }))
        })
      }, [])

      const openFile = useCallback((path, name) => {
        const id = ++fileSeq.current
        setSel({ path, name, loading: true })
        setQuery('')
        setFindOpen(false)
        setProgress(0)
        apiFile(path).then((f) => {
          if (id !== fileSeq.current) return
          setSel({
            path, name, loading: false,
            type: f.type || 'text',
            kind: f.kind,
            content: f.content,
            text: f.text,
            rawUrl: f.rawUrl,
            size: f.size,
            mtime: f.mtime,
            error: f.error || null,
          })
          try {
            localStorage.setItem(LS.lastFile, path)
          } catch {
            // 忽略持久化失败。
          }
        }).catch((e) => {
          if (id !== fileSeq.current) return
          setSel({ path, name, loading: false, error: (e && e.message) || String(e) })
        })
      }, [])

      const boot = useCallback(() => {
        apiInfo().then((i) => {
          setInfo(i)
          refreshRoots(i)
          setErr(null)
          loadDir('')
          if (initialPath) {
            openFile(initialPath, initialPath.split('/').pop())
            return
          }
          let last = null
          try { last = lsGet(LS.lastFile, LS.lastFileOld) } catch { /* ignore */ }
          if (last && i && i.root) openFile(last, last.split('/').pop())
          else if (i && i.suggest && i.suggest.path) openFile(i.suggest.path, i.suggest.name)
        }).catch((e) => setErr((e && e.message) || String(e)))
      }, [loadDir, openFile, initialPath])

      React.useEffect(() => {
        boot()
        return () => {
          if (posTimer.current) clearTimeout(posTimer.current)
        }
      }, [boot])

      const toggleDir = (dirPath) => {
        setExpanded((prev) => ({ ...prev, [dirPath]: !prev[dirPath] }))
      }

      const navigateFile = (delta) => {
        if (!sel || !sel.path) return
        const parts = sel.path.split('/')
        const name = parts.pop()
        const parent = parts.join('/')
        const entries = children[parent]
        const step = (list) => {
          if (!list) return
          const i = list.findIndex((e) => e.name === name)
          let j = i
          for (;;) {
            j += delta
            if (j < 0 || j >= list.length) return
            if (list[j].type === 'file') break
          }
          const target = parent ? parent + '/' + list[j].name : list[j].name
          openFile(target, list[j].name)
        }
        if (entries) step(entries)
        else apiTree(parent).then((t) => {
          setChildren((prev) => ({ ...prev, [parent]: t.entries || [] }))
          step(t.entries)
        }).catch(() => {})
      }

      /* ---------- 滚动 ---------- */

      const onScroll = useCallback(() => {
        if (rafRef.current) return
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null
          const el = mdRef.current
          if (!el) return
          const max = el.scrollHeight - el.clientHeight
          const p = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0
          setProgress(p)
          setShowTop(el.scrollTop > 500)
          let cur = ''
          el.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]').forEach((h) => {
            if (h.getBoundingClientRect().top <= 160) cur = h.id
          })
          setActiveId(cur)
          if (posTimer.current) clearTimeout(posTimer.current)
          posTimer.current = setTimeout(() => {
            if (sel && sel.path && sel.type !== 'pdf') {
              try { localStorage.setItem(LS.pos(sel.path), String(el.scrollTop)) } catch { /* ignore */ }
            }
          }, 400)
        })
      }, [sel])

      React.useEffect(() => {
        const el = mdRef.current
        if (!el || !sel || sel.loading || sel.error || sel.type === 'pdf') return
        let saved = null
        try {
          const v = Number(lsGet(LS.pos(sel.path), LS.posOld(sel.path)))
          if (Number.isFinite(v) && v > 0) saved = v
        } catch { /* ignore */ }
        el.scrollTop = saved || 0
        onScroll()
      }, [sel, onScroll])

      /* ---------- 搜索高亮（仅文本类） ---------- */

      const clearHighlights = (root) => {
        root.querySelectorAll('mark.rc-hit').forEach((m) => {
          const p = m.parentNode
          if (p) {
            p.replaceChild(document.createTextNode(m.textContent || ''), m)
            p.normalize()
          }
        })
      }

      React.useEffect(() => {
        const root = mdRef.current
        if (!root) return
        clearHighlights(root)
        setHitCount(0)
        setHitIndex(0)
        const q = query.trim()
        if (!q || !isText) return
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
            const p = node.parentNode
            if (p && (p.tagName === 'MARK' || p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT
            return NodeFilter.FILTER_ACCEPT
          },
        })
        const nodes = []
        while (walker.nextNode()) nodes.push(walker.currentNode)
        let count = 0
        for (const node of nodes) {
          const text = node.nodeValue
          re.lastIndex = 0
          const frag = document.createDocumentFragment()
          let last = 0
          let m
          let matched = false
          while ((m = re.exec(text)) !== null) {
            frag.appendChild(document.createTextNode(text.slice(last, m.index)))
            const mark = document.createElement('mark')
            mark.className = 'rc-hit'
            mark.textContent = m[0]
            frag.appendChild(mark)
            count++
            matched = true
            last = m.index + m[0].length
            if (m.index === re.lastIndex) re.lastIndex++
          }
          if (matched) {
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
            node.parentNode.replaceChild(frag, node)
          }
        }
        setHitCount(count)
      }, [sel, query, isText])

      const jumpToHit = (dir) => {
        const root = mdRef.current
        if (!root) return
        const marks = root.querySelectorAll('mark.rc-hit')
        if (!marks.length) return
        const next = ((hitIndex + dir) % marks.length + marks.length) % marks.length
        setHitIndex(next)
        root.querySelectorAll('mark.rc-hit.rc-cur').forEach((m) => m.classList.remove('rc-cur'))
        marks[next].classList.add('rc-cur')
        marks[next].scrollIntoView({ block: 'center', behavior: 'smooth' })
      }

      /* ---------- 快捷键 ---------- */

      const onKeydown = useCallback((e) => {
        const t = e.target
        const inPanel = t && t.closest && !!t.closest('.rc-panel')
        const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
        if (editable && !inPanel) return
        if (e.key === 'Escape') {
          onClose()
          return
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault()
          setFindOpen(true)
          setTimeout(() => { if (findRef.current) findRef.current.focus() }, 0)
          return
        }
        if (e.key === 'F3') {
          e.preventDefault()
          jumpToHit(e.shiftKey ? -1 : 1)
        }
      }, [onClose, hitIndex])

      keyHandlerRef.current = onKeydown

      React.useEffect(() => {
        const h = (e) => keyHandlerRef.current(e)
        window.addEventListener('keydown', h)
        return () => window.removeEventListener('keydown', h)
      }, [])

      const setFsPersist = (v) => {
        setFs(v)
        try { localStorage.setItem(LS.fs, String(v)) } catch { /* ignore */ }
      }

      /* ---------- 渲染 ---------- */

      const rootEntries = children[''] || []
      const loading = sel && sel.loading
      const pct = Math.round(progress * 100)

      const hbtn = (title, label, onClick, className) => React.createElement('button', {
        type: 'button',
        className: 'rc-hbtn' + (className ? ' ' + className : ''),
        title,
        onClick,
      }, label)

      const tocPanel = React.createElement('div', { className: 'rc-toc' },
        React.createElement('div', { className: 'rc-toc-title' }, '大纲'),
        toc.length
          ? React.createElement('div', { className: 'rc-toc-list' },
              toc.map((t) => React.createElement('button', {
                key: t.id,
                type: 'button',
                className: 'rc-toc-row' + (activeId === t.id ? ' rc-toc-active' : ''),
                style: { paddingLeft: 6 + (t.level - 1) * 12 + 'px' },
                title: t.text,
                onClick: () => {
                  const h = mdRef.current && mdRef.current.querySelector('#' + t.id)
                  if (h) {
                    mdRef.current.scrollTo({ top: h.offsetTop - 8, behavior: 'smooth' })
                    setActiveId(t.id)
                  }
                },
              }, t.text)))
          : React.createElement('div', { className: 'rc-empty' },
              isPdf ? 'PDF 文档（无大纲）' : isOffice ? '文档预览（无大纲）' : '本文档没有标题'))

      const dirOfSel = (() => {
        if (!sel || !sel.path) return null
        const parts = sel.path.split('/')
        const name = parts.pop()
        return { parent: parts.join('/'), name, entries: children[parts.join('/')] || null }
      })()
      const fileIndex = dirOfSel && dirOfSel.entries
        ? dirOfSel.entries.findIndex((e) => e.name === dirOfSel.name)
        : -1
      const canPrev = dirOfSel && dirOfSel.entries && fileIndex > 0
        && dirOfSel.entries.slice(0, fileIndex).some((e) => e.type === 'file')
      const canNext = dirOfSel && dirOfSel.entries && fileIndex >= 0 && fileIndex < dirOfSel.entries.length - 1
        && dirOfSel.entries.slice(fileIndex + 1).some((e) => e.type === 'file')

      /* ---------- 拖拽 / 吸附 ---------- */

      const persistSize = (s) => {
        try { localStorage.setItem(LS.size, JSON.stringify(s)) } catch { /* ignore */ }
      }

      const startResize = (e) => {
        e.preventDefault()
        e.stopPropagation()
        const startX = e.clientX
        const startY = e.clientY
        const startW = sizeRef.current.w
        const startH = sizeRef.current.h
        const onMove = (ev) => {
          const w = Math.min(CLAMP.wMax, Math.max(CLAMP.wMin, startW + ev.clientX - startX))
          const h = Math.min(CLAMP.hMax, Math.max(CLAMP.hMin, startH + ev.clientY - startY))
          sizeRef.current = { ...sizeRef.current, w, h }
          setSize(sizeRef.current)
        }
        const onUp = () => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          persistSize(sizeRef.current)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }

      const startDockResize = (e) => {
        e.preventDefault()
        e.stopPropagation()
        const startX = e.clientX
        const startW = sizeRef.current.dockW
        const onMove = (ev) => {
          const w = Math.min(CLAMP.dockWMax, Math.max(CLAMP.dockWMin, startW - (ev.clientX - startX)))
          sizeRef.current = { ...sizeRef.current, dockW: w }
          setSize(sizeRef.current)
        }
        const onUp = () => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          persistSize(sizeRef.current)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }

      const body = isPdf
        ? React.createElement('iframe', {
            className: 'rc-pdf',
            src: sel.rawUrl,
            title: sel.name + '（PDF 预览）',
          })
        : isOffice
          ? React.createElement('pre', { className: 'rc-office' }, sel.text || '')
          : null

      return React.createElement('div', {
        className: 'rc-overlay' + (zen ? ' rc-zen' : '') + (mode === 'dock' ? ' rc-docked' : ''),
        onClick: (e) => {
          if (e.target === e.currentTarget) onClose()
        },
      },
        React.createElement('div', {
          className: 'rc-panel',
          style: mode === 'popup'
            ? { width: size.w + 'px', height: size.h + 'px' }
            : { width: size.dockW + 'px' },
        },
          React.createElement('div', { className: 'rc-progress' },
            React.createElement('div', { className: 'rc-progress-in', style: { width: pct + '%' } })),
          React.createElement('div', { className: 'rc-head' },
            React.createElement('span', null, '📄'),
            React.createElement('span', { className: 'rc-head-title' }, sel ? sel.name : '阅读器'),
            React.createElement('span', { className: 'rc-head-sub' }, sel ? sel.path : ''),
            hbtn('上一篇', '‹', () => navigateFile(-1), !canPrev ? 'rc-dis' : ''),
            hbtn('下一篇', '›', () => navigateFile(1), !canNext ? 'rc-dis' : ''),
            hbtn(showTree ? '收起目录' : '展开目录', '☰', () => setShowTree((v) => !v), showTree ? 'rc-on' : ''),
            hbtn('字号减小', 'A−', () => setFsPersist(Math.max(CLAMP.fsMin, fs - 0.75))),
            hbtn('字号增大', 'A+', () => setFsPersist(Math.min(CLAMP.fsMax, fs + 0.75))),
            hbtn('搜索 (Ctrl+F)', '⌕', () => {
              setFindOpen((v) => !v)
              setTimeout(() => { if (!findOpen && findRef.current) findRef.current.focus() }, 0)
            }, findOpen ? 'rc-on' : ''),
            hbtn('宽屏模式', '⛶', () => setZen((v) => !v), zen ? 'rc-on' : ''),
            hbtn(mode === 'popup' ? '吸附到右侧边' : '恢复弹窗阅读器', mode === 'popup' ? '⤇' : '⤆', () => setMode((m) => (m === 'popup' ? 'dock' : 'popup')), mode === 'dock' ? 'rc-on' : ''),
            hbtn('关闭 (Esc)', '✕', onClose)),
          findOpen && isText
            ? React.createElement('div', { className: 'rc-find' },
                React.createElement('input', {
                  ref: findRef,
                  className: 'rc-find-input',
                  placeholder: '在文档中查找…',
                  value: query,
                  onChange: (e) => setQuery(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      jumpToHit(e.shiftKey ? -1 : 1)
                    }
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setFindOpen(false)
                    }
                  },
                }),
                React.createElement('span', { className: 'rc-find-count' }, hitCount ? (hitIndex + 1) + ' / ' + hitCount : (query ? '0 / 0' : '')),
                hbtn('上一个 (Shift+Enter)', '↑', () => jumpToHit(-1)),
                hbtn('下一个 (Enter)', '↓', () => jumpToHit(1)),
                hbtn('清除', '×', () => {
                  setQuery('')
                  if (findRef.current) findRef.current.focus()
                }))
            : null,
          React.createElement('div', { className: 'rc-body' },
            showTree
              ? React.createElement('div', { className: 'rc-tree' },
                  rootEntries.length
                    ? rootEntries.map((entry) => React.createElement(TreeItem, {
                        key: entry.name,
                        entry,
                        dirPath: entry.name,
                        depth: 0,
                        selPath: sel ? sel.path : '',
                        onSelectFile: openFile,
                        onToggleDir: toggleDir,
                        expandedDirs: expanded,
                        childrenMap: children,
                        failedDirs,
                        loadDir,
                      }))
                    : (err
                        ? React.createElement('div', { className: 'rc-empty' }, '目录加载失败')
                        : React.createElement('div', { className: 'rc-empty' }, '目录为空或不可读')))
              : null,
            React.createElement('div', { className: 'rc-main' },
              sel
                ? React.createElement('div', { className: 'rc-main-meta' },
                    sel.path + ' · ' + fmtSize(sel.size)
                      + (sel.type === 'pdf' ? ' · PDF' : sel.type === 'office' ? ' · ' + sel.kind.toUpperCase() + ' 文本预览' : '')
                      + (sel.mtime ? ' · 修改于 ' + fmtTime(sel.mtime) : '')
                      + (progress > 0 ? ' · ' + pct + '%' : ''))
                : null,
              err && !sel
                ? React.createElement('div', { className: 'rc-empty' },
                    '报告目录不可用：' + err + (info && info.root ? '（' + info.root + '）' : ''),
                    React.createElement('div', null,
                      React.createElement('button', { type: 'button', className: 'rc-retry-btn', onClick: boot }, '重试')))
                : null,
              sel && sel.error
                ? React.createElement('div', { className: 'rc-empty' },
                    '无法打开：' + sel.error,
                    React.createElement('div', null,
                      React.createElement('button', { type: 'button', className: 'rc-retry-btn', onClick: () => openFile(sel.path, sel.name) }, '重试')))
                : loading
                  ? React.createElement('div', { className: 'rc-empty' }, '加载中…')
                  : isPdf || isOffice
                    ? React.createElement('div', {
                        className: 'rc-md',
                        ref: mdRef,
                        onScroll,
                      }, body)
                    : React.createElement('div', {
                        className: 'rc-md',
                        ref: mdRef,
                        onScroll,
                        style: { fontSize: fs + 'px' },
                        dangerouslySetInnerHTML: { __html: mdHtml },
                      }),
              showTop
                ? React.createElement('button', {
                    type: 'button',
                    className: 'rc-top',
                    title: '返回顶部',
                    onClick: () => {
                      if (mdRef.current) mdRef.current.scrollTo({ top: 0, behavior: 'smooth' })
                    },
                  }, '↑')
                : null),
            tocPanel),
          mode === 'popup'
            ? React.createElement('div', { className: 'rc-resize', onMouseDown: startResize, title: '拖拽调整大小' })
            : React.createElement('div', { className: 'rc-dock-edge', onMouseDown: startDockResize, title: '拖拽调整宽度' })))
    }

    /* ================= 打开/关闭（全局入口） ================= */

    let panelHost = null
    let panelRoot = null

    function closeReader() {
      if (panelRoot) {
        try { panelRoot.unmount() } catch { /* ignore */ }
        panelRoot = null
      }
      if (panelHost && panelHost.parentNode) panelHost.parentNode.removeChild(panelHost)
      panelHost = null
    }

    function openReader(initialPath) {
      try {
        if (!panelRoot) {
          panelHost = document.createElement('div')
          document.body.appendChild(panelHost)
          panelRoot = ReactDOM.createRoot(panelHost)
        }
        panelRoot.render(React.createElement(ReportPanel, {
          onClose: closeReader,
          initialPath: initialPath || null,
        }))
      } catch (e) {
        beacon('openReader-threw ' + (e && e.message ? e.message : String(e)))
      }
    }

    /* ================= 点击拦截 ================= */

    const CHIP_SELECTOR = [
      'a[href^="report-card://"]',
      'a[href*="/@dsh-external/dsh-agent-outputs-reader/api/file"]',
      'a[href*="/@dsh-external/dsh-report-card/api/file"]',
    ].join(',')

    function handleDocumentClick(e) {
      const el = e.target
      const a = el && typeof el.closest === 'function' ? el.closest(CHIP_SELECTOR) : null
      if (a) {
        e.preventDefault()
        e.stopPropagation()
        let path = ''
        try {
          const href = a.getAttribute('href') || ''
          if (href.startsWith('report-card://')) {
            path = new URL(href).searchParams.get('path') || ''
          } else {
            path = new URL(href, location.origin).searchParams.get('path') || ''
          }
        } catch {
          // 解析失败则忽略。
        }
        if (path) openReader(path)
        return
      }
      const chip = el && typeof el.closest === 'function'
        ? (el.closest('button.P4kPIW_file[title]') || el.closest('button[title]'))
        : null
      if (chip) {
        const p = chip.getAttribute('title') || ''
        if (isReaderPath(p)) {
          beacon('chip-open ' + p)
          e.preventDefault()
          e.stopPropagation()
          openReader(p)
        } else if (el && el.closest && el.closest('button.P4kPIW_file')) {
          beacon('chip-miss-class')
        }
      }
    }

    /* ================= 注册 ================= */

    function apply(ctx) {
      beacon('apply start')
      const styleEl = document.createElement('style')
      styleEl.textContent = CSS
      styleEl.dataset.plugin = '@dsh-external/dsh-agent-outputs-reader'
      document.head.appendChild(styleEl)

      document.addEventListener('click', handleDocumentClick, true)

      const ws = ctx.workspaces
      let restoreOpenPath = null
      if (ws && typeof ws.openPath === 'function') {
        const original = ws.openPath.bind(ws)
        const wrapped = function (path) {
          if (isReaderPath(path)) {
            openReader(String(path))
            return
          }
          return original.apply(ws, arguments)
        }
        ws.openPath = wrapped
        restoreOpenPath = () => {
          if (ws.openPath === wrapped) ws.openPath = original
        }
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
          // 注入器契约要求：注册一个合法 slot（不可见空条目，composer.dock 渲染为 null，零 UI 占用）
          const slots = ctx.slots
          let slotDispose = null
          if (slots && typeof slots.register === 'function' && typeof slots.inject === 'function') {
            try {
              slotDispose = slots.inject('conversation.composer.dock', () => slots.register({
                name: 'conversation.composer.dock',
                id: 'aor-ambient',
                order: 999,
                label: 'Agent Outputs Reader',
              }, () => null))
            } catch {
              // slot 注册失败不影响主功能。
            }
          }
          return () => {
            document.removeEventListener('click', handleDocumentClick, true)
            if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
            if (restoreOpenPath) restoreOpenPath()
            if (slotDispose && typeof slotDispose === 'function') slotDispose()
            closeReader()
          }
        }, '@dsh-external/dsh-agent-outputs-reader: intercepts')
      } else {
        beacon('ctx.effect 不可用：清理回调未注册')
      }
    }

    /* ================= 样式 ================= */

    const CSS = [
      'a[href^="report-card://open"],a[href*="/@dsh-external/dsh-agent-outputs-reader/api/file"],a[href*="/@dsh-external/dsh-report-card/api/file"]{display:inline-flex;align-items:center;gap:5px;margin:1px 3px;padding:1px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:.92em;line-height:1.6;cursor:pointer;vertical-align:middle}',
      'a[href^="report-card://open"]:hover,a[href*="/@dsh-external/dsh-agent-outputs-reader/api/file"]:hover,a[href*="/@dsh-external/dsh-report-card/api/file"]:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}',

      '.rc-overlay{position:fixed;inset:0;z-index:100000;background:#0b0d12;display:flex;align-items:center;justify-content:center;padding:26px}',
      '.rc-overlay.rc-zen{padding:10px}',
      '.rc-overlay.rc-docked{inset:0 0 0 auto;padding:0;background:transparent;align-items:stretch;justify-content:flex-end}',
      '.rc-overlay.rc-docked .rc-panel{height:100vh;max-height:100vh;border-radius:0;border-left:1px solid var(--dsw-alias-border-l2);border-top:none;border-bottom:none;border-right:none;box-shadow:-14px 0 42px rgba(0,0,0,.4)}',
      '.rc-resize{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;z-index:6}',
      '.rc-resize::after{content:"";position:absolute;right:4px;bottom:4px;width:8px;height:8px;border-right:2px solid var(--dsw-alias-label-tertiary);border-bottom:2px solid var(--dsw-alias-label-tertiary)}',
      '.rc-dock-edge{position:absolute;left:-6px;top:0;bottom:0;width:12px;cursor:ew-resize;z-index:6}',
      '.rc-dock-edge::after{content:"";position:absolute;left:5px;top:50%;transform:translateY(-50%);width:2px;height:40px;background:var(--dsw-alias-border-l2);border-radius:2px}',

      '.rc-panel{position:relative;width:min(1100px,100%);height:min(82vh,960px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.4);overflow:hidden}',
      '.rc-zen .rc-panel{width:100%;height:calc(100vh - 20px);border-radius:10px}',

      '.rc-progress{position:absolute;top:0;left:0;right:0;height:3px;background:transparent;z-index:5;pointer-events:none}',
      '.rc-progress-in{height:100%;background:var(--dsw-alias-brand-primary);transition:width .12s linear}',

      '.rc-head{display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.rc-head-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);flex:none;max-width:26%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rc-head-sub{flex:auto;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rc-hbtn{flex:none;border:1px solid transparent;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;min-width:24px;height:24px;padding:0 6px;border-radius:6px;line-height:1}',
      '.rc-hbtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.rc-hbtn.rc-on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.rc-hbtn.rc-dis{opacity:.35;cursor:default;pointer-events:none}',

      '.rc-find{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none}',
      '.rc-find-input{flex:auto;min-width:0;padding:5px 10px;font-size:13px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.rc-find-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.rc-find-count{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:56px;text-align:right;font-variant-numeric:tabular-nums}',

      '.rc-body{flex:1;display:flex;min-height:0}',
      '.rc-tree{width:260px;flex:none;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:8px 6px}',
      '.rc-tree-row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:4px 8px;border:none;background:none;color:var(--dsw-alias-label-secondary);font-size:12.5px;font-family:inherit;cursor:pointer;border-radius:6px;text-align:left}',
      '.rc-tree-row:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.rc-tree-row.rc-sel{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}',
      '.rc-tree-link{cursor:default;opacity:.7}',
      '.rc-tree-retry{color:var(--dsw-alias-state-warn-primary)}',
      '.rc-tree-caret{width:12px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px}',
      '.rc-tree-name{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rc-tree-size{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}',

      '.rc-main{flex:1;min-width:0;display:flex;flex-direction:column;position:relative}',
      '.rc-main-meta{flex:none;padding:7px 18px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rc-empty{padding:20px;font-size:13px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.rc-retry-btn{margin-top:10px;padding:4px 14px;font-size:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.rc-retry-btn:hover{border-color:var(--dsw-alias-brand-primary)}',

      '.rc-md{flex:1;overflow-y:auto;padding:18px 26px 40px;line-height:1.7;color:var(--dsw-alias-label-primary);overflow-wrap:break-word}',
      '.rc-md>*{max-width:100%}',
      '.rc-md .rc-md-wide{max-width:820px;margin-left:auto;margin-right:auto}',
      '.rc-md h1,.rc-md h2,.rc-md h3,.rc-md h4,.rc-md h5,.rc-md h6,.rc-md p,.rc-md ul,.rc-md ol,.rc-md hr,.rc-md blockquote,.rc-md table.rc-tbl,.rc-md pre.rc-code{max-width:820px;margin-left:auto;margin-right:auto}',
      '.rc-md h1{font-size:1.6em;line-height:1.35;margin:4px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rc-md h2{font-size:1.32em;margin:24px auto 10px;padding-bottom:4px;scroll-margin-top:12px}',
      '.rc-md h3{font-size:1.12em;margin:20px auto 8px;scroll-margin-top:12px}',
      '.rc-md h4,.rc-md h5,.rc-md h6{font-size:1.02em;margin:16px auto 6px;scroll-margin-top:12px}',
      '.rc-md p{margin:8px 0}',
      '.rc-md ul,.rc-md ol{margin:8px 0;padding-left:24px}',
      '.rc-md li{margin:3px 0}',
      '.rc-md code{background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px;font-size:.88em;font-family:ui-monospace,Consolas,monospace}',
      '.rc-md pre.rc-code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;overflow:auto;margin:10px auto}',
      '.rc-md pre.rc-code code{background:none;padding:0}',
      '.rc-md table.rc-tbl{border-collapse:collapse;margin:10px auto;font-size:.92em;max-width:100%;display:block;overflow-x:auto}',
      '.rc-md table.rc-tbl th,.rc-md table.rc-tbl td{border:1px solid var(--dsw-alias-border-l1);padding:5px 10px;text-align:left;white-space:nowrap}',
      '.rc-md table.rc-tbl th{background:var(--dsw-alias-bg-layer-2);font-weight:600}',
      '.rc-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:16px auto}',
      '.rc-md blockquote{border-left:3px solid var(--dsw-alias-brand-primary);margin:10px auto;padding:2px 14px;color:var(--dsw-alias-label-secondary)}',
      '.rc-md a{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.rc-md a:hover{text-decoration:underline}',
      '.rc-md strong{font-weight:600}',
      '.rc-md mark.rc-hit{background:var(--dsw-alias-state-warn-primary);color:#fff;border-radius:2px;padding:0 1px}',
      '.rc-md mark.rc-hit.rc-cur{background:var(--dsw-alias-state-error-primary)}',
      '.rc-md span.rc-img{color:var(--dsw-alias-label-tertiary);font-size:.92em}',
      '.rc-md span.rc-anchor{color:var(--dsw-alias-label-primary)}',
      '.rc-pdf{width:100%;height:100%;border:none;background:#525659}',
      '.rc-office{margin:0;padding:14px 20px;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-width:100%}',

      '.rc-top{position:absolute;right:22px;bottom:22px;width:34px;height:34px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:15px;box-shadow:0 4px 14px rgba(0,0,0,.15)}',
      '.rc-top:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',

      '.rc-toc{width:220px;flex:none;overflow-y:auto;border-left:1px solid var(--dsw-alias-border-l1);padding:8px 6px}',
      '.rc-toc-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:2px 8px 6px}',
      '.rc-toc-list{display:flex;flex-direction:column}',
      '.rc-toc-row{display:block;width:100%;box-sizing:border-box;border:none;background:none;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer;border-radius:6px;text-align:left;padding:3px 8px;line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rc-toc-row:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.rc-toc-row.rc-toc-active{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
    ].join('\n')

    return { inject, apply }
  },
})
