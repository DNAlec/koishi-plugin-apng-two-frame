import { Context } from 'koishi'
import './ffmpeg'
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePngFrames, PngAnimationFrame } from './apng'
import { DebugLog, ImageInputError } from './image'

export interface VideoConvertOptions {
  /** 允许处理的最长视频时长（秒）。 */
  maxDuration: number
  /** 目标抽帧帧率；若会超过 maxFrames 则自动降低。 */
  fps: number
  /** 最多写入 APNG 的帧数。 */
  maxFrames: number
  /** 输出画布任一边的最大像素数，只缩小不放大。 */
  maxDimension: number
  /** 时长超过上限时按时长切片，输出多张 APNG。 */
  splitOnOverflow?: boolean
  /** 每张切片都以整个视频的第一帧作为自己的第一帧，用作缩略图。 */
  shareThumbnail?: boolean
}

export interface VideoSegment {
  start: number
  length: number
}

const thumbnailDelay = { delayNumerator: 10, delayDenominator: 1000 }

export function parseFfmpegDuration(stderr: string) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!match) return
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

export function hasFfmpegVideoStream(stderr: string) {
  return /Stream #.+: Video:/i.test(stderr)
}

export function chooseVideoFps(duration: number | undefined, fps: number, maxFrames: number) {
  if (!duration || duration <= 0) return fps
  return Math.min(fps, maxFrames / duration)
}

export function formatFps(fps: number) {
  return String(Number(fps.toFixed(4)))
}

export function splitVideoSegments(duration: number, maxDuration: number): VideoSegment[] {
  if (!(duration > 0) || !(maxDuration > 0)) return [{ start: 0, length: Math.max(duration, 0) }]
  const segments: VideoSegment[] = []
  let start = 0
  while (start < duration - 1e-6) {
    segments.push({ start, length: Math.min(maxDuration, duration - start) })
    start += maxDuration
  }
  return segments.length ? segments : [{ start: 0, length: duration }]
}

function delayFromFps(fps: number) {
  return Math.max(1, Math.round(1000 / fps))
}

function scaleFilter(maxDimension: number) {
  return `scale=min(iw\\,${maxDimension}):min(ih\\,${maxDimension}):force_original_aspect_ratio=decrease:flags=lanczos`
}

function configurePngOutput(builder: { outputOption(...option: string[]): unknown }, filter: string) {
  builder.outputOption('-an')
  builder.outputOption('-vf', filter)
  builder.outputOption('-f', 'image2')
  builder.outputOption('-c:v', 'png')
  builder.outputOption('-pix_fmt', 'rgba')
}

async function readPngSequence(directory: string, prefix: string) {
  const names = (await readdir(directory))
    .filter(name => name.startsWith(prefix) && name.endsWith('.png'))
    .sort()
  const frames = await Promise.all(names.map(name => readFile(join(directory, name))))
  await Promise.all(names.map(name => unlink(join(directory, name)).catch(() => {})))
  return frames
}

/**
 * 使用 Koishi 注入的 ffmpeg 服务把视频抽成 PNG 序列，再编码为循环 APNG。
 * 时长超限且开启 splitOnOverflow 时，按 maxDuration 切片并返回多张。
 */
export async function createApngsFromVideo(ctx: Context, input: Buffer, options: VideoConvertOptions, debug: DebugLog = () => {}) {
  if (!ctx.ffmpeg) throw new ImageInputError('将视频转为 APNG 需要启用 ffmpeg 服务')

  const directory = await mkdtemp(join(tmpdir(), 'koishi-apng-video-'))
  const source = join(directory, 'input')
  try {
    await writeFile(source, input)
    debug('开始探测视频', { bytes: input.length })
    const info = (await ctx.ffmpeg.builder().input(source).run('info')).toString()
    debug('ffmpeg 探测输出', { info })
    if (!hasFfmpegVideoStream(info)) throw new ImageInputError('没有找到视频画面，请发送包含画面的视频')

    const duration = parseFfmpegDuration(info)
    const overLimit = duration !== undefined && duration > options.maxDuration + 0.1
    if (overLimit && !options.splitOnOverflow) {
      throw new ImageInputError(`视频时长不能超过 ${options.maxDuration} 秒`)
    }

    const segments = overLimit
      ? splitVideoSegments(duration, options.maxDuration)
      : [{ start: 0, length: duration ?? 0 }]
    const useThumbnail = Boolean(options.shareThumbnail && segments.length > 1)
    debug('视频分段', { duration, overLimit, segments, useThumbnail })

    let thumbnail: Buffer | undefined
    if (useThumbnail) {
      const thumbPath = join(directory, 'thumb.png')
      const builder = ctx.ffmpeg.builder().input(source)
      builder.outputOption('-frames:v', '1')
      builder.outputOption('-update', '1')
      configurePngOutput(builder, scaleFilter(options.maxDimension))
      try {
        await builder.run('file', thumbPath)
        thumbnail = await readFile(thumbPath)
      } catch (error) {
        debug('提取视频封面帧失败', error)
        throw new ImageInputError('视频封面帧提取失败')
      }
    }

    const outputs: Buffer[] = []
    for (const [index, segment] of segments.entries()) {
      const fps = chooseVideoFps(segment.length || duration, options.fps, options.maxFrames)
      const fpsText = formatFps(fps)
      const prefix = `seg${index}_`
      const pattern = join(directory, `${prefix}%04d.png`)
      const filter = `fps=${fpsText},${scaleFilter(options.maxDimension)}`
      debug('开始抽取视频帧', { index, segment, fps: fpsText, filter })

      const builder = ctx.ffmpeg.builder().input(source)
      if (overLimit) {
        builder.outputOption('-ss', String(segment.start))
        builder.outputOption('-t', String(segment.length))
      }
      builder.outputOption('-frames:v', String(options.maxFrames))
      configurePngOutput(builder, filter)
      try {
        await builder.run('file', pattern)
      } catch (error) {
        debug('ffmpeg 抽帧失败', { index, error })
        throw new ImageInputError('视频解码或抽帧失败')
      }

      const pngs = await readPngSequence(directory, prefix)
      if (!pngs.length) {
        debug('分段没有提取到画面帧', { index, segment })
        continue
      }

      const delayNumerator = delayFromFps(fps)
      const frames: PngAnimationFrame[] = pngs.map(data => ({
        data,
        delayNumerator,
        delayDenominator: 1000,
      }))
      if (thumbnail) frames.unshift({ data: thumbnail, ...thumbnailDelay })
      outputs.push(encodePngFrames(frames))
    }

    if (!outputs.length) throw new ImageInputError('没有从视频中提取到画面帧')
    debug('视频 APNG 已编码', { count: outputs.length })
    return outputs
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function createApngFromVideo(ctx: Context, input: Buffer, options: VideoConvertOptions, debug: DebugLog = () => {}) {
  const outputs = await createApngsFromVideo(ctx, input, options, debug)
  return outputs[0]
}
