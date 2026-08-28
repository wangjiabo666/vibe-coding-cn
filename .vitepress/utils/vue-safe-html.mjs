import { parse as vueDomParse } from '@vue/compiler-dom'
import { existsSync } from 'node:fs'
import { join, resolve as pathResolve } from 'node:path'

/**
 * Vue 模板安全兜底（双层防线），防止 VitePress 构建期被存量坏内容炸掉。
 *
 * 背景：站点内容是大量手编 AI 提示词文档，存在伪 XML 占位符（<输出格式>）、
 * 跨段吞没的未闭合强调、属性中夹带 "<"、<?xml?> 指令残留等破坏性形态——
 * 它们能通过 markdown/html 直通，却会让 Vue 模板解析器报错中断整次构建。
 *
 * 第一层（snippet 规则）：单个 html_block / html_inline 片段若无法被 baseParse
 *   接受，就地整体转义为纯文本展示（合法的 <details>/徽章等原样放行）。
 *
 * 第二层（doc 级修复）：monkey-patch md.render —— 渲染产物若解析失败，做一次
 *   浏览器风格的容错重建：
 *     - 删除 <? processing instruction ?>
 *     - 模拟开/闭标签栈：补齐未闭合标签的闭合符、丢弃无主的闭合符、
 *       不匹配嵌套按浏览器惯例弹出；
 *     - 属性里含非法字符的标签整体替换为 HTML 注释占位（视觉零痕迹）；
 *   修复后仍失败（理论兜不到的极端），最后降级为全量尖括号转义，保证能构建。
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

// 必须用 compiler-dom 的 parse（带 DOM 默认配置：void 标签、原生标签集合等）；
// 裸 baseParse 不认识 <img>/<br> 等空元素，会把合法 HTML 误判成缺闭合
function parseErrorCount(html) {
  let errors = 0
  try {
    vueDomParse(html, { onError: () => errors++ })
  } catch {
    return 999
  }
  return errors
}

function escapeTagChars(s) {
  return s.split('<').join('&lt;')
}

// ---------------------------------------------------------------------------
// 第一层：片段级规则
//
// v2 修正：markdown-it 产出的 html_block / html_inline 都是 CommonMark 合法
// 标签语法（首页徽章 <p align>+<img>、<details> 折叠块等），开/闭标签经常被
// 空行拆进不同片段——单片段"缺闭合标签"是正常形态，绝不能据此转义成纯文本
// （否则徽章区变成一屏可见的原始标签）。合法性交给第二层文档级平衡修复。
//
// 本层只处理「文本 token 里残留的伪标签」：markdown-it 按规范把它们留在文本
// 中（如 <输出格式>、a<b），但 Vue 词法器会尝试按标签解析并报错。
// 判据：< 后紧跟 / ! ? 或 ASCII 字母才需要转义；< 后跟空格/CJK/数字是纯文本。
// ---------------------------------------------------------------------------

const TEXT_PSEUDO_TAG_RE = /<(?=[/?!A-Za-z])/g

// 本地图片引用治理：Vite 会把相对路径图片（无论 md 图片语法还是 <img> 标签）
// 转成模块导入，文件不存在就构建失败。按「源文件所在目录」判定：
//   文件存在 → 补 ./ 前缀（裸路径缺前缀无法解析）让其正常导入渲染
//   文件不存在 → 摘除引用（img 标签/图片 token 整个移除）
// 外链（http/https//）、绝对路径、data URI、锚点一律不动。
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc=")([^"]*)(")/g

const ROOT_DIR = pathResolve(process.cwd())

function isLocalSrc(src) {
  return Boolean(src) && !src.startsWith('/') && !src.startsWith('http://') &&
    !src.startsWith('https://') && !src.startsWith('data:') && !src.startsWith('#') &&
    !src.startsWith('mailto:')
}

// 返回 null 表示保留原样；否则返回新 src（补 ./）或 ''（文件不存在，摘除）
function resolveLocalSrc(src, srcDir) {
  if (!isLocalSrc(src)) return null
  return existsSync(join(srcDir, src)) ? `./${src}` : ''
}

function fixHtmlImgSources(content, env) {
  const relPath = env?.relativePath
  if (!relPath) return content
  const srcDir = join(ROOT_DIR, relPath, '..')
  return content.replace(IMG_SRC_RE, (full, head, src, tail) => {
    const next = resolveLocalSrc(src, srcDir)
    return next === null ? full : `${head}${next}${tail}`
  })
}

export function vueSafeHtmlRule(state) {
  const tokens = state.tokens
  const env = state.env
  const relPath = env?.relativePath
  const srcDir = relPath ? join(ROOT_DIR, relPath, '..') : null

  for (const tok of tokens) {
    if (tok.type === 'html_block' && tok.content && tok.content.includes('<img')) {
      tok.content = fixHtmlImgSources(tok.content, env)
    } else if (tok.type === 'inline' && tok.children) {
      for (const child of tok.children) {
        if (child.type === 'html_inline' && child.content && child.content.includes('<img')) {
          child.content = fixHtmlImgSources(child.content, env)
        } else if (child.type === 'image' && srcDir) {
          // Markdown 图片 token：文件不存在的引用整个摘除（导入会失败）
          const src = child.attrGet('src') ?? ''
          if (isLocalSrc(src) && !existsSync(join(srcDir, src))) {
            child.type = 'text'
            child.tag = ''
            child.content = ''
            child.children = []
          }
        } else if (child.type === 'text' && child.content && TEXT_PSEUDO_TAG_RE.test(child.content)) {
          child.content = child.content.replace(TEXT_PSEUDO_TAG_RE, '&lt;')
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 第二层：文档级修复
// ---------------------------------------------------------------------------

// 与 Vue 词法器口径对齐的标签正则：注释 | 处理指令 | 正常标签（含自闭合）
const TAG_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

/**
 * 对整页 html 做容错重建。返回 false 表示连这层也救不了（极少发生）。
 */
export function repairDocumentHtml(html) {
  // 无条件清除处理指令（<?, XML 残留）——Vue 一律拒绝
  let src = html.replace(/<\?[\s\S]*?\?>/g, '')

  // stack 栈帧只记录待闭合的标签名
  let out = ''
  const stack = []
  let last = 0

  function flushTo(end) {
    out += src.slice(last, end)
    last = end
  }

  TAG_RE.lastIndex = 0
  let m
  while ((m = TAG_RE.exec(src)) !== null) {
    const [full, slash, rawName, attrsRaw, selfClose] = m

    // 注释原样放行（将在后续区段拷贝中自然带出）
    if (full.startsWith('<!--')) continue
    if (rawName === undefined) continue // 防御：正则分支未覆盖的形态按原文保留

    const name = rawName.toLowerCase()

    // 引号内容先掩蔽，再检查残余是否含非法字符（标签结构已损坏的信号）；
    // 另检测同名重复属性 —— Vue 词法零容忍，统一替换为注释占位（视觉零痕迹）
    const maskedAttrs = attrsRaw.replace(/("[^"]*"|'[^']*')/g, (q) => ' '.repeat(q.length))
    let malformed = /[<>`"']/.test(maskedAttrs) || /^[\d.]/.test(rawName)
    if (!malformed && slash !== '/') {
      const seen = new Set()
      const ATTR_RE = /([\w:@.\-]+)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g
      let am
      while ((am = ATTR_RE.exec(maskedAttrs)) !== null) {
        const key = am[1].toLowerCase()
        if (seen.has(key)) {
          malformed = true
          break
        }
        seen.add(key)
      }
    }
    if (malformed || (slash === '/' && maskedAttrs.trim() !== '')) {
      flushTo(m.index)
      out += `<!--vsh-stripped ${full.slice(0, 60)}-->`
      last = m.index + full.length
      continue
    }

    flushTo(m.index)

    if (slash === '/') {
      // 闭标签：找最近同名祖先；沿途被跳过的开标签视作立即闭合
      let found = -1
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === name) {
          found = i
          break
        }
      }
      if (found === -1) {
        // 孤儿闭标签：直接丢弃
        last = m.index + full.length
        continue
      }
      while (stack.length > found + 1) {
        const frame = stack.pop()
        out += `</${frame.tag}>` // 未正确嵌套者就地补上（浏览器恢复语义）
      }
      stack.pop()
    } else if (!VOID_TAGS.has(name) && !selfClose) {
      stack.push({ tag: name, startOut: out.length })
    }
    out += full
    last = m.index + full.length
  }
  flushTo(src.length)
  while (stack.length > 0) {
    const frame = stack.pop()
    out += `</${frame.tag}>`
  }
  return out
}

/** 最后手段：全部尖括号转义（保证可解析，格式降级） */
function escapeEverything(html) {
  return html.split('<').join('&lt;')
}

// 字面量 {{ }}（shell / 模板引擎示例）会被 Vue 当插值表达式解析，统一换成等值实体
function escapeInterpolations(html) {
  return html.split('{{').join('&#123;&#123;')
}

/**
 * 分级降级管线：把任意 html 片段变成 Vue 模板可解析的形态。
 *   快路径（无插值字面量且解析零错）→ L1 标签栈重建+插值实体化 →
 *   L2 再来一轮 → L3 全量尖括号转义（保构建、内容降级可读）。
 */
export function makeVueTemplateSafe(html) {
  const clean = (h) => !h.includes('{{') && parseErrorCount(h) === 0
  if (clean(html)) return html

  let fixed = escapeInterpolations(repairDocumentHtml(html))
  if (clean(fixed)) return fixed

  fixed = escapeInterpolations(repairDocumentHtml(fixed))
  if (clean(fixed)) return fixed

  // L3 最后手段：全量尖括号转义。必须再叠加插值实体化 —— {{ }} 不是标签，
  // escapeEverything 不会碰它；漏掉就会让 plugin-vue 把字面量当表达式解析炸掉构建
  return escapeInterpolations(escapeEverything(html))
}

// ---------------------------------------------------------------------------
// 出入口：注入 md 实例
// ---------------------------------------------------------------------------

export function applySafeRendering(md) {
  const origRender = md.render.bind(md)
  md.render = (input, env) => makeVueTemplateSafe(origRender(input, env))
}

/** 传给 VitePress markdown 配置的 config 回调 */
export function vueSafeHtmlConfig(md) {
  md.core.ruler.push('vue_safe_html', vueSafeHtmlRule)
  applySafeRendering(md)
}
