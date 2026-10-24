import { deflateSync } from 'node:zlib'

export interface RgbaFrame {
  /** 帧的画布宽度（像素）。 */
  width: number
  /** 帧的画布高度（像素）。 */
  height: number
  /** 从左到右、从上到下排列的 8-bit RGBA 像素，每个像素占 4 字节。 */
  data: Buffer
}

// PNG 为每个 chunk 保存 CRC-32。查表法比逐位计算更快，而表只需初始化一次。
let crcTable: Uint32Array | undefined

function getCrcTable() {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    crcTable[index] = value >>> 0
  }
  return crcTable
}

export function crc32(data: Buffer) {
  // PNG 使用标准 IEEE CRC-32：初值和最终异或值都是 0xffffffff。
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function uint32(value: number) {
  // PNG/APNG 的所有多字节整数都使用网络字节序（大端序）。
  const data = Buffer.allocUnsafe(4)
  data.writeUInt32BE(value >>> 0)
  return data
}

function chunk(type: string, data: Buffer = Buffer.alloc(0)) {
  // PNG chunk 布局：data length(4) + type(4) + data(n) + CRC(4)。
  // CRC 的计算范围只包含 type 与 data，不包含 length 和 CRC 本身。
  const name = Buffer.from(type, 'ascii')
  const checksum = Buffer.allocUnsafe(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([uint32(data.length), name, data, checksum])
}

function frameControl(sequence: number, width: number, height: number, numerator: number, denominator: number) {
  // fcTL 固定为 26 字节：序号、尺寸、偏移、延时分数、处置方式和混合方式。
  const data = Buffer.alloc(26)
  data.writeUInt32BE(sequence, 0)
  data.writeUInt32BE(width, 4)
  data.writeUInt32BE(height, 8)
  // Buffer.alloc 已将 x/y 偏移、dispose_op 和 blend_op 置零：
  // 两帧都覆盖完整画布，不清除上一帧，并以 SOURCE 模式直接替换像素。
  data.writeUInt16BE(numerator, 20)
  data.writeUInt16BE(denominator, 22)
  return chunk('fcTL', data)
}

interface ParsedPng {
  ihdr: Buffer
  width: number
  height: number
  imageData: Buffer
}

function parseStaticPng(input: Buffer): ParsedPng {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (input.length < signature.length || !input.subarray(0, 8).equals(signature)) {
    throw new Error('不是有效的 PNG')
  }

  let offset = 8
  let ihdr: Buffer | undefined
  const idat: Buffer[] = []
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > input.length) throw new Error('PNG 数据不完整')
    const type = input.toString('ascii', offset + 4, dataStart)
    if (type === 'IHDR') ihdr = input.subarray(dataStart, dataEnd)
    if (type === 'IDAT') idat.push(input.subarray(dataStart, dataEnd))
    offset = dataEnd + 4
    if (type === 'IEND') break
  }

  if (ihdr?.length !== 13 || !idat.length) throw new Error('PNG 缺少必要数据')
  return {
    ihdr,
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    imageData: Buffer.concat(idat),
  }
}

export interface PngAnimationFrame {
  /** 完整的静态 PNG 文件。 */
  data: Buffer
  /** APNG 延时分子，实际时长为 numerator / denominator 秒。 */
  delayNumerator: number
  /** APNG 延时分母。 */
  delayDenominator: number
}

function delay16(value: number) {
  // fcTL 的 delay_num / delay_den 都是 16 位无符号整数。
  return Math.min(65535, Math.max(0, Math.round(value)))
}

/**
 * 将若干同尺寸静态 PNG 组合为 APNG。
 *
 * 复用每张 PNG 自带的 IDAT zlib 数据流，避免再次压缩像素。
 * 第一帧写入 IDAT，后续帧写入 fdAT；播放次数为 0 表示无限循环。
 */
export function encodePngFrames(frames: PngAnimationFrame[], plays = 0) {
  if (!frames.length) throw new Error('至少需要一帧')
  const parsed = frames.map((frame) => ({
    ...parseStaticPng(frame.data),
    delayNumerator: delay16(frame.delayNumerator),
    delayDenominator: delay16(frame.delayDenominator),
  }))
  const first = parsed[0]
  for (const frame of parsed) {
    if (frame.width !== first.width || frame.height !== first.height) throw new Error('各帧尺寸必须一致')
    // 各帧共用同一 IHDR，因此位深、颜色类型、压缩、滤波及交错方式也必须一致。
    if (!frame.ihdr.subarray(8).equals(first.ihdr.subarray(8))) throw new Error('各帧 PNG 格式必须一致')
  }

  const actl = Buffer.alloc(8)
  actl.writeUInt32BE(parsed.length, 0)
  actl.writeUInt32BE(plays >>> 0, 4)
  const parts = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', first.ihdr),
    chunk('acTL', actl),
  ]

  // fcTL 与 fdAT 共用一套递增序号；默认图像的 IDAT 本身不占序号。
  let sequence = 0
  for (let index = 0; index < parsed.length; index++) {
    const frame = parsed[index]
    parts.push(frameControl(sequence++, frame.width, frame.height, frame.delayNumerator, frame.delayDenominator))
    if (index === 0) {
      parts.push(chunk('IDAT', frame.imageData))
    } else {
      parts.push(chunk('fdAT', Buffer.concat([uint32(sequence++), frame.imageData])))
    }
  }
  parts.push(chunk('IEND'))
  return Buffer.concat(parts)
}

/**
 * 将浏览器 Canvas 导出的两张同尺寸 PNG 组合为两帧 APNG。
 *
 * Canvas 已经完成解码、方向校正、缩放和颜色转换；这里复用 PNG 自带的
 * zlib 数据流，避免把大块 RGBA 像素通过 Puppeteer 协议传回 Node.js。
 */
export function encodeTwoFramePngs(firstInput: Buffer, secondInput: Buffer) {
  return encodePngFrames([
    { data: firstInput, delayNumerator: 10, delayDenominator: 1000 },
    { data: secondInput, delayNumerator: 999, delayDenominator: 1 },
  ])
}

/** 拆分本插件生成的两帧图片；不接受视频动画或需要帧合成的 APNG。 */
export function splitTwoFrameApng(input: Buffer, maxDimension = 16384): [Buffer, Buffer] {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (input.length < 8 || !input.subarray(0, 8).equals(signature)) {
    throw new Error('请发送本插件生成的两帧 APNG；静态图片无法恢复里图。')
  }
  const expected = ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']
  const chunks: Buffer[] = []
  let offset = 8
  for (const type of expected) {
    if (offset + 12 > input.length) throw new Error('APNG 数据不完整。')
    const length = input.readUInt32BE(offset)
    const end = offset + 8 + length
    if (end + 4 > input.length) throw new Error('APNG 数据不完整。')
    if (input.toString('ascii', offset + 4, offset + 8) !== type) {
      throw new Error('仅支持本插件生成的两帧图片，不支持视频 APNG 或其他结构。')
    }
    if (crc32(input.subarray(offset + 4, end)) !== input.readUInt32BE(end)) {
      throw new Error('APNG 校验失败，文件可能已损坏。')
    }
    chunks.push(input.subarray(offset + 8, end))
    offset = end + 4
  }
  if (offset !== input.length) throw new Error('APNG 包含多余数据。')
  const [ihdr, actl, firstControl, firstData, secondControl, secondData, iend] = chunks
  if (ihdr.length !== 13 || actl.length !== 8 || firstControl.length !== 26
    || secondControl.length !== 26 || !firstData.length || secondData.length <= 4 || iend.length) {
    throw new Error('APNG 数据结构无效。')
  }
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  if (!width || !height || width > maxDimension || height > maxDimension) {
    throw new Error(`图片尺寸超过限制或无效（最大 ${maxDimension} 像素）。`)
  }
  if (!ihdr.subarray(8).equals(Buffer.from([8, 6, 0, 0, 0]))
    || actl.readUInt32BE(0) !== 2 || actl.readUInt32BE(4) !== 0
    || secondData.readUInt32BE(0) !== 2) {
    throw new Error('仅支持本插件生成的两帧图片。')
  }
  for (const [index, control] of [firstControl, secondControl].entries()) {
    if (control.readUInt32BE(0) !== index || control.readUInt32BE(4) !== width
      || control.readUInt32BE(8) !== height || control.readUInt32BE(12) !== 0
      || control.readUInt32BE(16) !== 0 || control[24] !== 0 || control[25] !== 0
      || control.readUInt16BE(20) !== (index === 0 ? 10 : 999)
      || control.readUInt16BE(22) !== (index === 0 ? 1000 : 1)) {
      throw new Error('仅支持本插件生成的两帧图片，不支持视频 APNG 或其他帧设置。')
    }
  }
  // 去掉 fdAT 的序号，将原始压缩流重新封装为静态 PNG，不重新编码像素。
  const png = (data: Buffer) => Buffer.concat([
    signature, chunk('IHDR', ihdr), chunk('IDAT', data), chunk('IEND'),
  ])
  return [png(firstData), png(secondData.subarray(4))]
}

function compressRgba(frame: RgbaFrame) {
  const rowBytes = frame.width * 4
  const expected = rowBytes * frame.height
  if (frame.data.length !== expected) {
    throw new Error(`RGBA 数据长度错误：期望 ${expected}，实际 ${frame.data.length}`)
  }
  // PNG 在每行像素前要求一个 filter-method 字节。这里统一使用 filter 0（None），
  // 牺牲少量压缩率换取确定、易验证的编码结果，再整体交给 zlib 压缩。
  const scanlines = Buffer.allocUnsafe((rowBytes + 1) * frame.height)
  for (let y = 0; y < frame.height; y++) {
    const outputOffset = y * (rowBytes + 1)
    scanlines[outputOffset] = 0
    frame.data.copy(scanlines, outputOffset + 1, y * rowBytes, (y + 1) * rowBytes)
  }
  return deflateSync(scanlines)
}

/**
 * 将两张同尺寸 RGBA 图像编码成符合 APNG 规范的两帧文件。
 *
 * 第一帧持续 10ms，用作聊天客户端可能抓取的缩略图；第二帧持续 999 秒，
 * 让用户点开后几乎始终看到第二张图。动画无限循环，因此 999 秒后仍会短暂回到首帧。
 */
export function encodeTwoFrameApng(first: RgbaFrame, second: RgbaFrame) {
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error('两帧尺寸必须一致')
  }
  if (!first.width || !first.height) throw new Error('图片尺寸不能为空')

  // IHDR 声明整个 APNG 的公共画布。两帧均使用 8-bit、真彩色 RGBA（color type 6）。
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(first.width, 0)
  ihdr.writeUInt32BE(first.height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA

  // acTL：共 2 帧；播放次数为 0，按 APNG 规范表示无限循环。
  const actl = Buffer.alloc(8)
  actl.writeUInt32BE(2, 0)
  actl.writeUInt32BE(0, 4)

  // 默认图像（第一帧）的像素存入普通 PNG 的 IDAT；后续帧存入 fdAT。
  // fdAT 的前 4 字节也是动画序号，所以第二帧像素前写入序号 2。
  const secondImage = compressRgba(second)
  const firstImage = compressRgba(first)
  const fdat = Buffer.concat([uint32(2), secondImage])

  return Buffer.concat([
    // PNG 固定 8 字节文件签名。
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('acTL', actl),
    frameControl(0, first.width, first.height, 10, 1000), // 10 / 1000 秒
    chunk('IDAT', firstImage),
    frameControl(1, second.width, second.height, 999, 1), // 999 / 1 秒
    chunk('fdAT', fdat),
    chunk('IEND'),
  ])
}
