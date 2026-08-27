import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { finalizeRoute } from './short-routes.mjs'

/**
 * 侧边栏生成器 —— 运行时遍历 i18n/<locale>/<section> 实际文件生成配置。
 * 不做静态快照：zh/en 文件集不对称（zh 266 / en 261 个 .md），必须按各自真实文件生成。
 */

export type SidebarItem = { text: string; link?: string; items?: SidebarItem[]; collapsed?: boolean }

const ROOT = process.cwd()
export const SECTIONS = ['documents', 'prompts', 'skills', 'workflow'] as const

/** 各板块中英标题 */
const SECTION_LABELS: Record<string, Record<'zh' | 'en', string>> = {
  documents: { zh: '📚 指南文档', en: '📚 Documents' },
  prompts: { zh: '💬 提示词库', en: '💬 Prompts' },
  skills: { zh: '⚡ Skills 技能库', en: '⚡ Skills' },
  workflow: { zh: '🔄 工作流', en: '🔄 Workflow' },
}

const OVERVIEW_LABEL = { zh: '概述', en: 'Overview' } as const
type Locale = 'zh' | 'en'

/**
 * 探测「README.md 与 index.md 同目录共存」的目录集合（srcDir 相对的目录路径）。
 * 这些目录里的 README 不能改写为 index 路由，否则两个源文件映射到同一路由。
 * config 的 rewrites 与本文件的 routeOf 共用这份数据。
 */
export function findReadmeIndexCollisions(): Set<string> {
  const collisions = new Set<string>()
  for (const locale of ['zh', 'en'] as const) {
    for (const section of SECTIONS) {
      walkDirs(join(ROOT, 'i18n', locale, section), `i18n/${locale}/${section}`, (absDir, srcRel) => {
        if (existsSync(join(absDir, 'README.md')) && existsSync(join(absDir, 'index.md'))) {
          // 统一存「剥掉 i18n/<locale>/ 前缀」的目录路径：
          // routeOf 与 config.rewrites 的比较两侧都是剥前缀后的形态
          collisions.add(srcRel.replace(/^i18n\/(?:zh|en)\//, ''))
        }
      })
    }
  }
  return collisions
}

function walkDirs(
  absDir: string,
  srcRel: string,
  fn: (absDir: string, srcRel: string) => void,
): void {
  if (!existsSync(absDir)) return
  fn(absDir, srcRel)
  for (const entry of readdirSync(absDir)) {
    const abs = join(absDir, entry)
    if (statSync(abs).isDirectory()) {
      walkDirs(abs, `${srcRel}/${entry}`, fn)
    }
  }
}

/** 源路径 → 站点路由。规则与 config.mts 的 rewrites 保持一致：
 *  - index.md → 所在目录的 index 路由；README.md 同样归一化，冲突目录例外（保持原名路由）
 *  - zh 剥掉 `i18n/zh/` 前缀（根 locale），en 保留 `/en` 前缀
 *  - 最终经 finalizeRoute 收口（超长路由短别名，防产物文件名超限） */
export function routeOf(srcRel: string, collisions: Set<string>): string {
  let rest: string
  let localeSeg = ''
  if (srcRel.startsWith('i18n/zh/')) {
    rest = srcRel.slice('i18n/zh/'.length)
  } else if (srcRel.startsWith('i18n/en/')) {
    rest = srcRel.slice('i18n/en/'.length)
    localeSeg = 'en/'
  } else {
    rest = srcRel
  }

  const dirEnd = rest.lastIndexOf('/')
  const dir = dirEnd === -1 ? '' : rest.slice(0, dirEnd)
  const base = rest.slice(dirEnd + 1)

  const isIndex = base === 'index.md' || (base === 'README.md' && !collisions.has(dir))
  const target = isIndex ? `${dir === '' ? '' : dir + '/'}index` : rest.replace(/\.md$/, '')

  const finalized = finalizeRoute(`${localeSeg}${target}`)
  const route =
    finalized === 'index' ? '/' : `/${finalized.replace(/\/index$/, '/')}`
  return encodeSegments(route)
}

/** 按段编码 URL（空格 → %20、中文 → 百分号编码），保留斜杠结构 */
function encodeSegments(route: string): string {
  return route
    .split('/')
    .map((seg) => (seg === '' ? '' : encodeURIComponent(seg)))
    .join('/')
}

/** 目录显示名：剥数字前缀，兼容 `-01-哲学与方法论` 与 `00-基础指南` 两种形态 */
function prettyName(name: string): string {
  const stripped = name.replace(/^-?\d+-/, '')
  return truncated(stripped || name)
}

/** 文件显示名：去 .md、剥数字前缀；README / SKILL.md 统一显示为「概述」 */
function prettyFile(name: string, locale: Locale): string {
  const lower = name.toLowerCase()
  if (lower === 'readme.md' || lower === 'skill.md') return OVERVIEW_LABEL[locale]
  return truncated(name.replace(/\.md$/i, '').replace(/^-?\d+[-_]/, '').trim())
}

function truncated(t: string, max = 60): string {
  return t.length > max ? `${t.slice(0, max)}…` : t
}

interface WalkCtx {
  locale: Locale
  collisions: Set<string>
  collator: Intl.Collator
}

/** 某目录的"落地页"来源文件：SKILL.md > README.md > index.md > null */
function pickLanding(files: string[]): string | null {
  const has = (n: string) => files.find((f) => f.toLowerCase() === n)
  return has('SKILL.md') ?? has('README.md') ?? has('index.md') ?? null
}

function walkDir(absDir: string, srcRel: string, ctx: WalkCtx): SidebarItem[] {
  let entries: string[]
  try {
    entries = readdirSync(absDir)
  } catch {
    return []
  }

  const dirs: string[] = []
  const files: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const abs = join(absDir, entry)
    try {
      if (statSync(abs).isDirectory()) dirs.push(entry)
      else if (/\.md$/i.test(entry)) files.push(entry)
      // 非 md 文件（gitkeep、png、模板等）一律跳过
    } catch {
      /* 权限等异常，跳过 */
    }
  }
  dirs.sort(ctx.collator.compare)
  files.sort(ctx.collator.compare)

  const items: SidebarItem[] = []

  for (const d of dirs) {
    const children = walkDir(join(absDir, d), `${srcRel}/${d}`, ctx)
    if (children.length === 0) continue // 空目录 / 只有杂文件
    items.push({ text: prettyName(d), collapsed: true, items: children })
  }

  // 目录落地页（README/SKILL.md）作为该组第一项「概述」，其余文件逐个列出
  const landing = pickLanding(files)
  if (landing) {
    items.push({ text: OVERVIEW_LABEL[ctx.locale], link: routeOf(`${srcRel}/${landing}`, ctx.collisions) })
  }
  for (const f of files) {
    if (f === landing) continue
    items.push({ text: prettyFile(f, ctx.locale), link: routeOf(`${srcRel}/${f}`, ctx.collisions) })
  }

  return items
}

/** 生成单个板块的侧边栏组，落地链接指向该板块首页 */
function buildSection(locale: Locale, section: string, collisions: Set<string>): SidebarItem | null {
  const sectionSrc = `i18n/${locale}/${section}`
  const ctx: WalkCtx = { locale, collisions, collator: new Intl.Collator(locale === 'zh' ? 'zh-Hans-CN' : 'en-US', { numeric: true }) }

  const children = walkDir(join(ROOT, sectionSrc), sectionSrc, ctx)
  if (children.length === 0) return null

  return {
    text: SECTION_LABELS[section]?.[locale] ?? section,
    collapsed: true,
    items: [
      { text: OVERVIEW_LABEL[locale], link: routeOf(`${sectionSrc}/README.md`, collisions) },
      ...children,
    ],
  }
}

/** 对外语出入口：返回指定语言的完整 sidebar 配置 */
export function buildSidebar(locale: Locale): SidebarItem[] {
  const collisions = findReadmeIndexCollisions()
  return SECTIONS.map((s) => buildSection(locale, s, collisions)).filter(
    (g): g is SidebarItem => g !== null,
  )
}
