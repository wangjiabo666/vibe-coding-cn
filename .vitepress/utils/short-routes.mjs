import { createHash } from 'node:crypto'

/**
 * 超长路由短别名。
 *
 * VitePress 把 rewrites 之后的页面路由直接用作 rollup 产物文件名来源；
 * 仓库里有 6 条提示词文档路由的 slug 超过 200 字节，写盘时必撞
 * ENAMETOOLONG（文件系统 255 字节组件上限）。
 *
 * 解法：给超预算路由起确定性短别名（同目录保留 + sha1 前 10 位），
 * config.rewrites 与 utils/sidebar.routeOf 两侧都经 finalizeRoute 收口，
 * 保证路由与侧边栏链接永远一致。纯 ASCII 别名也顺带规避了 CJK 文件名
 * 在不同文件系统/托管端的编码差异。
 */

// 预算字节：保守取 140（实测超限者 170~256）
const ROUTE_BUDGET_BYTES = 140

const memo = new Map()

/** 估算 rollup 侧 slug 字节量：保守取「非 ASCII 保留原样」与「全转下划线」两者较大值 */
function slugByteLen(route) {
  const asciiFold = route.replace(/[^\w.-]/g, '_')
  return Math.max(Buffer.byteLength(route, 'utf8'), Buffer.byteLength(asciiFold, 'utf8'))
}

function sha10(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 10)
}

/**
 * 输入：无前导斜杠、无扩展名的最终路由（含 locale 前缀，如 `en/documents/x`、
 * `prompts/y/index`）；输出：可能被别名的同形态路由。
 * 未超预算时原样返回（含 `/index` 结尾形态）。
 */
export function finalizeRoute(route) {
  if (memo.has(route)) return memo.get(route)

  // 归一化出参与摘要的 key：`/index` 结尾归为目录本身
  const isIndex = route.endsWith('/index') || route === 'index'
  const base = isIndex ? route.replace(/\/?index$/, '') || 'index' : route

  let out = route
  if (slugByteLen(base) > ROUTE_BUDGET_BYTES) {
    const slash = base.lastIndexOf('/')
    const dir = slash === -1 ? '' : base.slice(0, slash + 1)
    out = `${dir}p${sha10(base)}${isIndex ? '/index' : ''}`
  }

  memo.set(route, out)
  return out
}
