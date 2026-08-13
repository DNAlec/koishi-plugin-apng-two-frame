# koishi-plugin-apng-two-frame

将两张图片合成为两帧 APNG 的 Koishi 插件，主要用于实现聊天列表缩略图与点开后画面不同的趣味效果。

> [!IMPORTANT]
> 插件生成的是符合规范的 **APNG（PNG 动图）**，不是 JPEG，也不会修改成虚假的 `.jpg` 文件名。缩略图效果取决于聊天平台、客户端版本和适配器的图片处理方式。目前主要面向 **QQ + NapCat + OneBot 11**，其他平台可以生成图片，但不保证显示效果一致。

## 效果原理

插件会生成一个无限循环的两帧 APNG：

| 帧 | 内容 | 持续时间 |
| --- | --- | --- |
| 第一帧 | 第一张输入图片 | 10 毫秒 |
| 第二帧 | 第二张输入图片 | 999 秒 |

第二张图片决定最终画布尺寸。第一张图片会保持宽高比缩小并居中，空白区域填充白色；小图不会被放大。第二张图片除 EXIF 自动转正和统一像素格式外，不会被缩放或裁切。

部分客户端会使用极短的第一帧生成缩略图，而用户点开图片后通常看到停留时间很长的第二帧，由此产生视觉差异。

## 安装

可以在 Koishi 插件市场搜索 `apng-two-frame` 安装，或在 Koishi 应用目录运行：

```bash
npm install koishi-plugin-apng-two-frame
```

运行依赖：

- **必需：** 启用 Koishi 的 `puppeteer` 服务，由浏览器负责图片解码和 Canvas 处理；
- **可选：** 启用 Koishi 的 `ffmpeg` 服务，用于可靠地提取 GIF 第一帧；
- 未启用 FFmpeg 时，插件仍可处理其他受浏览器支持的图片格式，但收到 GIF 会返回明确提示；
- 插件本身不再依赖 `sharp` 或 libvips。

从源码开发时：

```bash
git clone https://github.com/DNAlec/koishi-plugin-apng-two-frame.git
cd koishi-plugin-apng-two-frame
npm install
npm run build
```

构建完成后，将插件安装或链接到你的 Koishi 应用，并在控制台的插件配置中启用。

## 使用方法

默认主指令为：

```text
apng
```

同时提供以下别名：

```text
两帧
两帧动图
```

### 直接发送两张图片

在同一条指令消息中附带两张图片：

```text
apng [图片1] [图片2]
```

图片按照消息中出现的先后顺序使用。

### 使用引用消息

引用一条包含图片的消息，然后发送 `apng`。引用消息中的图片优先于当前指令消息中的图片。

例如：

1. 引用一张图片；
2. 发送 `apng` 并附带另一张图片；
3. 被引用的图片作为第一帧，当前消息中的图片作为第二帧。

### 使用群成员头像

可以在指令中 @群成员，插件会尝试获取该成员头像，并按照 @元素在消息中的位置加入输入序列：

```text
apng @成员A @成员B
```

`@全体成员` 和机器人自身会被忽略。头像获取失败时，插件会提示并继续等待其他图片。

### 分多条消息收集

如果触发指令时不足两张图片，插件会进入收集模式。之后由同一用户在同一频道发送的图片或 @成员头像会继续加入当前任务，直到收集两张图片并自动生成。

- 收集任务按“平台 + 频道 + 用户”隔离；
- 普通无图消息会收到尚缺图片数量的提示；
- 收集期间重复调用指令不会重置已有任务；
- 发送完全匹配的 `取消` 可以结束当前任务；
- 超过配置的等待时间后任务会自动取消。

## 配置

| 配置项 | 类型 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `commandName` | `string` | `apng` | — | 主指令名称 |
| `maxFileSize` | `number` | `10` | 1–100 | 单张图片大小上限，单位 MiB |
| `maxDimension` | `number` | `4096` | 64–16384 | 输入图片宽或高的最大像素数 |
| `collectTimeout` | `number` | `60` | 5–3600 | 等待后续图片的超时时间，单位秒 |

## 输入处理

- 支持适配器提供的消息图片和成员头像；
- 不解析消息中的普通文本 URL；
- PNG、JPEG、WebP、BMP 和 APNG 等格式由 Chromium 解码，实际支持范围取决于所使用的浏览器版本；
- APNG 和动态 WebP 等动图由浏览器读取静态帧；GIF 使用可选的 FFmpeg 服务提取第一帧；
- 自动应用手机照片的 EXIF Orientation；
- 通过流式下载执行文件大小限制，避免完整下载超限文件；
- 拒绝损坏图片、不支持的格式以及超过尺寸限制的图片。

当一条消息提供超过两张图片时，仅使用按优先级排序后的前两张：

1. 引用消息中的图片和 @头像，按照元素顺序；
2. 当前指令消息中的图片和 @头像，按照元素顺序；
3. 后续收集消息中的图片和 @头像，按照消息到达及元素出现顺序。

## 平台兼容性

插件通过 Koishi 的 `image/png` 图片元素发送 APNG。`koishi-plugin-adapter-onebot` 会将 base64 图片转换为 OneBot 可发送的格式。

- **QQ + NapCat + OneBot 11**：主要目标环境；
- **其他 Koishi 平台**：允许生成和发送，但平台可能重编码、压缩或只保留静态首帧；
- 即使使用相同平台，不同客户端版本也可能采用不同的缩略图生成策略。

因此，插件保证生成文件的 APNG 结构和帧内容正确，但不能保证所有客户端都出现缩略图差异。

## 本地开发

要求：

- Node.js 18.17 或更高版本；
- Koishi 4；
- 已安装并启用 `koishi-plugin-puppeteer`；
- 如需处理 GIF，安装并启用 `koishi-plugin-ffmpeg`。

常用命令：

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 监听源码变化
npm run dev

# 编译并运行测试
npm test
```

测试覆盖 APNG chunk 顺序、CRC、帧延时、无限循环、浏览器 PNG 数据流复用、可选 FFmpeg 降级和消息取图顺序。

## 实现说明

插件不再依赖 `sharp` 或 libvips。输入图片由 Puppeteer 中的浏览器图像解码器和 Canvas 完成 EXIF 转正、缩放、居中与 PNG 规范化，随后在 Node.js 中直接构造以下 PNG/APNG chunks：

```text
PNG Signature
IHDR
acTL
fcTL (第一帧)
IDAT (第一帧像素)
fcTL (第二帧)
fdAT (第二帧像素)
IEND
```

编码器直接复用 Canvas 导出 PNG 的 IDAT 压缩流，避免通过 Puppeteer 传输完整 RGBA 像素。所有 chunk 均生成正确的长度、动画序号和 CRC-32。源码中包含对应格式和处理流程的中文注释。

本插件没有生产 npm 依赖，当前发布包压缩后约 20 KB。Puppeteer 和 FFmpeg 通过 Koishi 服务复用，不会作为本插件的生产依赖打包；其中 Puppeteer 仍需要运行环境提供 Chrome 或 Chromium。

## 致谢与参考实现

移除 `sharp` 的浏览器图像处理方案参考了 [koishi-plugin-patina 的 APNG 实现](https://github.com/koishi-shangxue-plugins/koishi-shangxue-apps/blob/907c3247ebd9c4433fe1fb2ca69ff9ca9f4612f6/plugins/patina/html/apng/apng.html)，原作者为 [shangxueink](https://github.com/shangxueink)。

参考项目采用 MIT 许可证。本插件在其思路基础上进行了适配：保留纯 Node.js APNG 编码器，并直接复用 Canvas 导出 PNG 的压缩数据流。

## 许可证

MIT。仓库的 `package.json` 已声明该许可证，并包含独立的 `LICENSE` 文件。

## 反馈

遇到问题时，请在 [GitHub Issues](https://github.com/DNAlec/koishi-plugin-apng-two-frame/issues) 提交，并附上：

- Koishi 版本；
- 适配器及版本；
- NapCat 和 QQ 客户端版本（如果使用 OneBot）；
- 插件配置；
- 可复现问题的输入图片（注意移除隐私信息）。
