# koishi-plugin-apng-two-frame

将两张图片合成为两帧 APNG 的 Koishi 插件，用于聊天列表缩略图与点开后画面不同的趣味效果。也可以批量生成，或把视频转成 APNG 动图。

> [!IMPORTANT]
> 插件生成的是符合规范的 **APNG（PNG 动图）**，不是 JPEG，也不会改成虚假的 `.jpg` 文件名。缩略图效果取决于聊天平台、客户端版本和适配器的图片处理方式。目前主要面向 **QQ + NapCat + OneBot 11**，其他平台可以生成图片，但不保证显示效果一致。

## 效果原理

两帧模式下会生成一个无限循环的 APNG：

| 帧 | 内容 | 持续时间 |
| --- | --- | --- |
| 第一帧 | 第一张输入图片 | 10 毫秒 |
| 第二帧 | 第二张输入图片 | 999 秒 |

第二张图片决定最终画布尺寸。第一张图片会保持宽高比缩小并居中，空白区域填充白色；小图不会被放大。第二张图片除 EXIF 自动转正和统一像素格式外，不会被缩放或裁切。

部分客户端会使用极短的第一帧生成缩略图，用户点开后通常看到停留很久的第二帧，由此产生视觉差异。

## 安装

可以在 Koishi 插件市场搜索 `apng-two-frame` 安装，或在 Koishi 应用目录运行：

```bash
npm install koishi-plugin-apng-two-frame
```

运行依赖：

- **必需：** 启用 Koishi 的 `puppeteer` 服务，由浏览器负责图片解码和 Canvas 处理；
- **可选：** 启用任意能提供 `ffmpeg` 服务的插件，用于提取 GIF 第一帧，以及把视频转成 APNG；
- 插件只依赖 `ffmpeg` 服务接口，不绑定某一个 FFmpeg 插件，也不会自行安装系统 FFmpeg；
- 未启用 FFmpeg 时，其他浏览器支持的图片格式仍可处理，但收到 GIF 或使用视频子指令会返回明确提示。

从源码开发时：

```bash
git clone https://github.com/DNAlec/koishi-plugin-apng-two-frame.git
cd koishi-plugin-apng-two-frame
npm install
npm run build
```

构建完成后，将插件安装或链接到 Koishi 应用，并在控制台启用。控制台只显示**当前已加载插件**里的配置项；改完源码后需要先编译，再停用/启用插件或重启 Koishi。

## 使用方法

默认主指令为 `apng`，别名：

```text
两帧
两帧动图
```

修改配置里的 `commandName` 后，主指令和子指令前缀会一起改变。

### 两帧合成

同一条消息附带两张图片：

```text
apng [图片1] [图片2]
apng -d 1280 [图片1] [图片2]
```

图片按消息中出现的先后顺序使用。`-d` / `--dimension` 指定本次最大像素数，未写则用 `maxDimension`。

也可以：

- 引用一条含图消息后再发 `apng`（引用图优先于当前消息）；
- 在指令中 @群成员，按元素顺序把头像加入输入。`@全体成员` 会被忽略；开头用于唤起机器人的 `@机器人` 视为前缀并跳过。

图片不足两张时进入收集模式，同一用户在同一频道继续发图或 @ 即可补齐。发送完全匹配的 `取消` 可结束任务，超时后自动取消。收集期间重复调用本插件指令不会重置已有任务。

### 批量生成

在配置中开启 `enableBatchCommand` 后：

```text
apng.batch
apng.批量
apng.batch -n 6
```

不会在收到 2 张时立即处理。继续收集直到本次上限，或至少 2 张后发送完全匹配的「开始」。第一张图作为每张结果的第一帧，其余每张分别作为第二帧，收集 N 张最多生成 N − 1 张 APNG。`-n` / `--count` 指定本次最多收集的图片数，未写则用 `batchMaxImages`。

### 视频转 APNG

在「视频转换」中开启 `enableVideoCommand`，并启用 `ffmpeg` 服务后：

```text
apng.video
apng.视频
apng.video -t 15 -f 8 -F 60 -d 720 -T
```

可在同一条消息附带视频、引用含视频的消息，或先发指令再补发视频。一条消息中有多个视频时只用第一个；以文件形式发送且扩展名或 MIME 为视频的附件也会被识别。

| 参数 | 说明 |
| --- | --- |
| `-t` / `--duration` | 最长时长（秒） |
| `-f` / `--fps` | 抽帧帧率 |
| `-F` / `--frames` | 最多写入 APNG 的帧数 |
| `-d` / `--dimension` | 最大像素数 |
| `-T` / `--thumb` | 每张切片使用整个视频的第一帧作为第一帧；也可 `-T false` 关闭 |

未写的参数使用配置默认值。时长超过 `videoMaxDuration` 时默认拒绝转换；开启 `videoSplitOnOverflow` 后会按该上限切成多张。再开启 `videoSplitShareThumbnail`（或本次加 `-T`）后，每张切片都会把整个视频的第一帧作为自己的第一帧（10 毫秒），以便聊天列表使用相同缩略图。

转换后的 APNG **往往会比原视频大很多**：视频按帧差压缩，APNG 接近逐帧整图。按默认 10 秒、512 像素、15 fps、最多 90 帧，常见到十几 MB。可降低像素、帧率、时长或帧数来控制体积。

## 发送方式

- `imageSendMode` 默认 `auto`：小图走内嵌 base64；超过 `imageFileThreshold`（默认 256 KiB）时写入临时文件（一般在 `/tmp`，尊重 `TMPDIR`），再以 `file://` 交给协议端读取，避免大图撑爆 OneBot WebSocket。
- 单张结果大于 `fileSendThreshold`（默认 20 MiB）时改为发送**文件附件**，而不是聊天图片。
- 开启 `mergeForward` 后，批量或视频分割产生的多张结果会打成一条**合并转发**；转发节点里一律按图片发送（即使超过 20 MiB 也不会拆成群文件）。平台不支持或发送失败时退回逐条发送。图片过大时合并转发可能失败，体积没有把握时不建议开启。
- `file://` 要求协议端能读取 Koishi 所在机器的临时目录（同机，或 Docker 下共享挂载）。读不到时可把 `imageSendMode` 改回 `base64`。

## 配置

控制台分组：基础项、视频转换、调试。视频相关项仅在开启视频指令后展开；共用封面帧仅在开启超时分割后显示。

### 基础

| 配置项 | 类型 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `commandName` | `string` | `apng` | — | 主指令名称 |
| `maxFileSize` | `number` | `10` | 1–100 | 单张图片大小上限，单位 MiB |
| `maxDimension` | `number` | `4096` | 64–16384 | 输入图片宽或高的最大像素数 |
| `collectTimeout` | `number` | `60` | 5–3600 | 等待后续图片或视频的超时时间，单位秒 |
| `enableBatchCommand` | `boolean` | `false` | — | 是否启用 `batch`（批量）子指令 |
| `batchMaxImages` | `number` | `10` | 2–100 | 批量任务收集上限，包含第一张公用图 |
| `imageSendMode` | `auto` / `file` / `base64` | `auto` | — | 图片发送方式 |
| `imageFileThreshold` | `number` | `256` | ≥1 | `auto` 模式下超过该大小（KiB）改用临时文件发送 |
| `fileSendThreshold` | `number` | `20` | ≥0 | 单张 APNG 大于该大小（MiB）时改为文件附件；0 表示始终按图片发送 |
| `mergeForward` | `boolean` | `false` | — | 多张结果使用合并转发；过大图片可能导致转发失败 |

### 视频转换

| 配置项 | 类型 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `enableVideoCommand` | `boolean` | `false` | — | 是否启用 `video`（视频）子指令 |
| `videoMaxFileSize` | `number` | `50` | ≥1 | 单个视频文件大小上限，单位 MiB |
| `videoMaxDuration` | `number` | `10` | ≥1 | 允许转换的最长视频时长，单位秒 |
| `videoFps` | `number` | `15` | ≥1 | 抽帧目标帧率；超过最大帧数时自动降低 |
| `videoMaxFrames` | `number` | `90` | ≥1 | 每张 APNG 最多写入的帧数 |
| `videoMaxDimension` | `number` | `512` | ≥64 | 输出宽或高的最大像素数；只缩小不放大 |
| `videoSplitOnOverflow` | `boolean` | `false` | — | 时长超过上限时自动分割成多张 APNG |
| `videoSplitShareThumbnail` | `boolean` | `false` | — | 每张切片使用整个视频的第一帧作为缩略图 |

### 调试

| 配置项 | 类型 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `debug` | `boolean` | `false` | — | 以 info 级别输出会话、@头像解析、收集和下载详情（logger 名称为 `koishi-plugin-apng-two-frame`） |

## 输入处理

- 支持适配器提供的消息图片、成员头像和视频；不解析消息中的普通文本 URL。
- PNG、JPEG、WebP、BMP 和 APNG 等由 Chromium 解码，实际范围取决于浏览器版本。
- APNG / 动态 WebP 由浏览器读取静态帧；GIF 使用可选的 FFmpeg 服务提取第一帧。
- 视频由同一套 `ffmpeg` 服务抽帧。超过文件大小限制会拒绝；超过时长时按配置拒绝或分割。
- 自动应用手机照片的 EXIF Orientation。
- 通过流式下载执行体积限制。损坏、不支持的格式或超过图片尺寸限制会被拒绝。

取图优先级：

1. 引用消息中的图片和 @头像，按元素顺序；
2. 当前指令消息中的图片和 @头像，按元素顺序；
3. 后续收集消息中的图片和 @头像，按到达及元素出现顺序。

普通模式只用前两张；批量模式用前 `batchMaxImages` 张（或本次 `-n`）。

## 平台兼容性

- **QQ + NapCat + OneBot 11**：主要目标环境；
- **其他 Koishi 平台**：允许生成和发送，但平台可能重编码、压缩或只保留静态首帧；
- 即使使用相同平台，不同客户端版本也可能采用不同的缩略图策略。

插件保证 APNG 结构和帧内容正确，但不能保证所有客户端都出现缩略图差异。

## 本地开发

要求 Node.js 18.17+、Koishi 4，并启用 `koishi-plugin-puppeteer`。处理 GIF 或视频时还需任意 `ffmpeg` 服务实现。

```bash
npm install
npm run build
npm run dev
npm test
```

测试覆盖 APNG chunk 顺序、CRC、帧延时、多帧编码、浏览器 PNG 数据流复用、FFmpeg 服务缺失降级、消息取图/取视频顺序、指令参数、发送方式（base64 / file:// / 文件附件 / 合并转发）、批量和视频子指令开关，以及并发收集。

## 发布

仓库通过 GitHub Actions 和 npm Trusted Publishing 自动发布。维护者应先更新 `package.json` 与 `package-lock.json` 中的版本并提交，然后创建完全匹配的 `v<版本号>` 标签：

```bash
git tag v1.3.0
git push origin v1.3.0
```

Trusted Publisher 配置：GitHub `DNAlec` / `koishi-plugin-apng-two-frame`，工作流 `publish.yml`，允许 `npm publish`。使用 OIDC 短期凭据，不需要 `NPM_TOKEN`。

## 实现说明

输入图片由 Puppeteer 完成 EXIF 转正、缩放、居中与 PNG 规范化。视频由 `ffmpeg` 服务抽成 PNG 序列。随后在 Node.js 中构造 PNG/APNG chunks，并复用 PNG 自带的 IDAT 压缩流：

```text
PNG Signature
IHDR
acTL
fcTL (第一帧)
IDAT (第一帧像素)
fcTL / fdAT (后续帧)
IEND
```

本插件没有生产 npm 依赖。Puppeteer 和 FFmpeg 通过 Koishi 服务复用，不绑定具体实现插件。

## 致谢与参考实现

移除 `sharp` 的浏览器图像处理方案参考了 [koishi-plugin-patina 的 APNG 实现](https://github.com/koishi-shangxue-plugins/koishi-shangxue-apps/blob/907c3247ebd9c4433fe1fb2ca69ff9ca9f4612f6/plugins/patina/html/apng/apng.html)，原作者为 [shangxueink](https://github.com/shangxueink)。参考项目采用 MIT 许可证。

## 许可证

MIT。见 `package.json` 与 `LICENSE`。

## 反馈

请在 [GitHub Issues](https://github.com/DNAlec/koishi-plugin-apng-two-frame/issues) 提交，并附上：Koishi 版本、适配器及版本、NapCat 和 QQ 客户端版本（若使用 OneBot）、插件配置，以及可复现的输入（注意移除隐私信息）。
