import { defineConfig } from 'vitepress'
import { buildSidebar, findReadmeIndexCollisions } from './utils/sidebar'
import { vueSafeHtmlConfig } from './utils/vue-safe-html.mjs'
import { DEAD_LINK_BASELINE_URLS } from './utils/dead-link-baseline.mjs'
import { finalizeRoute } from './utils/short-routes.mjs'

/**
 * Vibe Coding 指南 · 双语文档站配置
 *
 * - 内容源就是仓库本身（srcDir: '.'），根 README 作为中文首页，
 *   i18n/en/README.md 作为英文首页（/en/）。
 * - 路由规则（rewrites 与 utils/sidebar 的 routeOf 保持一致）：
 *     i18n/zh/X            → /X        （根 locale 剥前缀）
 *     i18n/en/X            → /en/X
 *     各目录 README.md     → 目录 index 路由；与 index.md 共存的例外目录保持原名
 */

// 「README.md 与 index.md 同目录共存」的目录集合，两条路径共用一次探测结果
const collisions = findReadmeIndexCollisions()

/** 归一化单侧语言树内的文件路径：README→目录 index、去 .md 后缀（无 locale 前缀、无扩展名） */
function normalizeLocalePath(rest: string): string {
  const dirEnd = rest.lastIndexOf('/')
  const dir = dirEnd === -1 ? '' : rest.slice(0, dirEnd)
  const base = rest.slice(dirEnd + 1)

  if (base === 'index.md' || (base === 'README.md' && !collisions.has(dir))) {
    return dir === '' ? 'index' : `${dir}/index`
  }
  return rest.replace(/\.md$/, '')
}

// 搜索切词器：拉丁词按词、中日文字符逐字切分（内置空白切分搜不了中文）
const SEARCH_TOKEN_RE = /[A-Za-z0-9_]+|[぀-ヿ㐀-䶿一-鿿豈-﫿]/g
const cjkTokenize = (text: string): string[] => text.match(SEARCH_TOKEN_RE)?.map((t) => t.toLowerCase()) ?? []

export default defineConfig({
  title: 'Vibe Coding 指南',

  // 语言：简体中文为默认 locale（根路径），英文挂载在 /en/
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '文档', link: '/documents/' },
          { text: '提示词', link: '/prompts/' },
          { text: 'Skills', link: '/skills/' },
          { text: '工作流', link: '/workflow/' },
        ],
        sidebar: buildSidebar('zh'), // 运行时遍历 i18n/zh 实际文件生成
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'Documents', link: '/en/documents/' },
          { text: 'Prompts', link: '/en/prompts/' },
          { text: 'Skills', link: '/en/skills/' },
          { text: 'Workflow', link: '/en/workflow/' },
        ],
        sidebar: buildSidebar('en'), // 运行时遍历 i18n/en 实际文件生成（zh/en 文件集不对称，各自生成）
      },
    },
  },

  srcDir: '.',
  // libs/ 是开发者工具链而非读者内容；三个根级协作文档同样不进站点。
  // 注意：有意排除 i18n/zh/README.md —— 它只是指向仓库根 README 的 45 行着陆页，
  // 而根 README 才是本站首页的真实内容源。
  srcExclude: ['libs/**', 'AGENTS.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'i18n/zh/README.md'],

  // GitHub Pages 项目页子路径；部署工作流通过环境变量注入
  base: process.env.DOCS_BASE ?? '/',

  /**
   * 死链白名单（首跑实测基线：2215 条记录去重后 470 个目标，2026-08-27）。
   *
   * 来源构成：skills 各板块下 references 目录的 Timescale / Coingecko / Polymarket /
   * Anthropic cookbook 等厂商文档拷贝里指向原站内部结构的相对链接为主，
   * 加上少量仓库自身的目录式历史断链。VitePress 校验前会剥掉扩展名，
   * 因此无法按"是否指向页面"区分，只能精确枚举目标字符串。
   *
   * 取舍说明：像 ./README 这类通用目标被全局放行，理论上一处未来的
   * 同名真死链会被一并放过——属于低风险（侧边栏/GitHub 双通道仍可见），
   * 换取当下 470 行而不是正则炼狱。后续修复源内容后应同步删减此表。
   */
  ignoreDeadLinks: [(id: string) => DEAD_LINK_BASELINE_URLS.has(id)],

  rewrites(id: string): string {
    // 产出统一收口：finalizeRoute 会对超长路由起短别名（防 ENAMETOOLONG），
    // 与 utils/sidebar.routeOf 共用同一函数保证路由一致；重写目标统一补 .md
    const f = (t: string) => `${finalizeRoute(t)}.md`

    // 中文根 locale：剥掉 i18n/zh/ 前缀
    if (id === 'README.md') return f('index')
    if (id === 'i18n/zh/README.md') return id // 已被 srcExclude，防御性兜底
    if (id.startsWith('i18n/zh/')) return f(normalizeLocalePath(id.slice('i18n/zh/'.length)))

    // 英文 locale：保留 /en/ 前缀，en README 即英文首页
    if (id === 'i18n/en/README.md') return f('en/index')
    if (id.startsWith('i18n/en/')) return f(`en/${normalizeLocalePath(id.slice('i18n/en/'.length))}`)

    // 其余根级 .md（若有漏网）维持归一化处理
    if (id.endsWith('.md')) return f(normalizeLocalePath(id))
    return id
  },

  head: [['meta', { name: 'theme-color', content: '#3f7cd6' }]],


  vite: {
    build: {
      rollupOptions: {
        output: {
          // banner 改变每个 JS chunk 的内容 → 哈希全部换代：
          // 用于击穿 Pages CDN 对旧 URL 缓存的 404（部署空窗期产生的缓存）
          banner: '/* v2 */',
          assetFileNames(info) {
            const raw = (info.names && info.names[0]) || 'asset'
            const short = String(raw)
              .replace(/[^\w.-]+/g, '_')
              .slice(-48) // 保尾巴（扩展名与末段语义），防字节超限
            return `assets/f-${short}-[hash][extname]`
          },
        },
      },
    },
  },

  markdown: {
    // 伪 XML 占位符自动转义兜底，防止 Vue 模板解析失败中断构建（详见 utils/vue-safe-html.mjs）
    config: vueSafeHtmlConfig,
    lineNumbers: false,
  },

  themeConfig: {
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          options: { tokenize: cjkTokenize },
          searchOptions: { tokenize: cjkTokenize },
        },
      },
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/tukuaiai/vibe-coding-cn' }],
    outline: [2, 3],
  },
})
