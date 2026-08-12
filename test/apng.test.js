const assert = require('node:assert/strict')
const { inflateSync } = require('node:zlib')
const test = require('node:test')
const sharp = require('sharp')
const { crc32, createTwoFrameApng, encodeTwoFrameApng } = require('../lib')

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

test('uses second image as canvas and centres a non-enlarged first image on white', async () => {
  const first = await sharp({ create: { width: 2, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer()
  const second = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#0000ff' } }).png().toBuffer()
  const chunks = parsePng(await createTwoFrameApng(first, second, 4096))
  const frame1 = rawRows(chunks.find(chunk => chunk.type === 'IDAT').data, 4, 4)
  const frame2 = rawRows(chunks.find(chunk => chunk.type === 'fdAT').data.subarray(4), 4, 4)
  const pixel = (data, x, y) => [...data.subarray((y * 4 + x) * 4, (y * 4 + x + 1) * 4)]

  assert.deepEqual(pixel(frame1, 0, 0), [255, 255, 255, 255])
  assert.deepEqual(pixel(frame1, 1, 1), [255, 0, 0, 255])
  assert.deepEqual(pixel(frame1, 2, 1), [255, 0, 0, 255])
  assert.deepEqual(pixel(frame1, 3, 3), [255, 255, 255, 255])
  assert.deepEqual(pixel(frame2, 0, 0), [0, 0, 255, 255])
})

test('auto-orients input and composites transparent first-frame pixels onto white', async () => {
  const transparent = await sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer()
  const oriented = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#00ff00' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const chunks = parsePng(await createTwoFrameApng(transparent, oriented, 4096))
  const ihdr = chunks.find(chunk => chunk.type === 'IHDR').data
  assert.deepEqual([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)], [2, 3])
  const frame1 = rawRows(chunks.find(chunk => chunk.type === 'IDAT').data, 2, 3)
  assert.deepEqual([...frame1.subarray(0, 4)], [255, 255, 255, 255])
})

test('rejects invalid and oversized dimensions', async () => {
  const valid = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toBuffer()
  await assert.rejects(() => createTwoFrameApng(Buffer.from('not an image'), valid, 4096), /图片/)
  await assert.rejects(() => createTwoFrameApng(valid, valid, 1), /不能超过 1 px/)
})
