/**
 * @dsh-external/dsh-agent-outputs-reader 客户端冒烟回归（node --test）。
 * 守卫回归（新 id 无条件注册）+ apply 副作用 + openPath 包装/恢复。
 */
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const CLIENT_SRC = path.join(__dirname, '..', 'src', 'client', 'index.js')

function makeReactStub() {
  const noop = () => {}
  const React = {
    useState: () => [null, noop],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    createElement: noop,
    Fragment: {},
  }
  const ReactDOM = { createRoot: () => ({ render: noop, unmount: noop }) }
  return { React, ReactDOM }
}

function makeDocument() {
  const listeners = {}
  const head = { appendChild: () => {}, removeChild: () => {} }
  const body = { appendChild: () => {}, removeChild: () => {} }
  return {
    head,
    body,
    createElement: () => ({ textContent: '', dataset: {}, style: {} }),
    addEventListener(type, fn, capture) { listeners[type] = { fn, capture } },
    removeEventListener(type) { delete listeners[type] },
    _listeners: listeners,
  }
}

function loadClient() {
  const reg = { captured: null }
  global.window = {
    __ModuleLoader__: { load(r) { reg.captured = r } },
    addEventListener() {}, removeEventListener() {}, innerWidth: 1400, innerHeight: 900,
  }
  const doc = makeDocument()
  global.document = doc
  global.location = { origin: 'http://127.0.0.1:3080' }
  const code = fs.readFileSync(CLIENT_SRC, 'utf8')
  vm.runInThisContext('(() => {\n' + code + '\n})()', { filename: 'client.js' })
  return { reg: reg.captured, doc }
}

function makeExports(reg) {
  const { React, ReactDOM } = makeReactStub()
  return reg.factory((spec) => {
    if (spec === 'react') return React
    if (spec === 'react-dom') return ReactDOM
    throw new Error('unexpected require: ' + spec)
  })
}

test('守卫回归：无条件注册且 id 为新插件名', () => {
  const { reg } = loadClient()
  assert.ok(reg, 'load 未被调用（守卫回归）')
  assert.equal(reg.id, '@dsh-external/dsh-agent-outputs-reader')
  assert.equal(typeof reg.factory, 'function')
})

test('factory 返回 { inject, apply }，inject 含 workspaces 与 slots', () => {
  const { reg } = loadClient()
  const exportsObj = makeExports(reg)
  assert.deepEqual(exportsObj.inject, ['workspaces', 'slots'])
  assert.equal(typeof exportsObj.apply, 'function')
})

test('apply：安装捕获阶段 click 监听 + openPath 包装（reports 文件不透传）', () => {
  const { reg, doc } = loadClient()
  const exportsObj = makeExports(reg)
  const openPathCalls = []
  const ctx = {
    workspaces: { openPath(p) { openPathCalls.push(p) } },
    effect(fn) { return fn() },
  }
  exportsObj.apply(ctx)
  const click = doc._listeners.click
  assert.ok(click, 'click 监听未安装')
  assert.equal(click.capture, true)
  ctx.workspaces.openPath('C:\\Projects\\Quant\\reports\\v1\\a.pdf')
  assert.equal(openPathCalls.length, 0, 'reports 下 PDF 不应透传')
  ctx.workspaces.openPath('C:\\code\\main.py')
  assert.equal(openPathCalls.length, 1)
})

test('apply：dispose 后 openPath 行为恢复', () => {
  const { reg } = loadClient()
  const exportsObj = makeExports(reg)
  let passthrough = 0
  const original = function orig() { passthrough++ }
  let cleanup = null
  const ctx = {
    workspaces: { openPath: original },
    effect(fn) { cleanup = fn(); return cleanup },
  }
  exportsObj.apply(ctx)
  assert.notEqual(ctx.workspaces.openPath, original)
  ctx.workspaces.openPath('C:\\Projects\\Quant\\reports\\a.docx')
  assert.equal(passthrough, 0)
  cleanup()
  ctx.workspaces.openPath('C:\\code\\main.py')
  assert.equal(passthrough, 1, 'dispose 后应恢复原行为')
})
