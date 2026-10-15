import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { pumpSocket, type SocketLike, type WebSocketLike } from './tunnel-pump.js'

/** 假的 TCP 侧：记录写进去的字节，能手动触发事件，能观察 pause/resume。 */
class FakeSocket extends EventEmitter implements SocketLike {
  written: Buffer[] = []
  paused = false
  destroyed = false
  /** 让 write 返回 false（模拟内核缓冲满） */
  writeBackpressure = false
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }
  override once(event: string, listener: (...args: never[]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void)
  }
  pause(): void {
    this.paused = true
  }
  resume(): void {
    this.paused = false
  }
  write(chunk: Buffer): boolean {
    this.written.push(chunk)
    return !this.writeBackpressure
  }
  destroy(): void {
    this.destroyed = true
  }
}

class FakeWebSocket implements WebSocketLike {
  sent: Buffer[] = []
  bufferedAmount = 0
  readyState = 1
  paused = false
  closed = false
  private readonly emitter = new EventEmitter()
  send(data: Buffer): void {
    this.sent.push(data)
    this.bufferedAmount += data.length
  }
  close(): void {
    this.closed = true
  }
  pause(): void {
    this.paused = true
  }
  resume(): void {
    this.paused = false
  }
  on(event: string, listener: (...args: never[]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
    return this
  }
  /** 测试用：模拟对面发来一帧 */
  recv(data: Buffer, isBinary = true): void {
    this.emitter.emit('message', data, isBinary)
  }
  emit(event: string, ...args: unknown[]): void {
    this.emitter.emit(event, ...args)
  }
}

function connect(socket = new FakeSocket(), ws = new FakeWebSocket()) {
  const closes: string[] = []
  const bytes: Array<['up' | 'down', number]> = []
  const stop = pumpSocket(socket, ws, {
    onClose: (reason) => closes.push(reason),
    onBytes: (direction, n) => bytes.push([direction, n]),
  })
  return { socket, ws, closes, bytes, stop }
}

describe('pumpSocket', () => {
  it('把 TCP 的字节按二进制帧发到 WS，把 WS 的字节写回 TCP', () => {
    const { socket, ws, bytes } = connect()
    socket.emit('data', Buffer.from('hello'))
    expect(Buffer.concat(ws.sent).toString()).toBe('hello')

    ws.recv(Buffer.from('world'))
    expect(Buffer.concat(socket.written).toString()).toBe('world')

    expect(bytes).toEqual([
      ['up', 5],
      ['down', 5],
    ])
  })

  it('二进制原样通过：含 NUL 与 0xFF 的字节不被破坏', () => {
    const { socket, ws } = connect()
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x00, 0xde, 0xad, 0xbe, 0xef])
    ws.recv(payload)
    expect(Buffer.concat(socket.written).equals(payload)).toBe(true)
  })

  it('收到文本帧就断开：隧道只承载裸字节，不猜语义', () => {
    const { ws, closes } = connect()
    ws.recv(Buffer.from('not-a-tunnel'), false)
    expect(closes).toHaveLength(1)
    expect(closes[0]).toContain('非二进制帧')
  })

  it('WS 堆了太多字节就暂停 TCP，排空后恢复（背压）', () => {
    const { socket, ws } = connect()
    ws.bufferedAmount = 2 * 1024 * 1024
    socket.emit('data', Buffer.from('x'))
    expect(socket.paused).toBe(true)

    ws.bufferedAmount = 0
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(socket.paused).toBe(false)
        resolve()
      }, 120)
    })
  })

  it('TCP 写不动就暂停 WS 上行，drain 后恢复', () => {
    const { socket, ws } = connect()
    socket.writeBackpressure = true
    ws.recv(Buffer.from('big'))
    expect(ws.paused).toBe(true)

    socket.emit('drain')
    expect(ws.paused).toBe(false)
  })

  it('任一侧关闭都只触发一次 onClose', () => {
    const { socket, ws, closes } = connect()
    socket.emit('close')
    ws.emit('close')
    expect(closes).toHaveLength(1)
  })

  it('stop() 之后不再搬运', () => {
    const { socket, ws, stop, closes } = connect()
    stop()
    socket.emit('data', Buffer.from('late'))
    expect(ws.sent).toHaveLength(0)
    expect(closes).toHaveLength(1)
  })
})
