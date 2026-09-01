import { Context, h, Session } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import './ffmpeg'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeTwoFramePngs } from './apng'

export type ImageSendMode = 'auto' | 'file' | 'base64'

export interface ImageSendOptions {
  mode: ImageSendMode
  /** auto 模式下超过该 KiB 改用临时文件发送。 */
  thresholdKiB: number
  /** 超过该字节数改为以文件附件发送；0 表示不启用。 */
  fileThresholdBytes: number
}

export class ImageInputError extends Error {}

function sizeError(maxBytes: number, kind: string) {
  return new ImageInputError(`${kind}文件超过 ${(maxBytes / 1024 / 1024).toFixed(1)} MiB 限制`)
}

export type DebugLog = (message: string, extra?: unknown) => void

function summarizeUrl(url: string) {
  if (url.startsWith('data:') && url.length > 64) return `${url.slice(0, 48)}...(${url.length} chars)`
  return url
}

export async function downloadImage(ctx: Context, url: string, maxBytes: number, debug: DebugLog = () => {}) {
  return downloadBytes(ctx, url, maxBytes, debug, '图片', 30_000)
}

export async function downloadVideo(ctx: Context, url: string, maxBytes: number, debug: DebugLog = () => {}) {
  return downloadBytes(ctx, url, maxBytes, debug, '视频', 60_000)
}

function shouldSendAsFile(output: Buffer, options: ImageSendOptions) {
  if (options.mode === 'file') return true
  if (options.mode === 'base64') return false
  return output.length >= options.thresholdKiB * 1024
}

function shouldSendAsAttachment(output: Buffer, options: ImageSendOptions) {
  return options.fileThresholdBytes > 0 && output.length > options.fileThresholdBytes
}

interface PreparedPng {
  element: h
  notice?: string
  directory?: string
}

function scheduleSendCleanup(directory?: string) {
  if (!directory) return
  // 适配器可能在 send 返回后仍异步读取文件，延迟删除。
  // unref：不要因为这个清理定时器而拖住进程退出。
  setTimeout(() => {
    void rm(directory, { recursive: true, force: true })
  }, 60_000).unref()
}

async function preparePngMessage(output: Buffer, options: ImageSendOptions, debug: DebugLog, asImageOnly = false): Promise<PreparedPng> {
  // 合并转发节点里不能用 file 元素：OneBot 会立刻 uploadGroupFile，把该张从图转发里拆出去。
  const asAttachment = !asImageOnly && shouldSendAsAttachment(output, options)
  if (!asAttachment && !shouldSendAsFile(output, options)) {
    debug('以 base64 发送图片', { bytes: output.length, mode: options.mode })
    return { element: h.image(output, 'image/png') }
  }

  const directory = await mkdtemp(join(tmpdir(), 'koishi-apng-send-'))
  const file = join(directory, 'apng.png')
  await writeFile(file, output)
  const src = pathToFileURL(file).href
  debug(asAttachment ? '以文件附件发送' : '以临时文件发送图片', {
    file,
    src,
    bytes: output.length,
    mode: options.mode,
    fileThresholdBytes: options.fileThresholdBytes,
  })
  if (asAttachment) {
    const sizeMiB = (output.length / 1024 / 1024).toFixed(1)
    return {
      element: h('file', { src, filename: 'apng.png' }),
      notice: `生成的 APNG 为 ${sizeMiB} MiB，已改为文件发送。`,
      directory,
    }
  }
  return { element: h.image(src), directory }
}

/**
 * 发送 PNG/APNG。大图走 base64 会把整段数据塞进 OneBot WebSocket，容易超时；
 * 改为写入临时文件后以 file:// 发送，让协议端直接读本地文件。
 * 超过 fileThresholdBytes 时改为文件附件，而不是聊天图片。
 * 协议端需要能访问 Koishi 主机上的临时目录（同机或共享挂载）。
 */
export async function sendPngImage(session: Session, output: Buffer, options: ImageSendOptions, debug: DebugLog = () => {}) {
  const prepared = await preparePngMessage(output, options, debug)
  try {
    if (prepared.notice) await session.send(prepared.notice)
    await session.send(prepared.element)
  } finally {
    scheduleSendCleanup(prepared.directory)
  }
}

/**
 * 发送多张 APNG。mergeForward 且数量大于 1 时打成一条合并转发，避免刷屏；
 * 平台不支持或发送失败时退回逐条发送。
 */
export async function sendPngImages(session: Session, outputs: Buffer[], options: ImageSendOptions, debug: DebugLog = () => {}, mergeForward = false) {
  if (!outputs.length) return
  if (!mergeForward || outputs.length === 1) {
    for (const output of outputs) await sendPngImage(session, output, options, debug)
    return
  }

  const prepared: PreparedPng[] = []
  try {
    for (const output of outputs) prepared.push(await preparePngMessage(output, options, debug, true))
    const botId = String(session.selfId ?? session.bot?.selfId ?? '')
    const botName = session.bot?.user?.name || 'APNG'
    const nodes = prepared.map(item => h('message',
      h('author', { id: botId, name: botName, avatar: session.bot?.user?.avatar }),
      item.element,
    ))
    debug('以合并转发发送多张 APNG', { count: prepared.length })
    await session.send(h('message', { forward: true }, ...nodes))
  } catch (error) {
    debug('合并转发失败，改为逐条发送', error)
    for (const item of prepared) {
      try {
        if (item.notice) await session.send(item.notice)
        await session.send(item.element)
      } catch (sendError) {
        debug('逐条补发失败', sendError)
      }
    }
  } finally {
    for (const item of prepared) scheduleSendCleanup(item.directory)
  }
}

async function downloadBytes(ctx: Context, url: string, maxBytes: number, debug: DebugLog, kind: string, timeout: number) {
  // Koishi/Satori 可能把消息资源表示成 data URL。先按 base64 长度预估，
  // 可避免在已知超限时仍分配一块巨大的解码 Buffer。
  const dataMatch = /^data:([\w/.+-]+);base64,(.*)$/s.exec(url)
  if (dataMatch) {
    const padding = dataMatch[2].endsWith('==') ? 2 : dataMatch[2].endsWith('=') ? 1 : 0
    const approximateSize = Math.floor(dataMatch[2].length * 3 / 4) - padding
    debug('下载 data URL', { mime: dataMatch[1], approximateSize, maxBytes, kind })
    if (approximateSize > maxBytes) throw sizeError(maxBytes, kind)
    const data = Buffer.from(dataMatch[2], 'base64')
    if (data.length > maxBytes) throw sizeError(maxBytes, kind)
    debug('data URL 解码完成', { bytes: data.length })
    return data
  }

  // 用户输入的普通文本 URL 不会进入此函数；这里只下载适配器提供的图片/视频地址。
  // file: 等本地协议不被接受，避免消息触发任意本地文件读取。
  if (!/^https?:\/\//i.test(url)) throw new ImageInputError(`不支持的${kind}地址`)
  debug('开始 HTTP 下载', { url: summarizeUrl(url), maxBytes, kind })
  try {
    const response = await ctx.http(url, {
      responseType: 'stream',
      timeout,
    })
    // Content-Length 只能作为快速拒绝依据，服务端可能不提供或谎报，
    // 因此下面仍需在读取每个数据块时累计真实字节数。
    const declaredSize = Number(response.headers.get('content-length'))
    debug('HTTP 响应头', {
      status: (response as { status?: number }).status,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
    })
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw sizeError(maxBytes, kind)

    const reader = response.data.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel()
          throw sizeError(maxBytes, kind)
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    debug('HTTP 下载完成', { bytes: size })
    return Buffer.concat(chunks, size)
  } catch (error) {
    debug('HTTP 下载失败', error)
    throw error
  }
}

function imageMime(input: Buffer) {
  if (input.length >= 6) {
    const header = input.subarray(0, 6).toString('latin1')
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (input.length >= 8 && input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'image/jpeg'
  if (input.length >= 12 && input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (input.length >= 2 && input.toString('ascii', 0, 2) === 'BM') return 'image/bmp'
  return 'application/octet-stream'
}

async function staticBrowserInput(ctx: Context, input: Buffer) {
  const mime = imageMime(input)
  if (mime !== 'image/gif') return { data: input.toString('base64'), mime }
  if (!ctx.ffmpeg) throw new ImageInputError('GIF 图片需要启用 ffmpeg 服务，或请先转换为 PNG/JPEG')

  const directory = await mkdtemp(join(tmpdir(), 'koishi-apng-'))
  const source = join(directory, 'input.gif')
  const output = join(directory, 'frame.png')
  try {
    await writeFile(source, input)
    const builder = ctx.ffmpeg.builder().input(source)
    builder.outputOption('-vframes', '1')
    builder.outputOption('-f', 'image2')
    builder.outputOption('-c:v', 'png')
    builder.outputOption('-update', '1')
    builder.outputOption('-pix_fmt', 'rgba')
    await builder.run('file', output)
    return { data: (await readFile(output)).toString('base64'), mime: 'image/png' }
  } catch (error) {
    if (error instanceof ImageInputError) throw error
    throw new ImageInputError('GIF 第一帧提取失败')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

interface CanvasResult {
  first: string
  second: string
}

export async function createTwoFrameApng(ctx: Context, firstInput: Buffer, secondInput: Buffer, maxDimension: number) {
  const [first, second] = await Promise.all([
    staticBrowserInput(ctx, firstInput),
    staticBrowserInput(ctx, secondInput),
  ])
  const page = await ctx.puppeteer.page()
  try {
    const result = await page.evaluate(async ({ first, second, maxDimension }) => {
      function decodeBase64(value: string) {
        const binary = atob(value)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
        return bytes
      }

      async function loadImage(source: { data: string, mime: string }): Promise<ImageBitmap | HTMLImageElement> {
        const blob = new Blob([decodeBase64(source.data)], { type: source.mime })
        if (typeof createImageBitmap === 'function') return createImageBitmap(blob, { imageOrientation: 'from-image' })
        return new Promise((resolve, reject) => {
          const url = URL.createObjectURL(blob)
          const image = new Image()
          image.onload = () => {
            URL.revokeObjectURL(url)
            resolve(image)
          }
          image.onerror = () => {
            URL.revokeObjectURL(url)
            reject(new Error('图片损坏或格式不受支持'))
          }
          image.src = url
        })
      }

      function dimensions(image: ImageBitmap | HTMLImageElement) {
        return {
          width: 'naturalWidth' in image ? image.naturalWidth : image.width,
          height: 'naturalHeight' in image ? image.naturalHeight : image.height,
        }
      }

      function checkSize(image: ImageBitmap | HTMLImageElement) {
        const size = dimensions(image)
        if (!size.width || !size.height) throw new Error('无法读取图片尺寸')
        if (size.width > maxDimension || size.height > maxDimension) {
          throw new Error(`图片宽高不能超过 ${maxDimension} px`)
        }
        return size
      }

      const [firstImage, secondImage] = await Promise.all([loadImage(first), loadImage(second)])
      try {
        const firstSize = checkSize(firstImage)
        const secondSize = checkSize(secondImage)
        const makeCanvas = () => {
          const canvas = document.createElement('canvas')
          canvas.width = secondSize.width
          canvas.height = secondSize.height
          return canvas
        }

        // 第二张图决定画布，保留透明通道且不缩放。
        const secondCanvas = makeCanvas()
        secondCanvas.getContext('2d')!.drawImage(secondImage, 0, 0)

        // 第一张图保持比例、只缩小不放大，并在白色画布上居中。
        const firstCanvas = makeCanvas()
        const context = firstCanvas.getContext('2d')!
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, firstCanvas.width, firstCanvas.height)
        const scale = Math.min(1, firstCanvas.width / firstSize.width, firstCanvas.height / firstSize.height)
        const width = Math.max(1, Math.round(firstSize.width * scale))
        const height = Math.max(1, Math.round(firstSize.height * scale))
        const x = Math.round((firstCanvas.width - width) / 2)
        const y = Math.round((firstCanvas.height - height) / 2)
        context.drawImage(firstImage, x, y, width, height)

        const stripPrefix = (url: string) => url.slice(url.indexOf(',') + 1)
        return {
          first: stripPrefix(firstCanvas.toDataURL('image/png')),
          second: stripPrefix(secondCanvas.toDataURL('image/png')),
        }
      } finally {
        if ('close' in firstImage) firstImage.close()
        if ('close' in secondImage) secondImage.close()
      }
    }, { first, second, maxDimension }) as CanvasResult
    return encodeTwoFramePngs(Buffer.from(result.first, 'base64'), Buffer.from(result.second, 'base64'))
  } catch (error) {
    if (error instanceof ImageInputError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/图片|px/.test(message)) throw new ImageInputError(message)
    throw new ImageInputError('图片解码或处理失败')
  } finally {
    await page.close()
  }
}
