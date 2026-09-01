import type { Readable } from 'node:stream'

/**
 * 只依赖 Koishi 的 ffmpeg 服务接口，不绑定具体实现插件。
 * 任意能提供 ctx.ffmpeg.builder() 的插件都可以使用。
 */
export interface FFmpegBuilder {
  input(source: string | Buffer | Readable): FFmpegBuilder
  inputOption(...option: string[]): FFmpegBuilder
  outputOption(...option: string[]): FFmpegBuilder
  run(type: 'file', path: string): Promise<void>
  run(type: 'buffer' | 'info'): Promise<Buffer>
  run(type: 'stream'): Readable
}

export interface FFmpegService {
  builder(): FFmpegBuilder
}

declare module 'koishi' {
  interface Context {
    ffmpeg?: FFmpegService
  }
}
