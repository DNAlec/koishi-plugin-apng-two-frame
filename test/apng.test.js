const assert = require('node:assert/strict')
const { writeFile } = require('node:fs/promises')
const { basename, dirname, join } = require('node:path')
const { deflateSync, inflateSync } = require('node:zlib')
const test = require('node:test')
const { crc32, createTwoFrameApng, createApngFromVideo, createApngsFromVideo, encodePngFrames, encodeTwoFrameApng, encodeTwoFramePngs, splitVideoSegments } = require('../lib')

function parsePng(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const chunks = []
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    const storedCrc = buffer.readUInt32BE(offset + 8 + length)
    chunks.push({ type, data, storedCrc })
    offset += length + 12
  }
  return chunks
}

function rawRows(compressed, width, height) {
  const decoded = inflateSync(compressed)
  const stride = width * 4 + 1
  assert.equal(decoded.length, stride * height)
  const rows = []
  for (let y = 0; y < height; y++) {
    assert.equal(decoded[y * stride], 0, 'encoder should use PNG filter 0')
    rows.push(decoded.subarray(y * stride + 1, (y + 1) * stride))
  }
  return Buffer.concat(rows)
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function staticPng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND'),
  ])
}

test('encodes a valid two-frame APNG with exact timing and CRCs', () => {
  const first = { width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) }
  const second = { width: 1, height: 1, data: Buffer.from([0, 0, 255, 255]) }
  const chunks = parsePng(encodeTwoFrameApng(first, second))

  assert.deepEqual(chunks.map(chunk => chunk.type), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND'])
  for (const item of chunks) {
    assert.equal(item.storedCrc, crc32(Buffer.concat([Buffer.from(item.type), item.data])))
  }
  assert.equal(chunks[1].data.readUInt32BE(0), 2)
  assert.equal(chunks[1].data.readUInt32BE(4), 0)
  assert.deepEqual([chunks[2].data.readUInt32BE(0), chunks[4].data.readUInt32BE(0), chunks[5].data.readUInt32BE(0)], [0, 1, 2])
  assert.deepEqual([chunks[2].data.readUInt16BE(20), chunks[2].data.readUInt16BE(22)], [10, 1000])
  assert.deepEqual([chunks[4].data.readUInt16BE(20), chunks[4].data.readUInt16BE(22)], [999, 1])
  assert.deepEqual(rawRows(chunks[3].data, 1, 1), first.data)
  assert.deepEqual(rawRows(chunks[5].data.subarray(4), 1, 1), second.data)
})

test('reuses browser-generated PNG streams as two APNG frames', () => {
  const firstPixels = Buffer.from([255, 255, 255, 255, 255, 0, 0, 255])
  const secondPixels = Buffer.from([0, 0, 255, 255, 0, 255, 0, 128])
  const chunks = parsePng(encodeTwoFramePngs(
    staticPng(2, 1, firstPixels),
    staticPng(2, 1, secondPixels),
  ))
  assert.deepEqual(rawRows(chunks.find(chunk => chunk.type === 'IDAT').data, 2, 1), firstPixels)
  assert.deepEqual(rawRows(chunks.find(chunk => chunk.type === 'fdAT').data.subarray(4), 2, 1), secondPixels)
})

test('rejects mismatched browser PNG dimensions', () => {
  const pixel = Buffer.from([0, 0, 0, 255])
  assert.throws(() => encodeTwoFramePngs(staticPng(1, 1, pixel), staticPng(2, 1, Buffer.concat([pixel, pixel]))), /尺寸/)
})

test('encodes multiple PNG frames with sequential fcTL/fdAT numbers', () => {
  const pixels = [
    Buffer.from([255, 0, 0, 255]),
    Buffer.from([0, 255, 0, 255]),
    Buffer.from([0, 0, 255, 255]),
  ]
  const chunks = parsePng(encodePngFrames(pixels.map(data => ({
    data: staticPng(1, 1, data),
    delayNumerator: 125,
    delayDenominator: 1000,
  }))))
  assert.deepEqual(chunks.map(chunk => chunk.type), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND'])
  assert.equal(chunks[1].data.readUInt32BE(0), 3)
  assert.deepEqual(
    [chunks[2].data.readUInt32BE(0), chunks[4].data.readUInt32BE(0), chunks[5].data.readUInt32BE(0), chunks[6].data.readUInt32BE(0), chunks[7].data.readUInt32BE(0)],
    [0, 1, 2, 3, 4],
  )
  assert.deepEqual([chunks[2].data.readUInt16BE(20), chunks[2].data.readUInt16BE(22)], [125, 1000])
  assert.deepEqual(rawRows(chunks[3].data, 1, 1), pixels[0])
  assert.deepEqual(rawRows(chunks[5].data.subarray(4), 1, 1), pixels[1])
  assert.deepEqual(rawRows(chunks[7].data.subarray(4), 1, 1), pixels[2])
})

test('requires ffmpeg service for video input', async () => {
  await assert.rejects(() => createApngFromVideo({}, Buffer.from('not-a-video'), {
    maxDuration: 10,
    fps: 8,
    maxFrames: 48,
    maxDimension: 512,
  }), /ffmpeg/)
})

function mockFfmpeg({ info, frames, thumbnail }) {
  return {
    builder() {
      return {
        input() { return this },
        outputOption() { return this },
        async run(type, path) {
          if (type === 'info') return Buffer.from(info)
          if (type === 'file') {
            const directory = dirname(path)
            const file = basename(path)
            if (!file.includes('%04d')) {
              await writeFile(path, thumbnail || frames[0])
              return
            }
            const prefix = file.replace('%04d.png', '')
            for (let index = 0; index < frames.length; index++) {
              await writeFile(join(directory, `${prefix}${String(index + 1).padStart(4, '0')}.png`), frames[index])
            }
          }
        },
      }
    },
  }
}

test('converts probed video frames from the Koishi ffmpeg service into APNG', async () => {
  const first = staticPng(1, 1, Buffer.from([255, 0, 0, 255]))
  const second = staticPng(1, 1, Buffer.from([0, 0, 255, 255]))
  const output = await createApngFromVideo({
    ffmpeg: mockFfmpeg({
      info: 'Duration: 00:00:02.00, start: 0.000000, bitrate: 128 kb/s\nStream #0:0: Video: h264, yuv420p, 64x64, 30 fps',
      frames: [first, second],
    }),
  }, Buffer.from('fake-video'), {
    maxDuration: 10,
    fps: 8,
    maxFrames: 48,
    maxDimension: 512,
  })
  const chunks = parsePng(output)
  assert.equal(chunks[1].data.readUInt32BE(0), 2)
  assert.deepEqual(rawRows(chunks[3].data, 1, 1), Buffer.from([255, 0, 0, 255]))
  assert.deepEqual(rawRows(chunks[5].data.subarray(4), 1, 1), Buffer.from([0, 0, 255, 255]))
})

test('rejects videos longer than the configured duration', async () => {
  await assert.rejects(() => createApngFromVideo({
    ffmpeg: mockFfmpeg({
      info: 'Duration: 00:00:12.00, start: 0.000000, bitrate: 128 kb/s\nStream #0:0: Video: h264, yuv420p, 64x64, 30 fps',
      frames: [],
    }),
  }, Buffer.from('fake-video'), {
    maxDuration: 10,
    fps: 8,
    maxFrames: 48,
    maxDimension: 512,
  }), /时长/)
})

test('splits an over-limit video into duration-sized APNGs', async () => {
  assert.deepEqual(splitVideoSegments(12, 10), [
    { start: 0, length: 10 },
    { start: 10, length: 2 },
  ])
  const first = staticPng(1, 1, Buffer.from([255, 0, 0, 255]))
  const second = staticPng(1, 1, Buffer.from([0, 0, 255, 255]))
  const outputs = await createApngsFromVideo({
    ffmpeg: mockFfmpeg({
      info: 'Duration: 00:00:12.00, start: 0.000000, bitrate: 128 kb/s\nStream #0:0: Video: h264, yuv420p, 64x64, 30 fps',
      frames: [first, second],
    }),
  }, Buffer.from('fake-video'), {
    maxDuration: 10,
    fps: 8,
    maxFrames: 48,
    maxDimension: 512,
    splitOnOverflow: true,
  })
  assert.equal(outputs.length, 2)
  for (const output of outputs) {
    const chunks = parsePng(output)
    assert.equal(chunks[1].data.readUInt32BE(0), 2)
  }
})

test('prepends the whole-video first frame as thumbnail on each split APNG', async () => {
  const thumb = staticPng(1, 1, Buffer.from([0, 255, 0, 255]))
  const first = staticPng(1, 1, Buffer.from([255, 0, 0, 255]))
  const second = staticPng(1, 1, Buffer.from([0, 0, 255, 255]))
  const outputs = await createApngsFromVideo({
    ffmpeg: mockFfmpeg({
      info: 'Duration: 00:00:12.00, start: 0.000000, bitrate: 128 kb/s\nStream #0:0: Video: h264, yuv420p, 64x64, 30 fps',
      frames: [first, second],
      thumbnail: thumb,
    }),
  }, Buffer.from('fake-video'), {
    maxDuration: 10,
    fps: 8,
    maxFrames: 48,
    maxDimension: 512,
    splitOnOverflow: true,
    shareThumbnail: true,
  })
  assert.equal(outputs.length, 2)
  for (const output of outputs) {
    const chunks = parsePng(output)
    assert.equal(chunks[1].data.readUInt32BE(0), 3)
    assert.deepEqual([chunks[2].data.readUInt16BE(20), chunks[2].data.readUInt16BE(22)], [10, 1000])
    assert.deepEqual(rawRows(chunks[3].data, 1, 1), Buffer.from([0, 255, 0, 255]))
  }
})

test('requires optional ffmpeg service for GIF input', async () => {
  const gif = Buffer.from('GIF89a', 'ascii')
  await assert.rejects(() => createTwoFrameApng({}, gif, gif, 4096), /ffmpeg/)
})

const { splitTwoFrameApng } = require('../lib')

test('splits both encoder outputs into exact static PNG pixels and valid CRCs', () => {
  const first = { width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 1, 2, 3, 0]) }
  const second = { width: 2, height: 1, data: Buffer.from([0, 0, 255, 128, 4, 5, 6, 255]) }
  for (const input of [
    encodeTwoFrameApng(first, second),
    encodeTwoFramePngs(staticPng(2, 1, first.data), staticPng(2, 1, second.data)),
  ]) {
    const outputs = splitTwoFrameApng(input)
    for (const [index, output] of outputs.entries()) {
      const chunks = parsePng(output)
      assert.deepEqual(chunks.map(item => item.type), ['IHDR', 'IDAT', 'IEND'])
      assert.deepEqual(rawRows(chunks[1].data, 2, 1), [first, second][index].data)
      for (const item of chunks) assert.equal(item.storedCrc, crc32(Buffer.concat([Buffer.from(item.type), item.data])))
    }
  }
})

test('rejects static, truncated, corrupt, oversized, and video APNG inputs', () => {
  const png = staticPng(1, 1, Buffer.from([1, 2, 3, 255]))
  const input = encodeTwoFramePngs(png, png)
  assert.throws(() => splitTwoFrameApng(png), /仅支持/)
  assert.throws(() => splitTwoFrameApng(Buffer.from('jpeg')), /静态图片/)
  for (let end = 8; end < input.length; end++) {
    assert.throws(() => splitTwoFrameApng(input.subarray(0, end)), /不完整/)
  }
  const corrupt = Buffer.from(input)
  corrupt[20] ^= 1
  assert.throws(() => splitTwoFrameApng(corrupt), /校验失败/)
  assert.throws(() => splitTwoFrameApng(input, 0), /尺寸/)
  assert.throws(() => splitTwoFrameApng(Buffer.concat([input, Buffer.from([0])])), /多余/)
  for (const count of [1, 2, 3]) {
    const video = encodePngFrames(Array.from({ length: count }, () => ({ data: png, delayNumerator: 100, delayDenominator: 1000 })))
    assert.throws(() => splitTwoFrameApng(video), /仅支持/)
  }
})

test('rejects altered frame controls even with correct CRCs', () => {
  const png = staticPng(1, 1, Buffer.from([1, 2, 3, 255]))
  for (const position of [0, 4, 8, 12, 16, 20, 22, 24, 25]) {
    const chunks = parsePng(encodeTwoFramePngs(png, png))
    const control = Buffer.from(chunks[4].data)
    control[position] ^= 1
    chunks[4].data = control
    const input = Buffer.concat([png.subarray(0, 8), ...chunks.map(item => pngChunk(item.type, item.data))])
    assert.throws(() => splitTwoFrameApng(input), /仅支持/)
  }
})
