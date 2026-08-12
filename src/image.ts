import { Context } from 'koishi'
import sharp from 'sharp'
import { encodeTwoFrameApng, RgbaFrame } from './apng'

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

async function normalizedMetadata(input: Buffer, maxDimension: number) {
  let metadata: sharp.Metadata
  try {
    // metadata() 不会完整解压像素。先检查尺寸既能尽早拒绝超大图片，
    // 也能向用户返回明确限制，而非 libvips 的通用 pixel-limit 错误。
    // pages: 1 表示 GIF/APNG/WebP 等动图只读取第一帧。
    metadata = await sharp(input, { pages: 1 }).metadata()
  } catch {
    throw new ImageInputError('图片损坏或格式不受支持')
  }
  // autoOrient 是 sharp 根据 EXIF Orientation 计算出的显示尺寸。
  // 例如横向像素但标记旋转 90° 的手机照片，宽高会在这里互换。
  const rotated = metadata.autoOrient
  const width = rotated.width ?? metadata.width
  const height = rotated.height ?? metadata.height
  if (!width || !height) throw new ImageInputError('无法读取图片尺寸')
  if (width > maxDimension || height > maxDimension) {
    throw new ImageInputError(`图片宽高不能超过 ${maxDimension} px`)
  }
  return { width, height }
}

async function toSecondFrame(input: Buffer, maxDimension: number): Promise<RgbaFrame> {
  // 第二张图决定最终画布，除应用 EXIF 方向和统一 RGBA 色彩空间外不缩放、不裁切。
  const { width, height } = await normalizedMetadata(input, maxDimension)
  try {
    const { data, info } = await sharp(input, { pages: 1, limitInputPixels: maxDimension * maxDimension })
      .rotate() // 无参数 rotate() 表示应用 EXIF Orientation 并移除方向标记。
      .ensureAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true })
    return { width: info.width || width, height: info.height || height, data }
  } catch {
    throw new ImageInputError('图片解码失败')
  }
}

async function toFirstFrame(input: Buffer, width: number, height: number, maxDimension: number): Promise<RgbaFrame> {
  // 第一张图适配第二张图的画布：保持比例、只缩小不放大、透明区域铺成白色。
  await normalizedMetadata(input, maxDimension)
  try {
    const { data, info } = await sharp(input, { pages: 1, limitInputPixels: maxDimension * maxDimension })
      .rotate()
      .resize(width, height, {
        fit: 'contain', // 完整保留图片内容，不裁切。
        withoutEnlargement: true,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .extend({
        // 这里的零扩展用于固定 sharp 操作链的输出语义；真正不足画布的情况
        // 会在下方创建精确尺寸的白色画布并居中合成。
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .ensureAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true })

    // 当原图小于目标画布且禁止放大时，contain 可能返回小于目标的结果。
    // 此时显式创建目标画布再居中贴入，确保两帧尺寸完全相同。
    if (info.width === width && info.height === height) return { width, height, data }
    const canvas = await sharp({
      create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).composite([{ input: data, raw: { width: info.width, height: info.height, channels: 4 }, gravity: 'centre' }])
      .raw()
      .toBuffer()
    return { width, height, data: canvas }
  } catch (error) {
    if (error instanceof ImageInputError) throw error
    throw new ImageInputError('图片解码失败')
  }
}

export async function createTwoFrameApng(firstInput: Buffer, secondInput: Buffer, maxDimension: number) {
  // 必须先处理第二张图，才能知道第一张图要适配的画布尺寸。
  const second = await toSecondFrame(secondInput, maxDimension)
  const first = await toFirstFrame(firstInput, second.width, second.height, maxDimension)
  return encodeTwoFrameApng(first, second)
}
