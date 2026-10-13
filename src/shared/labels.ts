/** 两侧共用的展示文案。必须保持零依赖：渲染层打包时不能被带进 node: 模块。 */
export type LinkMode = 'lan' | 'wan'
export type LinkModeSetting = LinkMode | 'auto'

export const linkModeLabel: Record<LinkMode, string> = { lan: '局域网直连', wan: '外网中继' }
