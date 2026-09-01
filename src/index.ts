import { Context, h, Schema, Session } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import './ffmpeg'
import { createTwoFrameApng, DebugLog, downloadImage, downloadVideo, ImageInputError, ImageSendMode, sendPngImage, sendPngImages } from './image'
import { createApngsFromVideo } from './video'

export const name = 'koishi-plugin-apng-two-frame'

// Koishi 控制台会把 usage 作为 Markdown 渲染在插件配置页面上方。
export const usage = `
## 使用说明

发送 \`apng\` 并附带两张图片，即可生成两帧 APNG：第一张作聊天列表缩略图，第二张是点开后主要显示的画面。也可以引用图片、@群成员获取头像，或分多条消息补齐。默认指令 \`apng\`，别名 \`两帧\` / \`两帧动图\`。

配置项在本说明**下方**。若看不到最新选项，请先编译（\`npm run build\`），再停用后重新启用插件，或重启 Koishi。

- 主指令可用 \`-d\` 指定本次最大像素数。
- 开启批量子指令后使用 \`apng.batch\` / \`apng.批量\`；\`-n\` 指定本次最多收集的图片数。至少 2 张后发送「开始」，或收满上限后自动生成。
- 在「视频转换」中开启视频子指令后使用 \`apng.video\` / \`apng.视频\`。参数：\`-t\` 时长、\`-f\` 帧率、\`-F\` 最大帧数、\`-d\` 像素、\`-T\` 共用封面帧。需要任意提供 \`ffmpeg\` 服务的插件。
- 视频转成的 APNG 往往会比原视频大很多（逐帧 PNG，缺少跨帧压缩）。可降低像素、帧率、时长或帧数。单张超过 \`fileSendThreshold\`（默认 20 MiB）时改为文件附件。
- 大图默认走临时文件 + \`file://\`，避免 OneBot 被 base64 撑到超时；协议端需能读取 Koishi 主机的临时目录。
- 「合并转发」会把批量或视频分割的多张结果打成一条转发（节点内一律按图片发送）。图片过大时转发可能失败，体积没有把握时不建议开启。
- 必须启用 \`puppeteer\` 服务。缩略图差异主要面向 QQ + NapCat + OneBot 11。
- 排查问题时可打开最下方「调试」中的调试日志。

如果你已经部署了 [Meme Generator](https://github.com/MemeCrafters/meme-generator)，也可以使用更轻量的自定义表情：[\`apng_two_frame\`](https://github.com/DNAlec/memes/tree/master/apng_two_frame)。
`

// 图片地址通过 Koishi HTTP 服务下载；声明注入可确保服务缺失时插件不会半加载。
export const inject = {
  required: ['http', 'puppeteer'],
  optional: ['ffmpeg'],
}

const aliases = ['两帧', '两帧动图']

export interface Config {
  /** 主指令名称；批量与视频子指令也会以它作为前缀。 */
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
  /** 生成结果的发送方式；file 可避免大图 base64 撑爆 OneBot 通道。 */
  imageSendMode: ImageSendMode
  /** auto 模式下超过该 KiB 改用临时文件发送。 */
  imageFileThreshold: number
  /** 生成的 APNG 超过该 MiB 时改为以文件附件发送；0 表示不启用。 */
  fileSendThreshold: number
  /** 批量或视频分割产生多张图时使用合并转发，避免刷屏。 */
  mergeForward: boolean
  /** 为 false 时不注册 video 子指令，也不影响原有两图模式。 */
  enableVideoCommand: boolean
  /** 单个输入视频允许下载的最大 MiB 数。 */
  videoMaxFileSize: number
  /** 允许转换的最长视频时长（秒）。 */
  videoMaxDuration: number
  /** 视频抽帧目标帧率；若会超过 videoMaxFrames 则自动降低。 */
  videoFps: number
  /** 视频转换最多写入 APNG 的帧数。 */
  videoMaxFrames: number
  /** 视频输出画布任一边的最大像素数；超过才缩小。 */
  videoMaxDimension: number
  /** 时长超过上限时按时长切片输出多张 APNG，而不是报错。 */
  videoSplitOnOverflow: boolean
  /** 每张切片都以整个视频的第一帧作为自己的第一帧，用作缩略图。 */
  videoSplitShareThumbnail: boolean
  /** 为 true 时以 info 级别输出详细运行日志，不依赖全局 debug 日志等级。 */
  debug: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    commandName: Schema.string().default('apng').description('主指令名称。'),
    maxFileSize: Schema.number().min(1).max(100).step(1).default(10).description('单张图片文件大小上限（MiB）。'),
    maxDimension: Schema.number().min(64).max(16384).step(1).default(4096).description('图片宽或高的最大像素数。'),
    collectTimeout: Schema.number().min(5).max(3600).step(1).default(60).description('等待后续图片的超时时间（秒）。'),
    enableBatchCommand: Schema.boolean().default(false).description('是否启用 batch（批量）子指令。'),
    batchMaxImages: Schema.number().min(2).max(100).step(1).default(10).description('批量任务最多收集的图片数（含第一张公用图）。'),
    imageSendMode: Schema.union([
      Schema.const('auto').description('超过阈值时用临时文件发送，否则用 base64'),
      Schema.const('file').description('始终写入临时文件后以 file:// 发送'),
      Schema.const('base64').description('始终以内嵌 base64 发送'),
    ]).role('radio').default('auto').description('图片发送方式。大图走 base64 容易在 OneBot 通道超时；file:// 需要协议端能读取 Koishi 所在机器的临时目录。'),
    imageFileThreshold: Schema.number().min(1).step(1).default(256).description('auto 模式下，图片超过该大小（KiB）时改用临时文件发送。'),
    fileSendThreshold: Schema.number().min(0).step(1).default(20).description('生成的 APNG 大于该大小（MiB）时改为以文件形式发送。0 表示始终按图片发送。'),
    mergeForward: Schema.boolean().default(false).description('批量生成或视频自动分割产生多张图时，以图片形式打成一条合并转发，避免刷屏。平台不支持时退回逐条发送。图片过大时转发可能失败，体积没有把握时不建议开启。'),
  }),
  Schema.object({
    enableVideoCommand: Schema.boolean().default(false).description('是否启用 video（视频）子指令。需要同时启用 ffmpeg 服务。'),
  }).description('视频转换'),
  Schema.union([
    Schema.object({
      enableVideoCommand: Schema.const(true).required(),
      videoMaxFileSize: Schema.number().min(1).step(1).default(50).description('单个视频文件大小上限（MiB）。'),
      videoMaxDuration: Schema.number().min(1).step(1).default(10).description('允许转换的最长视频时长（秒）。'),
      videoFps: Schema.number().min(1).step(1).default(15).description('视频抽帧目标帧率。超过最大帧数时会自动降低。'),
      videoMaxFrames: Schema.number().min(1).step(1).default(90).description('视频转换最多写入 APNG 的帧数。'),
      videoMaxDimension: Schema.number().min(64).step(1).default(512).description('视频输出宽或高的最大像素数；只缩小不放大。'),
      videoSplitOnOverflow: Schema.boolean().default(false).description('时长超过上限时，自动按上限分割成多张 APNG，而不是报错。'),
    }),
    Schema.object({}),
  ]),
  Schema.union([
    Schema.object({
      enableVideoCommand: Schema.const(true).required(),
      videoSplitOnOverflow: Schema.const(true).required(),
      videoSplitShareThumbnail: Schema.boolean().default(false).description('分割后的每张 APNG 都使用整个视频的第一帧作为自己的第一帧，以获得相同的缩略图。'),
    }),
    Schema.object({}),
  ]),
  Schema.object({
    debug: Schema.boolean().default(false).description('启用调试日志。开启后以 info 级别输出会话、@头像解析、图片收集和下载的详细信息。'),
  }).description('调试'),
]) as Schema<Config>

interface Collection {
  /** 已按既定优先级收集到的图片/头像地址。 */
  sources: string[]
  /**
   * single 保留原有行为：收满两张立即生成一个结果。
   * batch 则在收满 limit 或用户发送“开始”之前一直保持收集状态。
   * video 只收集一个视频，收到后立即转换。
   */
  mode: 'single' | 'batch' | 'video'
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
  /** 本次任务使用的配置快照，包含指令参数覆盖。 */
  taskConfig: Config
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

const noopDebug: DebugLog = () => {}
const qqPlatforms = new Set(['onebot', 'red', 'chronocat', 'qq'])

function summarizeSource(source: string) {
  if (source.startsWith('data:') && source.length > 64) return `${source.slice(0, 48)}...(${source.length} chars)`
  return source
}

interface ElementSummary {
  type: string
  attrs: h['attrs']
  children?: ElementSummary[]
}

function summarizeElements(elements: readonly h[] | undefined): ElementSummary[] {
  return (elements ?? []).map(element => ({
    type: element.type,
    attrs: element.attrs,
    children: element.children?.length ? summarizeElements(element.children) : undefined,
  }))
}

function summarizeSession(session: Session) {
  return {
    platform: session.platform,
    selfId: session.selfId,
    userId: session.userId,
    guildId: session.guildId,
    channelId: session.channelId,
    isDirect: session.isDirect,
    content: session.content,
    hasQuote: Boolean(session.quote),
  }
}

function summarizeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return error
}

function formatExtra(extra: unknown) {
  if (extra === undefined) return ''
  try {
    return ' ' + JSON.stringify(extra, (_key, value) => {
      if (typeof value === 'string') return summarizeSource(value)
      if (value instanceof Error) return summarizeError(value)
      return value
    })
  } catch {
    return ' ' + String(extra)
  }
}

function createDebugLogger(ctx: Context, enabled: boolean): DebugLog {
  if (!enabled) return noopDebug
  const logger = ctx.logger(name)
  return (message, extra) => logger.info(`${message}${formatExtra(extra)}`)
}

function pickAvatar(...candidates: Array<string | undefined>) {
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function mentionUserId(element: h) {
  // OneBot 原始 CQ 用 qq/uin，Satori 用 id；空字符串视为未提供。
  return String(element.attrs.id || element.attrs.qq || element.attrs.uin || element.attrs.user_id || '')
}

function qqAvatarUrl(platform: string | undefined, userId: string) {
  // QQ 号头像 CDN 不依赖 get_group_member_info / get_stranger_info，
  // 可避免 NapCat 等实现返回成员对象却不带头像、或接口直接失败。
  if (!platform || !qqPlatforms.has(platform)) return
  if (!/^\d{5,11}$/.test(userId)) return
  return `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`
}

function* walkMedia(elements: readonly h[]): Iterable<h> {
  for (const element of elements) {
    if (element.type === 'img' || element.type === 'image' || element.type === 'at' || element.type === 'text') {
      yield element
      continue
    }
    if (element.children?.length) yield* walkMedia(element.children)
  }
}

async function resolveMentionAvatar(session: Session, userId: string, debug: DebugLog) {
  debug('开始解析 @ 头像', {
    userId,
    platform: session.platform,
    selfId: session.selfId,
    sessionUserId: session.userId,
    guildId: session.guildId,
    botUserAvatar: session.bot.user?.avatar,
    eventUserAvatar: session.event?.user?.avatar,
    authorAvatar: session.author?.avatar,
  })
  const qqUrl = qqAvatarUrl(session.platform, userId)
  if (qqUrl) {
    debug('使用 QQ 头像 CDN', { userId, qqUrl })
    return qqUrl
  }
  debug('未使用 QQ 头像 CDN', { userId, platform: session.platform, looksLikeQq: /^\d{5,11}$/.test(userId) })
  if (userId === String(session.selfId)) {
    const avatar = pickAvatar(session.bot.user?.avatar)
    if (avatar) {
      debug('使用机器人自身头像', { userId, avatar })
      return avatar
    }
    debug('机器人自身没有可用头像', { userId, botUser: session.bot.user })
  }
  if (userId === String(session.userId)) {
    const avatar = pickAvatar(session.event?.user?.avatar, session.author?.avatar)
    if (avatar) {
      debug('使用当前发送者头像', { userId, avatar })
      return avatar
    }
    debug('当前发送者没有可用头像', { userId })
  }
  // GuildMember.avatar 是群专属头像；OneBot 等适配器通常只填 user.avatar。
  if (session.guildId) {
    try {
      debug('调用 getGuildMember', { guildId: session.guildId, userId })
      const member = await session.bot.getGuildMember(session.guildId, userId)
      debug('getGuildMember 返回', member)
      const avatar = pickAvatar(member.avatar, member.user?.avatar)
      if (avatar) return avatar
      debug('getGuildMember 结果中没有头像', { userId })
    } catch (error) {
      debug('getGuildMember 失败', summarizeError(error))
    }
  } else {
    debug('当前会话没有 guildId，跳过 getGuildMember', { userId })
  }
  try {
    debug('调用 getUser', { userId, guildId: session.guildId })
    const user = await session.bot.getUser(userId, session.guildId)
    debug('getUser 返回', user)
    const avatar = pickAvatar(user.avatar)
    if (avatar) return avatar
    debug('getUser 结果中没有头像', { userId })
  } catch (error) {
    debug('getUser 失败', summarizeError(error))
  }
}

async function extractElements(session: Session, elements: readonly h[], skipLeadingBot = false, debug: DebugLog = noopDebug): Promise<ExtractResult> {
  // 深度优先遍历可保留嵌套在 message/p 中的图片和 @ 的相对顺序。
  debug('开始提取消息元素', { skipLeadingBot, elements: summarizeElements(elements) })
  const sources: string[] = []
  const avatarFailures: string[] = []
  let seenContent = false
  for (const element of walkMedia(elements)) {
    if (element.type === 'text') {
      const text = String(element.attrs.content ?? '')
      if (text.trim()) {
        seenContent = true
        debug('遇到文本', { text, seenContent })
      }
      continue
    }
    if (element.type === 'img' || element.type === 'image') {
      const source = element.attrs.src || element.attrs.url
      debug('遇到图片元素', { type: element.type, attrs: element.attrs, source })
      if (typeof source === 'string') sources.push(source)
      else debug('图片元素没有 src/url', { type: element.type, attrs: element.attrs })
      seenContent = true
      continue
    }
    // @全体成员没有单一头像。
    if (element.attrs.type === 'all') {
      debug('跳过 @全体成员', { attrs: element.attrs })
      continue
    }
    const userId = mentionUserId(element)
    debug('遇到 @ 元素', { attrs: element.attrs, userId, seenContent, skipLeadingBot, selfId: session.selfId })
    if (!userId || userId === 'all') {
      debug('跳过没有有效用户 ID 的 @', { attrs: element.attrs })
      continue
    }
    // 仅跳过指令消息开头用于唤起机器人的 @bot；后续再 @ 机器人则收集其头像。
    if (skipLeadingBot && !seenContent && userId === String(session.selfId)) {
      seenContent = true
      debug('跳过指令前缀 @机器人', { userId })
      continue
    }
    seenContent = true
    try {
      const avatar = await resolveMentionAvatar(session, userId, debug)
      if (avatar) {
        debug('已收集头像', { userId, avatar })
        sources.push(avatar)
      } else {
        debug('未能解析头像', { userId })
        avatarFailures.push(userId)
      }
    } catch (error) {
      debug('解析头像时抛出异常', { userId, error: summarizeError(error) })
      avatarFailures.push(userId)
    }
  }
  debug('元素提取完成', { sources: sources.map(summarizeSource), avatarFailures })
  return { sources, avatarFailures }
}

export async function extractInitialSources(session: Session, limit = 2, debug: DebugLog = noopDebug) {
  // 引用消息是上下文，优先级高于当前指令消息。默认截取两张以兼容
  // 原有调用者；批量子指令会显式传入 batchMaxImages，以便一次指令携带多图。
  debug('提取初始输入', { limit, session: summarizeSession(session), quote: summarizeElements(session.quote?.elements) })
  const quoteElements = session.quote?.elements ?? []
  const quoted = await extractElements(session, quoteElements, false, debug)
  const current = await extractElements(session, session.elements ?? [], true, debug)
  const result = {
    sources: [...quoted.sources, ...current.sources].slice(0, limit),
    avatarFailures: [...quoted.avatarFailures, ...current.avatarFailures],
  }
  debug('初始输入提取完成', { quoted, current, result: { ...result, sources: result.sources.map(summarizeSource) } })
  return result
}

const videoName = /\.(mp4|webm|mov|mkv|m4v|avi|3gp|mpeg|mpg|ts|m3u8)$/i

function isVideoElement(element: h) {
  if (element.type === 'video') return true
  if (element.type !== 'file') return false
  const mime = String(element.attrs.mime || element.attrs.mediaType || '')
  if (mime.startsWith('video/')) return true
  const name = String(element.attrs.filename || element.attrs.name || element.attrs.src || element.attrs.url || '')
  return videoName.test(name)
}

function* walkVideos(elements: readonly h[]): Iterable<h> {
  for (const element of elements) {
    if (isVideoElement(element)) {
      yield element
      continue
    }
    if (element.children?.length) yield* walkVideos(element.children)
  }
}

function videoSourcesFrom(elements: readonly h[] | undefined, debug: DebugLog) {
  const sources: string[] = []
  for (const element of walkVideos(elements ?? [])) {
    const source = element.attrs.src || element.attrs.url
    debug('遇到视频元素', { type: element.type, attrs: element.attrs, source })
    if (typeof source === 'string' && source) sources.push(source)
    else debug('视频元素没有 src/url', { type: element.type, attrs: element.attrs })
  }
  return sources
}

export function extractInitialVideoSources(session: Session, debug: DebugLog = noopDebug) {
  debug('提取初始视频', { session: summarizeSession(session), quote: summarizeElements(session.quote?.elements) })
  const sources = [
    ...videoSourcesFrom(session.quote?.elements, debug),
    ...videoSourcesFrom(session.elements, debug),
  ]
  debug('初始视频提取完成', { sources: sources.map(summarizeSource) })
  return sources
}

async function generate(ctx: Context, session: Session, sources: string[], config: Config, debug: DebugLog = noopDebug) {
  debug('开始生成 APNG', { sources: sources.map(summarizeSource), maxFileSize: config.maxFileSize, maxDimension: config.maxDimension })
  try {
    // 两张图可以并行下载；编码仍按 sources 的既定顺序使用结果。
    const maxBytes = config.maxFileSize * 1024 * 1024
    const [first, second] = await Promise.all(sources.slice(0, 2).map(source => downloadImage(ctx, source, maxBytes, debug)))
    debug('两张图片已下载', { firstBytes: first.length, secondBytes: second.length })
    const output = await createTwoFrameApng(ctx, first, second, config.maxDimension)
    debug('APNG 编码完成，准备发送', { bytes: output.length })
    await sendPngImage(session, output, sendOptions(config), debug)
    debug('APNG 已发送')
  } catch (error) {
    const message = error instanceof ImageInputError ? error.message : '生成两帧 APNG 失败'
    debug('生成 APNG 失败', summarizeError(error))
    ctx.logger(name).warn(error)
    await session.send(message)
  }
}

async function generateBatch(ctx: Context, session: Session, sources: string[], config: Config, debug: DebugLog = noopDebug) {
  // sources[0] 是所有输出共用的第一帧；sources[1..n] 依次作为第二帧。
  // 因此收集 n 张图片时，最多会向会话发送 n - 1 个独立 APNG。
  debug('开始批量生成', { count: sources.length, sources: sources.map(summarizeSource) })
  const maxBytes = config.maxFileSize * 1024 * 1024
  let first: Buffer
  try {
    // 首图会被所有结果复用，只下载一次。其余图片逐张处理，避免批量上限较大时占用过多内存。
    first = await downloadImage(ctx, sources[0], maxBytes, debug)
    debug('批量任务首图已下载', { bytes: first.length })
  } catch (error) {
    const message = error instanceof ImageInputError ? error.message : '生成两帧 APNG 失败'
    debug('批量任务首图下载失败', summarizeError(error))
    ctx.logger(name).warn(error)
    await session.send(`批量任务的第一张图片处理失败：${message}`)
    return
  }

  const outputs: Buffer[] = []
  let succeeded = 0
  for (let index = 1; index < sources.length; index++) {
    try {
      // 下载、解码、Canvas 处理和发送均放在单张图片的 try 中。
      // 某个第二帧损坏或超限时，只跳过该结果，不中断后面的批量任务。
      debug('处理批量第 n 张图', { index: index + 1, source: summarizeSource(sources[index]) })
      const second = await downloadImage(ctx, sources[index], maxBytes, debug)
      const output = await createTwoFrameApng(ctx, first, second, config.maxDimension)
      outputs.push(output)
      succeeded++
      debug('批量单张生成成功', { index: index + 1, bytes: output.length })
    } catch (error) {
      const message = error instanceof ImageInputError ? error.message : '生成两帧 APNG 失败'
      debug('批量单张生成失败', { index: index + 1, error: summarizeError(error) })
      ctx.logger(name).warn(error)
      await session.send(`第 ${index + 1} 张图片处理失败：${message}`)
    }
  }
  debug('批量处理结束', { succeeded, total: sources.length - 1 })
  if (outputs.length) await sendPngImages(session, outputs, sendOptions(config), debug, config.mergeForward)
  await session.send(`批量处理完成，成功生成 ${succeeded}/${sources.length - 1} 张 APNG。`)
}

async function generateVideo(ctx: Context, session: Session, source: string, config: Config, debug: DebugLog = noopDebug) {
  debug('开始将视频转为 APNG', { source: summarizeSource(source), videoMaxFileSize: config.videoMaxFileSize })
  try {
    await session.send('正在处理视频，请稍候...')
    const maxBytes = config.videoMaxFileSize * 1024 * 1024
    const input = await downloadVideo(ctx, source, maxBytes, debug)
    debug('视频已下载', { bytes: input.length })
    const outputs = await createApngsFromVideo(ctx, input, {
      maxDuration: config.videoMaxDuration,
      fps: config.videoFps,
      maxFrames: config.videoMaxFrames,
      maxDimension: config.videoMaxDimension,
      splitOnOverflow: config.videoSplitOnOverflow,
      shareThumbnail: config.videoSplitShareThumbnail,
    }, debug)
    debug('视频 APNG 编码完成，准备发送', { count: outputs.length, bytes: outputs.map(item => item.length) })
    await sendPngImages(session, outputs, sendOptions(config), debug, config.mergeForward)
    if (outputs.length > 1) await session.send(`视频已按时长拆成 ${outputs.length} 张 APNG。`)
    debug('视频 APNG 已发送')
  } catch (error) {
    const message = error instanceof ImageInputError ? error.message : '将视频转为 APNG 失败'
    debug('将视频转为 APNG 失败', summarizeError(error))
    ctx.logger(name).warn(error)
    await session.send(message)
  }
}

export function apply(ctx: Context, config: Config) {
  // 收集状态只存于内存；机器人重启或插件卸载后不会恢复未完成任务。
  const collections = new Map<string, Collection>()
  const debug = createDebugLogger(ctx, config.debug)
  if (config.debug) ctx.logger(name).info('调试模式已开启')

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
        debug('收集任务超时', { key, mode: collection.mode, collected: collection.sources.length, limit: collection.limit })
        collections.delete(key)
        const timeoutMessage = collection.mode === 'video' ? '视频收集已超时，任务已取消。' : '图片收集已超时，任务已取消。'
        await collection.session.bot.sendMessage(collection.session.channelId!, timeoutMessage).catch(() => {})
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
    debug('收集中间件收到消息', { key, content, session: summarizeSession(session), elements: summarizeElements(session.elements) })
    if (isOwnCommand(session.content ?? '', config)) {
      debug('收集期间再次触发本插件指令，交给命令系统处理', { key, content })
      return next()
    }

    // 同一收集任务的消息按到达顺序串行执行。callback 返回 true 表示
    // “取消”或“开始”已被本插件消费；false 则在退出队列后继续调用其他中间件。
    const consumed = await enqueue(collection, async () => {
      // 排队期间，前一条消息可能已经收满上限、取消或开始了任务。
      // 此时当前消息不再属于旧任务，应交还中间件链，而不能继续写入已移除的 sources。
      if (collections.get(key) !== collection) return false

      if (content === '取消') {
        // “取消”是收集状态下的控制消息，由本插件消费，不再交给其他指令解析。
        debug('用户取消收集任务', { key })
        clear(key)
        await session.send(collection.mode === 'video' ? '已取消视频收集。' : '已取消图片收集。')
        return true
      }
      if (collection.mode === 'video') {
        const videos = videoSourcesFrom(session.elements, debug)
        collection.session = session
        if (!videos.length) {
          resetTimer(key, collection)
          await session.send('请发送一个视频；发送“取消”可结束任务。')
          return false
        }
        clear(key)
        debug('视频收集完成，开始转换', { key, source: summarizeSource(videos[0]) })
        await generateVideo(ctx, session, videos[0], collection.taskConfig, debug)
        return false
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
        debug('批量任务收到开始', { key, collected: collection.sources.length })
        await generateBatch(ctx, session, collection.sources, collection.taskConfig, debug)
        return true
      }

      const extracted = await extractElements(session, session.elements ?? [], false, debug)
      debug('收集消息提取结果', { key, extracted, previous: collection.sources.length, limit: collection.limit })
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
        debug('收集数量已满，开始生成', { key, mode: collection.mode, sources: collection.sources.map(summarizeSource) })
        if (collection.mode === 'batch') await generateBatch(ctx, session, collection.sources, collection.taskConfig, debug)
        else await generate(ctx, session, collection.sources, collection.taskConfig, debug)
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
    .option('dimension', '-d <px:number> 本次最大像素数')
  // 当管理员把主指令配置成某个别名时，避免重复注册相同名称。
  for (const alias of aliases) {
    if (alias !== config.commandName) command.alias(alias)
  }
  command.action(async ({ session, options = {} }) => {
    if (!session?.userId || !session.channelId) return '当前会话无法收集图片。'
    const key = collectionKey(session)
    debug('收到主指令', { key, session: summarizeSession(session), elements: summarizeElements(session.elements), options })
    // 重复触发不会重置或追加现有任务，用户必须先完成或明确取消。
    if (collections.has(key)) {
      debug('已有收集任务，拒绝重复触发', { key })
      return '已有收集任务，请先完成或发送“取消”。'
    }

    const taskConfig = withConfig(config, {
      maxDimension: overrideNumber(options.dimension, config.maxDimension, 64),
    })
    const extracted = await extractInitialSources(session, 2, debug)
    for (const userId of extracted.avatarFailures) await session.send(`无法获取 @${userId} 的头像，已跳过。`)
    if (extracted.sources.length >= 2) {
      // 触发消息已经提供两张图时立即生成，不创建临时收集状态。
      debug('主指令已凑齐两张图，立即生成', { sources: extracted.sources.map(summarizeSource), maxDimension: taskConfig.maxDimension })
      await generate(ctx, session, extracted.sources, taskConfig, debug)
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
      taskConfig,
    }
    collections.set(key, collection)
    resetTimer(key, collection)
    debug('进入普通收集模式', { key, collected: collection.sources.length, maxDimension: taskConfig.maxDimension })
    return `还需要 ${2 - collection.sources.length} 张图片，请继续发送；发送“取消”可结束任务。`
  })

  if (config.enableBatchCommand) {
    // 仅在显式开启配置时注册子指令，关闭时不会占用指令名。
    // 子指令前缀跟随 commandName：例如主指令改为 foo 后，调用方式为 foo.batch。
    const batch = ctx.command(`${config.commandName}.batch`, '批量生成共用第一帧的 APNG')
      .alias(`${config.commandName}.批量`)
      .option('count', '-n <count:number> 本次最多收集的图片数')
    batch.action(async ({ session, options = {} }) => {
      if (!session?.userId || !session.channelId) return '当前会话无法收集图片。'
      const key = collectionKey(session)
      debug('收到批量指令', { key, session: summarizeSession(session), elements: summarizeElements(session.elements), options })
      if (collections.has(key)) {
        debug('已有收集任务，拒绝重复触发批量指令', { key })
        return '已有收集任务，请先完成或发送“取消”。'
      }

      const limit = overrideNumber(options.count, config.batchMaxImages, 2)
      const taskConfig = withConfig(config, { batchMaxImages: limit })
      const extracted = await extractInitialSources(session, limit, debug)
      for (const userId of extracted.avatarFailures) await session.send(`无法获取 @${userId} 的头像，已跳过。`)
      const collection: Collection = {
        sources: extracted.sources,
        mode: 'batch',
        limit,
        timer: undefined as never,
        queue: Promise.resolve(),
        session,
        taskConfig,
      }
      // 用户可以在调用子指令时就附带多张图片。如果触发消息本身已达上限，
      // 立即执行批量处理，无需把一个永远不会再收集的任务放入 Map 或创建计时器。
      if (collection.sources.length >= collection.limit) {
        debug('批量指令已达上限，立即生成', { sources: collection.sources.map(summarizeSource) })
        await generateBatch(ctx, session, collection.sources, taskConfig, debug)
        return
      }
      // 未达上限时，即使已有两张也不自动生成；这是批量模式与普通模式
      // 最关键的差异。后续由收集中间件处理新图片、“开始”和“取消”。
      collections.set(key, collection)
      resetTimer(key, collection)
      debug('进入批量收集模式', { key, collected: collection.sources.length, limit: collection.limit })
      return `已进入批量收集，当前 ${collection.sources.length}/${collection.limit} 张；至少收集 2 张后发送“开始”可处理，发送“取消”可结束任务。`
    })
  }

  if (config.enableVideoCommand) {
    // 仅在显式开启配置时注册子指令，关闭时不会占用指令名。
    // 子指令前缀跟随 commandName：例如主指令改为 foo 后，调用方式为 foo.video。
    const video = ctx.command(`${config.commandName}.video`, '将视频转换为 APNG 动图')
      .alias(`${config.commandName}.视频`)
      .option('duration', '-t <seconds:number> 本次最长时长（秒）')
      .option('fps', '-f <fps:number> 本次抽帧帧率')
      .option('frames', '-F <count:number> 本次最多写入 APNG 的帧数')
      .option('dimension', '-d <px:number> 本次最大像素数')
      .option('thumb', '-T [on:boolean] 每张切片使用整个视频的第一帧作为第一帧')
    video.action(async ({ session, options = {} }) => {
      if (!session?.userId || !session.channelId) return '当前会话无法收集视频。'
      if (!ctx.ffmpeg) return '将视频转为 APNG 需要启用 ffmpeg 服务。'
      const key = collectionKey(session)
      debug('收到视频指令', { key, session: summarizeSession(session), elements: summarizeElements(session.elements), options })
      if (collections.has(key)) {
        debug('已有收集任务，拒绝重复触发视频指令', { key })
        return '已有收集任务，请先完成或发送“取消”。'
      }

      const taskConfig = withConfig(config, {
        videoMaxDuration: overrideNumber(options.duration, config.videoMaxDuration, 1),
        videoFps: overrideNumber(options.fps, config.videoFps, 1),
        videoMaxFrames: overrideNumber(options.frames, config.videoMaxFrames, 1),
        videoMaxDimension: overrideNumber(options.dimension, config.videoMaxDimension, 64),
        videoSplitShareThumbnail: overrideBoolean(options.thumb, config.videoSplitShareThumbnail),
      })
      const sources = extractInitialVideoSources(session, debug)
      if (sources.length) {
        debug('视频指令已找到视频，立即转换', { source: summarizeSource(sources[0]), taskConfig: {
          videoMaxDuration: taskConfig.videoMaxDuration,
          videoFps: taskConfig.videoFps,
          videoMaxFrames: taskConfig.videoMaxFrames,
          videoMaxDimension: taskConfig.videoMaxDimension,
          videoSplitShareThumbnail: taskConfig.videoSplitShareThumbnail,
        } })
        await generateVideo(ctx, session, sources[0], taskConfig, debug)
        return
      }

      const collection: Collection = {
        sources: [],
        mode: 'video',
        limit: 1,
        timer: undefined as never,
        queue: Promise.resolve(),
        session,
        taskConfig,
      }
      collections.set(key, collection)
      resetTimer(key, collection)
      debug('进入视频收集模式', { key })
      return '请发送一个视频，或引用一条包含视频的消息后再次使用本指令；发送“取消”可结束任务。'
    })
  }
}

function sendOptions(config: Config) {
  return {
    mode: config.imageSendMode,
    thresholdKiB: config.imageFileThreshold,
    fileThresholdBytes: config.fileSendThreshold * 1024 * 1024,
  }
}

function withConfig(config: Config, overrides: Partial<Config>): Config {
  return { ...config, ...overrides }
}

function overrideNumber(value: unknown, fallback: number, min: number) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.round(parsed))
}

function overrideBoolean(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false
  return fallback
}

export { createTwoFrameApng, downloadImage, downloadVideo, sendPngImage, sendPngImages } from './image'
export { encodeTwoFrameApng, encodeTwoFramePngs, encodePngFrames, crc32 } from './apng'
export { createApngFromVideo, createApngsFromVideo, parseFfmpegDuration, chooseVideoFps, splitVideoSegments } from './video'
