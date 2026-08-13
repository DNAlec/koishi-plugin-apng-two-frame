import { Context } from 'koishi'
import {} from 'koishi-plugin-ffmpeg'
import {} from 'koishi-plugin-puppeteer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeTwoFramePngs } from './apng'

export class ImageInputError extends Error {}

function sizeError(maxBytes: number) {
  return new ImageInputError(`图片文件超过 ${(maxBytes / 1024 / 1024).toFixed(1)} MiB 限制`)
}

export async function downloadImage(ctx: Context, url: string, maxBytes: number) {
  // Koishi/Satori 可能把消息图片表示成 data URL。先按 base64 长度预估，
  // 可避免在已知超限时仍分配一块巨大的解码 Buffer。
  const dataMatch = /^data:([\w/.+-]+);base64,(.*)$/s.exec(url)
  if (dataMatch) {
    const padding = dataMatch[2].endsWith('==') ? 2 : dataMatch[2].endsWith('=') ? 1 : 0
    const approximateSize = Math.floor(dataMatch[2].length * 3 / 4) - padding
    if (approximateSize > maxBytes) throw sizeError(maxBytes)
    const data = Buffer.from(dataMatch[2], 'base64')
    if (data.length > maxBytes) throw sizeError(maxBytes)
    return data
  }

  // 用户输入的普通文本 URL 不会进入此函数；这里只下载适配器提供的图片/头像地址。
  // file: 等本地协议不被接受，避免消息触发任意本地文件读取。
  if (!/^https?:\/\//i.test(url)) throw new ImageInputError('不支持的图片地址')
  const response = await ctx.http(url, {
    responseType: 'stream',
    timeout: 30_000,
  })
  // Content-Length 只能作为快速拒绝依据，服务端可能不提供或谎报，
  // 因此下面仍需在读取每个数据块时累计真实字节数。
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw sizeError(maxBytes)

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
        throw sizeError(maxBytes)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
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
