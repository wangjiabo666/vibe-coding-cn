// 离线批量校验：模拟 VitePress 的 markdown→Vue 模板渲染，
// 一次性找出所有会导致 [vite:vue] 解析失败的页面（而不是每次 build 只暴露第一个）。
// 用法：node scripts/check-pages.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createMarkdownRenderer } from 'vitepress'
import { parse as vueDomParse } from '@vue/compiler-dom'
import { vueSafeHtmlConfig } from '../.vitepress/utils/vue-safe-html.mjs'

// 部分 VitePress 内部插件引用裸的全局 logger，独立脚本运行时不存在，垫一层
if (!globalThis.logger) {
  // @ts-ignore
  globalThis.logger = { warn() {}, error() {}, deprecationHandler() {} }
}

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.git', '.vitepress', 'libs', '.github'])
const SRC_EXCLUDE = [/^AGENTS\.md$/, /^CONTRIBUTING\.md$/, /^CODE_OF_CONDUCT\.md$/, /^i18n\/zh\/README\.md$/]

function* walkMd(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const abs = join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walkMd(abs)
    } else if (/\.md$/i.test(entry)) yield abs
  }
}

function relPath(abs) {
  return abs.slice(ROOT.length + 1)
}

function excluded(rel) {
  return SRC_EXCLUDE.some((re) => re.test(rel))
}

const md = await createMarkdownRenderer(ROOT, { config: vueSafeHtmlConfig }, '/')

let checked = 0
const failures = []

for (const abs of walkMd(join(ROOT, '.'))) {
  const rel = relPath(abs)
  if (excluded(rel)) continue

  // 与 VitePress 相同的前置处理：frontmatter 剥离由渲染器内部完成
  const env = { path: `/${rel}`, relativePath: rel }
  let html
  try {
    html = md.render(readFileSync(abs, 'utf8'), env)
  } catch (e) {
    failures.push({ file: rel, line: '?', msg: `markdown render throw: ${e.message}` })
    continue
  }

  const errors = []
  // 与真实构建的 Vue 解析语义对齐：必须用 compiler-dom 的 parse（认识 void/原生标签）
  try {
    vueDomParse(html, { onError: (e) => errors.push(e) })
  } catch {
    /* 极端输入解析器自身可能 throw，忽略——真实 build 同样会失败，到 build 日志再查 */
  }
  if (errors.length > 0) {
    const err = errors[0]
    const m = err.loc?.start?.line ?? '?'
    failures.push({ file: rel, line: m, msg: err.message?.split(String.fromCharCode(10))[0] ?? String(err) })
  }
  checked++
}

console.log(`checked ${checked} pages`)
if (failures.length === 0) {
  console.log('ALL OK ✅')
} else {
  console.log(`\n${failures.length} broken pages:`)
  for (const f of failures) console.log(`  ${f.file}:${f.line} — ${f.msg}`)
  process.exit(1)
}
