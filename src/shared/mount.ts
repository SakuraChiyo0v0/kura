/**
 * folder 模式挂载点的命名。必须保持零依赖：渲染层与主进程都要读它
 * （渲染层打包时不能被带进 node: 模块，所以不能从 main/modules.ts 引）。
 *
 * 设置里存的是**父目录**，挂载点由 Kura 拼出来：rclone 要求挂载点本身不存在
 * （它自己建、自己删），让用户直接挑一个现成目录当挂载点必然撞上「已存在」。
 */
export const folderLeaf = 'KuraNAS'

/** 父目录 → 挂载点。 */
export function folderTarget(parent: string): string {
  return `${parent.replace(/[\\/]+$/, '')}\\${folderLeaf}`
}
