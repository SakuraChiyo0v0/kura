import type net from 'node:net'

/**
 * 把一条 TCP 连接和一条 WebSocket 对接起来，双向搬运原始字节。
 *
 * **客户端与服务端共用这一份**：两边各写一遍必然漂移（NAS 侧修了背压、客户端没修），
 * 而这类不一致只有在大流量下才暴露，是最难查的一类。
 *
 * 三条原则：
 * 1. **全是二进制帧**。数据库协议里没有文本/控制的分界（PG 的 wire protocol 全是二进制），
 *    靠前缀嗅探区分控制消息会被数据里恰好长得像的字节骗到 —— 容器 shell 那条路靠正则嗅探
 *    `{"type":"resize"`，对 PTY 够用，对数据库协议不可接受。
 * 2. **两侧都要背压**。`ws.send()` 没有背压信号（只有 `bufferedAmount`），`socket.write()` 有返回值。
 *    只做一侧会在另一侧快速吐数据时无限堆内存。
 * 3. **不做应用层空闲超时**。数据库连接池的连接会正常闲置很久（10–30 分钟），任何「N 分钟无字节就断」
 *    的规则都会周期性杀掉健康的连接池连接，表现为「应用时不时报连接已关闭」。靠 TCP keepalive。
 */

/** WS 侧在途字节超过它就暂停 TCP 源；降到它以下再恢复。 */
export const defaultHighWaterMark = 1024 * 1024

/** 一条隧道两端各自的最小接口：只用到这几个成员，测试里可以给假的。 */
export interface SocketLike {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'close' | 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'drain', listener: () => void): unknown
  pause(): unknown
  resume(): unknown
  write(chunk: Buffer): boolean
  destroy(): unknown
  readonly destroyed: boolean
}

/** `ws` 的 WebSocket 满足这个形状（它自己就有 pause/resume，用来暂停底层 socket 的读取）。 */
export interface WebSocketLike {
  send(data: Buffer, callback?: (error?: Error) => void): void
  close(code?: number, reason?: string): void
  pause(): void
  resume(): void
  readonly bufferedAmount: number
  readonly readyState: number
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown
  on(event: 'close' | 'error', listener: (error?: Error) => void): unknown
}

/** WebSocket.OPEN 的数字值；不 import `ws` 是为了让这份代码在两端都能用。 */
const wsOpen = 1

export interface PumpOptions {
  highWaterMark?: number
  /** 双向字节计数（上行 = 本地发往 NAS；下行 = NAS 发回本地） */
  onBytes?: (direction: 'up' | 'down', bytes: number) => void
  /** 任一侧结束/出错时调用一次；调用方负责关掉另一侧。 */
  onClose: (reason: string) => void
  /** 出错时记一笔（不抛：隧道出错不该拖垮进程） */
  onError?: (error: Error) => void
}

/**
 * 接好两侧并开始搬运。返回一个「立刻停掉」的函数。
 *
 * 关闭语义：WebSocket 没有半关闭（FIN），所以**任一方向关闭 = 整条隧道关**。
 * 实际影响很小：PG 客户端正常关闭是发 Terminate 再整个关、MySQL 是发 COM_QUIT、Redis 直接关。
 */
export function pumpSocket(tcp: SocketLike, ws: WebSocketLike, options: PumpOptions): () => void {
  const highWaterMark = options.highWaterMark ?? defaultHighWaterMark
  let closed = false
  let pumpTimer: NodeJS.Timeout | undefined

  const finish = (reason: string): void => {
    if (closed) return
    closed = true
    if (pumpTimer) clearInterval(pumpTimer)
    options.onClose(reason)
  }

  /** WS 上堆的字节降下来了就恢复 TCP 源。`ws.send` 的回调只在写完时触发，够用；再配一个定时器兜底。 */
  const resumeWhenDrained = (): void => {
    if (pumpTimer) return
    pumpTimer = setInterval(() => {
      if (closed || ws.bufferedAmount <= highWaterMark) {
        if (pumpTimer) clearInterval(pumpTimer)
        pumpTimer = undefined
        if (!closed) tcp.resume()
      }
    }, 50)
    pumpTimer.unref?.()
  }

  // TCP → WS
  tcp.on('data', (chunk: Buffer) => {
    if (closed || ws.readyState !== wsOpen) return
    options.onBytes?.('up', chunk.length)
    ws.send(chunk, (error) => {
      if (error) finish(`发送到 NAS 失败：${error.message}`)
    })
    // 在途字节太多：先停住 TCP，等 WS 排空了再恢复
    if (ws.bufferedAmount > highWaterMark) {
      tcp.pause()
      resumeWhenDrained()
    }
  })

  // WS → TCP
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (closed) return
    // 隧道只传二进制；收到文本帧说明对面不是隧道（或混了控制帧），直接断，别猜。
    if (!isBinary) {
      finish('收到非二进制帧，隧道只承载裸字节')
      return
    }
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer)
    options.onBytes?.('down', buffer.length)
    // TCP 内核缓冲满了：暂停 WS 上行，等 drain 再恢复
    if (!tcp.write(buffer)) {
      ws.pause()
      tcp.once('drain', () => {
        if (!closed) ws.resume()
      })
    }
  })

  tcp.on('close', () => finish('本地连接已关闭'))
  tcp.on('end', () => finish('本地连接已结束'))
  tcp.on('error', (error: Error) => {
    options.onError?.(error)
    finish(`本地连接出错：${error.message}`)
  })
  ws.on('close', () => finish('到 NAS 的连接已关闭'))
  ws.on('error', (error?: Error) => {
    if (error) options.onError?.(error)
    finish(`到 NAS 的连接出错：${error?.message ?? '未知'}`)
  })

  return () => finish('调用方主动停止')
}

/** 给 `net.Socket` 加 keepalive：唯一正确的「连接还活着吗」判据（不做应用层空闲超时）。 */
export function keepAlive(socket: net.Socket, delayMs = 60_000): void {
  socket.setKeepAlive(true, delayMs)
}
