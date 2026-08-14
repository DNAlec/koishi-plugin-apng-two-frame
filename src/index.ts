import { Context, h, Schema, Session } from 'koishi'
import {} from 'koishi-plugin-ffmpeg'
import {} from 'koishi-plugin-puppeteer'
import { createTwoFrameApng, downloadImage, ImageInputError } from './image'

export const name = 'koishi-plugin-apng-two-frame'

// Koishi 控制台会把 usage 作为 Markdown 渲染在插件配置页面上方。
export const usage = `
## 使用说明

发送 \`apng\` 并附带两张图片，即可生成两帧 APNG 动图。也可以引用图片、@群成员获取头像，或在触发指令后分多条消息补齐图片。

- 第一张图片用于聊天列表中的缩略图，第二张图片是点开后主要显示的画面。
- 默认指令为 \`apng\`，也可以使用 \`两帧\` 或 \`两帧动图\`；修改下方的 \`commandName\` 后，主指令会随之改变。
- 开启批量子指令后，使用 \`apng.batch\` 或 \`apng.批量\` 收集多张图；发送“开始”或收满上限后，会将第一张分别与余下每张图生成 APNG。
- 必须启用 \`puppeteer\` 服务；如需处理 GIF，还应启用可选的 \`ffmpeg\` 服务。
- 缩略图差异主要面向 QQ + NapCat + OneBot 11，实际效果可能因平台和客户端版本而异。

如果你已经部署了 [Meme Generator](https://github.com/MemeCrafters/meme-generator)，也可以安装并使用对应的更加轻量级的自定义表情：[\`apng_two_frame\`](https://github.com/DNAlec/memes/tree/master/apng_two_frame)。
`

// 图片地址通过 Koishi HTTP 服务下载；声明注入可确保服务缺失时插件不会半加载。
export const inject = {
  required: ['http', 'puppeteer'],
  optional: ['ffmpeg'],
}

const aliases = ['两帧', '两帧动图']

export interface Config {
  /** 主指令名称；批量子指令也会以它作为前缀。 */
  commandName: string
  /** 每个输入图片允许下载的最大 MiB 数。 */
  maxFileSize: number
  /** 图片任一边允许的最大像素数。 */
  maxDimension: number
  /** 最后一条收集消息之后，任务可继续等待的秒数。 */
  collectTimeout: number
  /** 为 false 时不注册 batch 子指令，也不影响原有两图模式。 */
  enableBatchCommand: boolean
  /** 批量任务图片总数上限；计数包含作为公用第一帧的首图。 */
  batchMaxImages: number
}

export const Config: Schema<Config> = Schema.object({
  commandName: Schema.string().default('apng').description('主指令名称。'),
  maxFileSize: Schema.number().min(1).max(100).step(1).default(10).description('单张图片文件大小上限（MiB）。'),
  maxDimension: Schema.number().min(64).max(16384).step(1).default(4096).description('图片宽或高的最大像素数。'),
  collectTimeout: Schema.number().min(5).max(3600).step(1).default(60).description('等待后续图片的超时时间（秒）。'),
  enableBatchCommand: Schema.boolean().default(false).description('是否启用 batch（批量）子指令。'),
  batchMaxImages: Schema.number().min(2).max(100).step(1).default(10).description('批量任务最多收集的图片数（含第一张公用图）。'),
})

interface Collection {
  /** 已按既定优先级收集到的图片/头像地址。 */
  sources: string[]
  /**
   * single 保留原有行为：收满两张立即生成一个结果。
   * batch 则在收满 limit 或用户发送“开始”之前一直保持收集状态。
   */
  mode: 'single' | 'batch'
  /** 本任务能接收的图片总数；single 固定为 2，batch 取配置值。 */
  limit: number
  /** 每收到一条相关消息就重新开始计时的超时计时器。 */
  timer: ReturnType<typeof setTimeout>
  /**
   * 本任务的串行队列尾。Koishi 会并发派发消息，后到的图片和控制词
   * 通过该 Promise 等待先到的消息处理完成，从而既不竞争修改 sources，也不丢失消息。
   */
  queue: Promise<void>
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
    return command === name || command.startsWith(`${name} `) || command.startsWith(`${name}.`)
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

export async function extractInitialSources(session: Session, limit = 2) {
  // 引用消息是上下文，优先级高于当前指令消息。默认截取两张以兼容
  // 原有调用者；批量子指令会显式传入 batchMaxImages，以便一次指令携带多图。
  const quoteElements = session.quote?.elements ?? []
  const quoted = await extractElements(session, quoteElements)
  const current = await extractElements(session, session.elements ?? [])
  return {
    sources: [...quoted.sources, ...current.sources].slice(0, limit),
    avatarFailures: [...quoted.avatarFailures, ...current.avatarFailures],
  }
}

async function generate(ctx: Context, session: Session, sources: string[], config: Config) {
  try {
    // 两张图可以并行下载；编码仍按 sources 的既定顺序使用结果。
    const maxBytes = config.maxFileSize * 1024 * 1024
    const [first, second] = await Promise.all(sources.slice(0, 2).map(source => downloadImage(ctx, source, maxBytes)))
    const output = await createTwoFrameApng(ctx, first, second, config.maxDimension)
    // OneBot 适配器会将 data:image/png;base64 转成 NapCat 可接受的 base64:// 图片。
    await session.send(h.image(output, 'image/png'))
  } catch (error) {
    const message = error instanceof ImageInputError ? error.message : '生成两帧 APNG 失败'
    ctx.logger(name).warn(error)
    await session.send(message)
  }
}

async function generateBatch(ctx: Context, session: Session, sources: string[], config: Config) {
  // sources[0] 是所有输出共用的第一帧；sources[1..n] 依次作为第二帧。
  // 因此收集 n 张图片时，最多会向会话发送 n - 1 个独立 APNG。
  const maxBytes = config.maxFileSize * 1024 * 1024
  let first: Buffer
  try {
    // 首图会被所有结果复用，只下载一次。其余图片逐张处理，避免批量上限较大时占用过多内存。
    first = await downloadImage(ctx, sources[0], maxBytes)
  } catch (error) {
    const message = error instanceof ImageInputError ? error.message : '生成两帧 APNG 失败'
    ctx.logger(name).warn(error)
    await session.send(`批量任务的第一张图片处理失败：${message}`)
    return
  }

  let succeeded = 0
  for (let index = 1; index < sources.length; index++) {
    try {
      // 下载、解码、Canvas 处理和发送均放在单张图片的 try 中。
      // 某个第二帧损坏或超限时，只跳过该结果，不中断后面的批量任务。
      const second = await downloadImage(ctx, sources[index], maxBytes)
      const output = await createTwoFrameApng(ctx, first, second, config.maxDimension)
      await session.send(h.image(output, 'image/png'))
      succeeded++
    } catch (error) {
      const message = error instanceof ImageInputError ? error.message : '生成两帧 APNG 失败'
      ctx.logger(name).warn(error)
      await session.send(`第 ${index + 1} 张图片处理失败：${message}`)
    }
  }
  await session.send(`批量处理完成，成功生成 ${succeeded}/${sources.length - 1} 张 APNG。`)
}

export function apply(ctx: Context, config: Config) {
  // 收集状态只存于内存；机器人重启或插件卸载后不会恢复未完成任务。
  const collections = new Map<string, Collection>()

  const enqueue = async <T>(collection: Collection, callback: () => Promise<T>) => {
    // 不直接把 callback 的结果作为新队尾：队列尾必须始终恢复为 fulfilled，
    // 否则某条消息抛错后，后续所有已排队消息都会被同一个 rejection 跳过。
    const result = collection.queue.then(callback)
    collection.queue = result.then(() => undefined, () => undefined)
    return result
  }

  const clear = (key: string) => {
    // 清理操作同时删除状态和计时器，保证手动取消、自动触发、
    // 手动开始以及插件卸载都不会留下过期的超时回调。
    const collection = collections.get(key)
    if (!collection) return
    clearTimeout(collection.timer)
    collections.delete(key)
  }

  const resetTimer = (key: string, collection: Collection) => {
    // 这是“静默超时”而非从指令开始计算的固定总时长：
    // 每处理一条后续消息都重新计时，让用户可以持续上传较大的批次。
    clearTimeout(collection.timer)
    const timer = setTimeout(() => {
      void enqueue(collection, async () => {
        // 旧 timer 可能在任务已替换或已被重新计时后才排到执行。
        // 同时检查任务身份和 timer 身份，避免旧回调删除新任务或误判活跃任务超时。
        if (collections.get(key) !== collection || collection.timer !== timer) return
        collections.delete(key)
        await collection.session.bot.sendMessage(collection.session.channelId!, '图片收集已超时，任务已取消。').catch(() => {})
      })
    }, config.collectTimeout * 1000)
    collection.timer = timer
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
    if (isOwnCommand(session.content ?? '', config)) return next()

    // 同一收集任务的消息按到达顺序串行执行。callback 返回 true 表示
    // “取消”或“开始”已被本插件消费；false 则在退出队列后继续调用其他中间件。
    const consumed = await enqueue(collection, async () => {
      // 排队期间，前一条消息可能已经收满上限、取消或开始了任务。
      // 此时当前消息不再属于旧任务，应交还中间件链，而不能继续写入已移除的 sources。
      if (collections.get(key) !== collection) return false

      if (content === '取消') {
        // “取消”是收集状态下的控制消息，由本插件消费，不再交给其他指令解析。
        clear(key)
        await session.send('已取消图片收集。')
        return true
      }
      if (content === '开始' && collection.mode === 'batch') {
        // “开始”仅是批量模式的控制词。普通模式仍以收满两张为唯一触发条件。
        // 必须先有公用首图和至少一张第二帧，否则保留任务并继续等待。
        if (collection.sources.length < 2) {
          resetTimer(key, collection)
          await session.send('至少需要 2 张图片才能开始批量处理。')
          return true
        }
        // 生成可能持续较长时间，先从 Map 中移除任务并取消计时，
        // 避免处理期间超时回调又发送一条“任务已取消”。
        clear(key)
        await generateBatch(ctx, session, collection.sources, config)
        return true
      }

      const extracted = await extractElements(session, session.elements ?? [])
      for (const userId of extracted.avatarFailures) await session.send(`无法获取 @${userId} 的头像，已跳过。`)
      // 一条消息可能同时带多张图，只取当前任务剩余容量的数量，
      // 从根源上保证 sources.length 不会超过 limit。
      collection.sources.push(...extracted.sources.slice(0, collection.limit - collection.sources.length))
      // 更新为最新会话，使超时提示沿用当前频道/机器人实例发送。
      collection.session = session
      if (collection.sources.length >= collection.limit) {
        // single 的 limit 是 2，因此保持“两张立即生成”；batch 则只在达到
        // 配置上限时自动生成。两者在此共用同一套收集顺序和并发保护。
        clear(key)
        if (collection.mode === 'batch') await generateBatch(ctx, session, collection.sources, config)
        else await generate(ctx, session, collection.sources, config)
        return false
      }
      resetTimer(key, collection)
      if (collection.mode === 'batch') {
        await session.send(`已收集 ${collection.sources.length}/${collection.limit} 张图片；发送“开始”可立即处理，发送“取消”可结束任务。`)
      } else {
        // 普通任务每一条未补齐图片的消息都给出剩余数量提示。
        await session.send(`没有找到足够的图片，还需要 ${collection.limit - collection.sources.length} 张；发送“取消”可结束任务。`)
      }
      return false
    })
    if (consumed) return
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
      mode: 'single',
      limit: 2,
      timer: undefined as never,
      queue: Promise.resolve(),
      session,
    }
    collections.set(key, collection)
    resetTimer(key, collection)
    return `还需要 ${2 - collection.sources.length} 张图片，请继续发送；发送“取消”可结束任务。`
  })

  if (config.enableBatchCommand) {
    // 仅在显式开启配置时注册子指令，关闭时不会占用指令名。
    // 子指令前缀跟随 commandName：例如主指令改为 foo 后，调用方式为 foo.batch。
    const batch = ctx.command(`${config.commandName}.batch`, '批量生成共用第一帧的 APNG')
      .alias(`${config.commandName}.批量`)
    batch.action(async ({ session }) => {
      if (!session?.userId || !session.channelId) return '当前会话无法收集图片。'
      const key = collectionKey(session)
      if (collections.has(key)) return '已有图片收集任务，请先完成或发送“取消”。'

      const extracted = await extractInitialSources(session, config.batchMaxImages)
      for (const userId of extracted.avatarFailures) await session.send(`无法获取 @${userId} 的头像，已跳过。`)
      const collection: Collection = {
        sources: extracted.sources,
        mode: 'batch',
        limit: config.batchMaxImages,
        timer: undefined as never,
        queue: Promise.resolve(),
        session,
      }
      // 用户可以在调用子指令时就附带多张图片。如果触发消息本身已达上限，
      // 立即执行批量处理，无需把一个永远不会再收集的任务放入 Map 或创建计时器。
      if (collection.sources.length >= collection.limit) {
        await generateBatch(ctx, session, collection.sources, config)
        return
      }
      // 未达上限时，即使已有两张也不自动生成；这是批量模式与普通模式
      // 最关键的差异。后续由收集中间件处理新图片、“开始”和“取消”。
      collections.set(key, collection)
      resetTimer(key, collection)
      return `已进入批量收集，当前 ${collection.sources.length}/${collection.limit} 张；至少收集 2 张后发送“开始”可处理，发送“取消”可结束任务。`
    })
  }
}

export { createTwoFrameApng, downloadImage } from './image'
export { encodeTwoFrameApng, encodeTwoFramePngs, crc32 } from './apng'
