const assert = require('node:assert/strict')
const test = require('node:test')
const { h } = require('koishi')
const { downloadImage, extractInitialSources } = require('../lib')

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

test('takes quoted images first, then current images and avatars in element order', async () => {
  const session = fakeSession()
  const result = await extractInitialSources(session)
  assert.deepEqual(result.sources, [
    'https://example.test/quoted.png',
    'https://example.test/avatar-100.png',
  ])
  assert.deepEqual(result.avatarFailures, [])
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
