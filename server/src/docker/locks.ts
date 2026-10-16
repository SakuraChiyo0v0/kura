import { DockerError } from './engine.js'

/**
 * 同一个项目同时只能有一个 compose 动作 —— 两次 up 叠在一起结果不可预测
 * （原话在 handler.ts 里，这把锁本来就在那儿，只是只护住了界面上那条路径）。
 *
 * **界面操作与自动更新必须共用同一把**：自动更新正在 pull + up 的时候，
 * 用户在容器页点「重启」，两边会同时动一个项目的容器。
 * 所以这把锁从 handler 的闭包里搬出来，由 main.ts 造一个给两边。
 */
export class ProjectLocks {
  private readonly held = new Set<string>()

  /** 拿不到锁就抛出 409（和界面上那条路径一直是同一个说法）。 */
  async run<T>(name: string, work: () => Promise<T>): Promise<T> {
    if (this.held.has(name)) throw new DockerError(409, `「${name}」正在执行别的操作，等它结束`)
    this.held.add(name)
    try {
      return await work()
    } finally {
      this.held.delete(name)
    }
  }

  has(name: string): boolean {
    return this.held.has(name)
  }
}
