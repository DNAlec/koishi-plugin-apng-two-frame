const assert = require('node:assert/strict')
const { deflateSync, inflateSync } = require('node:zlib')
const test = require('node:test')
const { crc32, createTwoFrameApng, encodeTwoFrameApng, encodeTwoFramePngs } = require('../lib')

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

test('requires optional ffmpeg service for GIF input', async () => {
  const gif = Buffer.from('GIF89a', 'ascii')
  await assert.rejects(() => createTwoFrameApng({}, gif, gif, 4096), /ffmpeg/)
})
