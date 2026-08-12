import { Context, h, Schema, Session } from 'koishi'
import { createTwoFrameApng, downloadImage, ImageInputError } from './image'

export const name = 'koishi-plugin-apng-two-frame'
// 图片地址通过 Koishi HTTP 服务下载；声明注入可确保服务缺失时插件不会半加载。
export const inject = ['http']

const aliases = ['两帧', '两帧动图']

export interface Config {
  commandName: string
  maxFileSize: number
  maxDimension: number
  collectTimeout: number
}

export const Config: Schema<Config> = Schema.object({
  commandName: Schema.string().default('apng').description('主指令名称。'),
  maxFileSize: Schema.number().min(1).max(100).step(1).default(10).description('单张图片文件大小上限（MiB）。'),
  maxDimension: Schema.number().min(64).max(16384).step(1).default(4096).description('图片宽或高的最大像素数。'),
  collectTimeout: Schema.number().min(5).max(3600).step(1).default(60).description('等待后续图片的超时时间（秒）。'),
})

interface Collection {
  /** 已按既定优先级收集到的图片/头像地址，最多使用前两项。 */
  sources: string[]
  /** 每收到一条相关消息就重新开始计时的超时计时器。 */
  timer: ReturnType<typeof setTimeout>
  /** 防止同一用户短时间内多条消息并发修改 sources。 */
  busy: boolean
  /** 最近一次消息的会话，用于超时后向正确频道发送提示。 */
  session: Session
}

interface ExtractResult {
  sources: string[]
  avatarFailures: string[]
}

function collectionKey(session: Session) {
  // 同一用户在不同平台或频道可以同时发起互不影响的收集任务。
  return `${session.platform}:${session.channelId}:${session.userId}`
}

function isOwnCommand(content: string, config: Config) {
  // 收集期间再次发送本插件指令，应交给命令系统返回“已有任务”，
  // 而不能被收集中间件误当作一条没有图片的普通消息。
  const plain = h.select(h.parse(content), 'text').map(element => element.attrs.content).join('').trim()
  const names = [config.commandName, ...aliases]
  return names.some(name => {
    const command = plain.replace(/^[/.!！]/, '')
    return command === name || command.startsWith(`${name} `)
  })
}

async function extractElements(session: Session, elements: readonly h[], skipBot = true): Promise<ExtractResult> {
  // 单次线性遍历可保留图片和 @ 元素在原消息中的相对顺序。
  const sources: string[] = []
  const avatarFailures: string[] = []
  for (const element of elements) {
    if (element.type === 'img' || element.type === 'image') {
      const source = element.attrs.src || element.attrs.url
      if (typeof source === 'string') sources.push(source)
      continue
    }
    // @全体成员没有单一头像；@机器人自身通常只是命令前缀，也应跳过。
    if (element.type !== 'at' || element.attrs.type === 'all') continue
    const userId = String(element.attrs.id ?? '')
    if (!userId || (skipBot && userId === session.selfId)) continue
    try {
      // 群聊优先查询群成员，以便获取群头像/成员资料；私聊退化为普通用户查询。
      const user = session.guildId
        ? await session.bot.getGuildMember(session.guildId, userId)
        : await session.bot.getUser(userId)
      if (user.avatar) sources.push(user.avatar)
      else avatarFailures.push(userId)
    } catch {
      avatarFailures.push(userId)
    }
  }
  return { sources, avatarFailures }
}

export async function extractInitialSources(session: Session) {
  // 产品约定：引用消息是上下文，优先级高于当前指令消息；最终只使用前两张。
  const quoteElements = session.quote?.elements ?? []
  const quoted = await extractElements(session, quoteElements)
  const current = await extractElements(session, session.elements ?? [])
  return {
    sources: [...quoted.sources, ...current.sources].slice(0, 2),
    avatarFailures: [...quoted.avatarFailures, ...current.avatarFailures],
  }
}

async function generate(ctx: Context, session: Session, sources: string[], config: Config) {
  try {
    // 两张图可以并行下载；编码仍按 sources 的既定顺序使用结果。
    const maxBytes = config.maxFileSize * 1024 * 1024
    const [first, second] = await Promise.all(sources.slice(0, 2).map(source => downloadImage(ctx, source, maxBytes)))
    const output = await createTwoFrameApng(first, second, config.maxDimension)
    // OneBot 适配器会将 data:image/png;base64 转成 NapCat 可接受的 base64:// 图片。
    await session.send(h.image(output, 'image/png'))
  } catch (error) {
    const message = error instanceof ImageInputError ? error.message : '生成两帧 APNG 失败'
    ctx.logger(name).warn(error)
    await session.send(message)
  }
}

export function apply(ctx: Context, config: Config) {
  // 收集状态只存于内存；机器人重启或插件卸载后不会恢复未完成任务。
  const collections = new Map<string, Collection>()

  const clear = (key: string) => {
    const collection = collections.get(key)
    if (!collection) return
    clearTimeout(collection.timer)
    collections.delete(key)
  }

  const resetTimer = (key: string, collection: Collection) => {
    clearTimeout(collection.timer)
    collection.timer = setTimeout(async () => {
      // 旧 timer 可能在任务已替换后才触发，用对象身份检查避免删除新任务。
      if (collections.get(key) !== collection) return
      collections.delete(key)
      await collection.session.bot.sendMessage(collection.session.channelId!, '图片收集已超时，任务已取消。').catch(() => {})
    }, config.collectTimeout * 1000)
  }

  ctx.on('dispose', () => {
    // 避免插件热重载后遗留定时器，继续向频道发送过期提示。
    for (const key of collections.keys()) clear(key)
  })

  // prepend=true：先于普通中间件观察后续消息，但处理完仍调用 next()，不阻断其他插件。
  ctx.middleware(async (session, next) => {
    if (!session.userId || !session.channelId) return next()
    const key = collectionKey(session)
    const collection = collections.get(key)
    if (!collection) return next()

    const content = h.select(session.elements ?? [], 'text').map(element => element.attrs.content).join('').trim()
    if (content === '取消') {
      // “取消”是收集状态下的控制消息，由本插件消费，不再交给其他指令解析。
      clear(key)
      await session.send('已取消图片收集。')
      return
    }
    if (isOwnCommand(session.content ?? '', config)) return next()
    if (collection.busy) return next()

    // Koishi 可能并发派发同一用户的消息，busy 确保只处理其中一条，避免收集超过两项。
    collection.busy = true
    try {
      const extracted = await extractElements(session, session.elements ?? [])
      for (const userId of extracted.avatarFailures) await session.send(`无法获取 @${userId} 的头像，已跳过。`)
      collection.sources.push(...extracted.sources.slice(0, 2 - collection.sources.length))
      // 更新为最新会话，使超时提示沿用当前频道/机器人实例发送。
      collection.session = session
      if (collection.sources.length >= 2) {
        clear(key)
        await generate(ctx, session, collection.sources, config)
        return next()
      }
      resetTimer(key, collection)
      // 按用户选择，每一条未补齐图片的消息都给出剩余数量提示。
      await session.send(`没有找到足够的图片，还需要 ${2 - collection.sources.length} 张；发送“取消”可结束任务。`)
    } finally {
      collection.busy = false
    }
    return next()
  }, true)

  const command = ctx.command(config.commandName, '将两张图片合成为两帧 APNG')
  // 当管理员把主指令配置成某个别名时，避免重复注册相同名称。
  for (const alias of aliases) {
    if (alias !== config.commandName) command.alias(alias)
  }
  command.action(async ({ session }) => {
    if (!session?.userId || !session.channelId) return '当前会话无法收集图片。'
    const key = collectionKey(session)
    // 重复触发不会重置或追加现有任务，用户必须先完成或明确取消。
    if (collections.has(key)) return '已有图片收集任务，请先完成或发送“取消”。'

    const extracted = await extractInitialSources(session)
    for (const userId of extracted.avatarFailures) await session.send(`无法获取 @${userId} 的头像，已跳过。`)
    if (extracted.sources.length >= 2) {
      // 触发消息已经提供两张图时立即生成，不创建临时收集状态。
      await generate(ctx, session, extracted.sources, config)
      return
    }

    // 图片不足时保存当前结果，并等待同一用户在同一频道发送后续消息。
    const collection: Collection = {
      sources: extracted.sources,
      timer: undefined as never,
      busy: false,
      session,
    }
    collections.set(key, collection)
    resetTimer(key, collection)
    return `还需要 ${2 - collection.sources.length} 张图片，请继续发送；发送“取消”可结束任务。`
  })
}

export { createTwoFrameApng, downloadImage } from './image'
export { encodeTwoFrameApng, crc32 } from './apng'
