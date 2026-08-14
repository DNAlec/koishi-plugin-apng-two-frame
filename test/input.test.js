const assert = require('node:assert/strict')
const test = require('node:test')
const { Bot, Context, Universal, h } = require('koishi')
const { apply, downloadImage, extractInitialSources } = require('../lib')

function config(overrides = {}) {
  return {
    commandName: 'apng',
    maxFileSize: 10,
    maxDimension: 4096,
    collectTimeout: 60,
    enableBatchCommand: false,
    batchMaxImages: 10,
    ...overrides,
  }
}

function fakeSession() {
  return {
    selfId: 'bot',
    guildId: 'guild',
    quote: { elements: [h.image('https://example.test/quoted.png')] },
    elements: [h.at('100'), h.image('https://example.test/current.png'), h.at('bot')],
    bot: {
      async getGuildMember(_guildId, userId) {
        return { avatar: `https://example.test/avatar-${userId}.png` }
      },
    },
  }
}

class TestBot extends Bot {
  constructor(ctx) {
    super(ctx, {}, 'test')
    this.selfId = 'bot'
    this.sent = []
  }

  // Context 单元测试没有完整适配器生命周期，卸载时无需执行 Bot 的默认注销流程。
  dispose() {}

  async start() {}

  async stop() {}

  async sendMessage(_channelId, content) {
    const text = h.select(h.normalize(content), 'text').map(element => element.attrs.content).join('')
    this.sent.push(text)
    return [`message-${this.sent.length}`]
  }

  async getUser(userId) {
    // 制造一个稳定的并发窗口：第二条图片消息会在头像查询完成前到达。
    await new Promise(resolve => setTimeout(resolve, 20))
    return { id: userId, avatar: `https://example.test/avatar-${userId}.png` }
  }
}

function dispatchMessage(ctx, bot, content, elements) {
  const session = bot.session({
    type: 'message-created',
    user: { id: 'user' },
    channel: { id: 'channel', type: Universal.Channel.Type.DIRECT },
    message: { id: `incoming-${Math.random()}`, content, elements },
  })
  return ctx.parallel(session, 'message', session)
}

test('takes quoted images first, then current images and avatars in element order', async () => {
  const session = fakeSession()
  const result = await extractInitialSources(session)
  assert.deepEqual(result.sources, [
    'https://example.test/quoted.png',
    'https://example.test/avatar-100.png',
  ])
  assert.deepEqual(result.avatarFailures, [])
})

test('can collect more than two initial sources for batch mode', async () => {
  const session = fakeSession()
  const result = await extractInitialSources(session, 3)
  assert.deepEqual(result.sources, [
    'https://example.test/quoted.png',
    'https://example.test/avatar-100.png',
    'https://example.test/current.png',
  ])
})

test('reports an unavailable mentioned avatar and skips the bot itself', async () => {
  const session = fakeSession()
  session.quote.elements = []
  session.bot.getGuildMember = async () => ({})
  const result = await extractInitialSources(session)
  assert.deepEqual(result.sources, ['https://example.test/current.png'])
  assert.deepEqual(result.avatarFailures, ['100'])
})

test('enforces the byte limit for embedded images before decoding', async () => {
  const source = `data:image/png;base64,${Buffer.alloc(32).toString('base64')}`
  await assert.rejects(() => downloadImage({}, source, 16), /超过/)
  assert.deepEqual(await downloadImage({}, source, 32), Buffer.alloc(32))
})

test('registers the batch subcommand only when enabled', () => {
  const disabled = new Context()
  apply(disabled, config())
  assert.equal(disabled.$commander.get('apng.batch'), undefined)
  assert.equal(disabled.$commander.get('apng.批量'), undefined)

  const enabled = new Context()
  apply(enabled, config({ enableBatchCommand: true }))
  assert.equal(enabled.$commander.get('apng.batch')?.name, 'apng.batch')
  assert.equal(enabled.$commander.get('apng.批量')?.name, 'apng.batch')
})

test('serializes concurrent batch inputs without dropping later images', async () => {
  const ctx = new Context()
  const bot = new TestBot(ctx)
  apply(ctx, config({ enableBatchCommand: true, batchMaxImages: 4 }))
  await ctx.start()
  try {
    await dispatchMessage(ctx, bot, 'apng.batch', [h.text('apng.batch')])
    await Promise.all([
      dispatchMessage(ctx, bot, h.at('first').toString(), [h.at('first')]),
      dispatchMessage(ctx, bot, h.image('https://example.test/second.png').toString(), [h.image('https://example.test/second.png')]),
    ])
    assert.match(bot.sent[1], /已收集 1\/4/)
    assert.match(bot.sent[2], /已收集 2\/4/)
  } finally {
    await ctx.stop()
  }
})
