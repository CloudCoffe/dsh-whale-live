# 大肥鱼直播（dsh-whale-live）

Cordis 插件：让 **大肥鱼**（DeepSeek 的鲸鱼吉祥物 Live2D）在你的 B站 直播间里**听弹幕、自己说话**。

```
观众发弹幕  →  大肥鱼看到  →  大模型随口回一句  →  打表情 + 出声（口型跟着声走）
```

驱动的顺序：**B站 弹幕事件 → 大模型生成台词 → 语音合成 → 边合成边播 + 驱动 VTube Studio 口型/表情**。

> ⚠️ **本仓库只有代码，不含任何美术资源。** 「大肥鱼」是 DeepSeek 的形象，Live2D 模型本身标注了
> `WorkshopSharingForbidden`，模型文件不在仓库里也不随插件分发 —— 要跑请自备模型或先取得授权。
> 另外 B站 对 AI 生成内容有标注要求，开播前记得在直播间说明。

## 装上要什么

| 东西 | 必需？ | 说明 |
| --- | --- | --- |
| VTube Studio | 要驱动皮套就得有 | Steam 免费：<https://store.steampowered.com/app/1325860/VTube_Studio/> |
| 大肥鱼 Live2D 模型 | 同上 | 你自己的那份（`.moc3` / `.model3.json` / `.vtube.json`） |
| ffmpeg（含 ffplay） | 出声推荐 | `winget install Gyan.FFmpeg`；装了才有"边下边播" |
| 声卡 + 虚拟声通道 | 出给观众听才要 | 直播时把系统声音送进 OBS |

## 一、把模型装进 VTube Studio

1. Steam 装好 VTube Studio，**先启动一次**（它会建好模型目录）。
2. 把**整个模型目录**（例如 `大肥鱼-B站\`）丢进 VTS 的 `Live2DModels` 目录：
   - VTS 界面里点齿轮 → **Open models folder**（或 Steam 右键 VTS → 管理 → 浏览本地文件 → `Live2DModels`）
   - 目录里必须有 `大肥鱼.moc3`、`大肥鱼.model3.json`、`大肥鱼.vtube.json`、`大肥鱼.physics3.json`、`大肥鱼.cdi3.json`、`大肥鱼.8192\texture_00.png`
   - ⚠️ `.vtube.json` 里写的图标是 `0001.png`（**相对模型目录**），所以把 `0001.png` 一起放进去，否则模型列表缩略图是空的
3. VTS 里点模型列表 → 选中大肥鱼 → 它会出现在画面里。
4. **打开插件 API**：VTS 设置 → **Plugin API** → 打开 *Allow Plugin API access*（默认端口 8001）。第一次连接时 VTS 会弹窗问是否允许，点 Allow。
5. 这个模型**没有自带动作**（包里一个 `.motion3.json` 都没有），所以需要"动作"时是插件用 `MoveModelRequest` **把整个模型转角度**做出来的；表情则是打它自带的 15 个热键（`04 脸红`、`05 O O`、`06 X X` …）。
6. 模型带水印时，先按热键 **`13 水印消除`**（或自己改键位）把它去掉；插件也能用 API 触发这个热键。

## 二、装上插件

在 DSH 里（本仓库就是插件包本体）：

```
plugin_manager install_bundle  D:\deepseek harness\chajian\dsh-whale-live
```

装好后：**侧边栏会多一枚鲸鱼图标 → 点它打开「大肥鱼直播」面板**（若没出现，刷新一次页面）。

## 三、开播前点一遍（面板上的按钮）

| 按钮 | 干什么 |
| --- | --- |
| 开始监听 | 连上直播间（房间号 10217886），开始收弹幕 |
| 连接 VTS | 连 VTube Studio；**VTS 会弹窗，点 Allow**（授权令牌存在家目录，下次不用再点） |
| 读取模型热键 | 把模型里的表情热键列出来（确认 15 个表情都在） |
| 语音自检 | 合成一句短句试听，确认整条链路通 |
| 试弹幕 | 不用真有人在看，直接模拟一条弹幕走一遍「匹配 → 回复 → 说话」 |

**默认是干跑模式**（`dryRun: true`）：只记录该说什么、台词是什么，**不驱动皮套、不出声**。
想真的动起来，点面板上最左边那颗「**切到真实驱动**」按钮 —— 它会把设置写进 `config.json` 并**立刻生效**（想切回来再点一下）。

## 四、配置

家目录：`%USERPROFILE%\.dsh\whale-live\`

- `config.json` —— 插件自己的配置（房间号、dryRun、VTS 端口、语音、LLM…）
- `.vts-token.json` —— VTube Studio 授权令牌
- `voice-cache\` —— 合成出来的语音 WAV

DSH 设置页里也能改同样的字段（`roomId` / `dryRun` / `vtsPort` / `ttsEnabled` / `llmEnabled` …）。
两者优先级：**默认值 < config.json < 设置页里显式设过的值**。

## 五、弹幕对话（`chatEnabled`，默认开）

流程：`DANMU_MSG` → 过滤器 → 大模型回一句 → TTS 合成 → 边下边播 + 口型。

### 只回"值得回"的弹幕

`chatSkipReason()` 会跳过：自己发的、`[表情]`、纯标点、超过 80 字（疑似广告）、
`666`/`哈哈哈`/`打卡`/`签到` 这类无信息量的刷屏，以及同一用户 60 秒内重复的同一句话。
理由很实在：一条回复 = 合成 1~2 秒 + 播放 3~5 秒，把额度花在"666"上是纯亏。

### 只回最新那条

一次回复 5~7 秒，房间一热闹就会越说越落后。所以新弹幕到来时会
`queue.dropKey('chat')` 把还没开跑的旧任务丢掉（计入 `queue.stale`），只回最新那句；
**正在念的那句也会被打断**（至少让它念满 0.5 秒再掐，否则像卡带）。

### 节奏

`chatCooldownMs`（默认 2000）= 两次回复之间的最短间隔，也就是"每 2 秒最多回一句"；
真正的吞吐上限还是合成+播放时间。

### 大模型

`llmBaseUrl` / `llmApiKey` / `llmModel`，任何 OpenAI 兼容接口都行。当前用的是
阿里云 DashScope 的兼容口 + `qwen-flash`（实测 476ms 出词，回答短、适合 TTS）。
`qwen-flash-character` 也行，角色感更强但话更长。

带最近 8 条对话（约 4 轮）做上下文，所以能接住"那你还要不要减肥了"这种追问。
大模型没接上（没配 key / 超时 / 报错）时用 `CANNED_CHAT` 里的固定台词轮着兜底，
`plan` 里会标 `台词：固定兜底`，不会让观众干等。

### 收不到弹幕怎么查

先看 `status` 里的 `bili.cmds` —— 它会统计收到过的所有 cmd 名（如 `DANMU_MSG`、`INTERACT_WORD_V2`）。
如果连 `DANMU_MSG` 都没有，问题在连接/房间号，不在过滤器；
如果有 `DANMU_MSG` 但没回复，看 `events` 里那条的 `action`，过滤器跳过的会写明原因。

## 六、Agent 工具

| 工具 | 用途 |
| --- | --- |
| `whale_live_status` | 看状态（房间、连接、VTS、队列、最近事件、`bili.cmds`） |
| `whale_live_control` | `start` / `stop` / `vts-connect` / `vts-hotkeys` / `say` / `clear-expression` / `test-chat` / `probe-voice` / `snapshot` |

例：让大肥鱼说一句话 —— `whale_live_control { action: "say", text: "谢谢大家，我下播啦" }`

## 七、直播推流

VTube Studio 画的是模型，OBS 里用 **窗口捕获 / 游戏捕获** 抓 VTS 窗口 + 抓 DSH 面板做装饰，再推流到 B站（B站开播直接用 RTMP 推流地址，不需要直播伴侣）。

## 八、已知限制

- 模型**没有动作文件**，需要"动作"时是整模型旋转的替代做法，不是骨骼动画；要做真动作得在 Live2D Cubism 里补动作。
- 模型是第三方流传版本（`WorkshopSharingForbidden: true`）；大肥鱼是 DeepSeek 的吉祥物形象，**商用/公开直播请先取得形象权利人的许可**，并按平台要求标注 AI 生成内容。
- 直播间**没开播时收不到任何事件**（插件会每 60 秒重试一次）。
- 语音延迟的大头是云端合成（1~2 秒）和播放时长，不是本地处理。
- UI 面板的中文/英文文案走 DSH 的 locale 服务；面板外观只用了主题 token，跟随 DSH 的明/暗主题。

## 九、实测踩过的坑（VTube Studio 1.35.10 + 大肥鱼）

这几条都是**真机**跑出来的，文档里不写的，下次还会掉进去：

| 坑 | 症状 | 真相 |
| --- | --- | --- |
| **必须用 `ws`，不能用 Node 自带的全局 `WebSocket`** | 每个请求都"超时" | 全局 WebSocket 收 VTS 的帧**全是空帧**（`string(0)`），换 `ws` 客户端立刻正常。所以插件自带 `vendor/ws`（MIT，零运行时依赖），**不需要 npm install** |
| 热键列表接口名 | `APIError 7: Unknown messageType: HotkeyListRequest` | 正确名是 **`HotkeysInCurrentModelRequest`**（而且不需要传 `modelLoaded`） |
| 口型参数 | `APIError 453: Parameter ParamMouthOpenY not found` | VTS **不允许直接注入 Live2D 参数**，只能注入**追踪参数**：口型要用 **`MouthOpen`**（0~1）。模型里那个 `ParamMouthOpenY`（「嘴 开关」）是模型内部映射用的，不能写 |
| 用 API 加载模型 | `APIError 7: Unknown messageType: LoadModelRequest` | 1.35 **没有**这个接口，必须在 VTS 界面里点一下加载；不过模型拷进目录后**不用重启 VTS**，它的模型列表会自己刷新 |

另外两个逻辑坑（也已修）：

- socket 明明连着、但**没授权**时，`connect()` 会直接返回"已连接"，于是"补授权"永远不生效 → 现在连着但未授权会补一次鉴权。
- VTS 回的 `APIError` 以前被当成**超时**（因为只在等"期望的那个 Response"）→ 现在会把 VTS 的原话报出来。

本机实测路径（供参考）：VTS 模型目录在
`D:\SteamLibrary\steamapps\common\VTube Studio\VTube Studio_Data\StreamingAssets\Live2DModels`。

### 表演完必须复位（否则表情一直挂在脸上）

VTS 的表情热键是 **toggle**：触发一次 = 打开，它**不会自己消**。所以 `perform()` 把整段表演包在
`try/finally` 里，`finally` 中必定执行一次 `RemoveAllExpressions` 热键 + 把模型旋转回 `0°`。
没有这一步的后果是：第一次触发某个表情后，那张脸就一直挂着，下一次再触发还会**叠加**。

判断方法：看 `status` 里 `lastAction.plan` 的末尾有没有 **`已复位`**；如果那里是 `复位失败：…`，
说明 VTS 那边没接受（通常是没有连上，或模型里那个 `RemoveAllExpressions` 热键被删了）。

还有一条体验改进：只要 `vtsEnabled` 打开，**第一次表演时会自动连 VTS**，重装/重启 DSH 之后不用再手点「连接 VTS」；万一真没连上，`plan` 里会明确写「VTS 未连接，只出声」，不会无声无息地降级。

## 十、语音后端：BreezeBlue

`ttsEngine: "breeze"` 时走 [BreezeBlue](https://breezeblue.ai) 云端 TTS（模型 `breeze-tts-2`）。音色不靠训练、不需要显卡 —— 用一句话描述捏出来。

配置项（`config.json` / 设置页同名）：`breezeApiKey`、`breezeVoiceId`、`breezeBaseUrl`、
`breezeModel`、`breezeInstructions`、`breezeGuidance`。

### 三个实测踩出来的坑

**1. 不要用 Node 的网络栈去请求它。** 同一句话（`output_format=pcm_24000&delivery=sync`）：

| 走法 | 结果 |
| --- | --- |
| PowerShell `Invoke-WebRequest` | **3.3~3.4 秒**稳定 |
| Node `fetch` | 12.6 秒（IPv6 先试再回退） |
| Node `https` + `family:4` + keepAlive | 27 秒 `ECONNRESET` / 88 秒超时 |

所以 `synthesizeBreeze()` 是 **shell 出 PowerShell 拿音频**，且 API Key 只从 **stdin** 传
（base64，因为 PowerShell 5.1 按本地代码页解码 stdin，直接塞中文会变成乱码 → `ConvertFrom-Json` 报错）。

**2. 根因是代理。** 这台机器开着系统代理 `127.0.0.1:7890`：**.NET / PowerShell 自动走代理，Node 不走**。
所以"Node 北向很差、PowerShell 很好"不是玄学，是代理。也因此早期判定"`/stream` 不能用"
是**错的** —— 那是 Node 绕过代理走了坏路，走代理的流式一切正常。

**3. 失败绝不静默换音色。** BreezeBlue 报错时退回 SAPI，但原因会写进 `plan`：
`语音（SAPI 兜底：<原因>）`。看到这行就说明这场直播听到的不是大肥鱼的声音。

### 常驻进程 + 走系统代理

"每次新起一个 PowerShell 去 POST"一句话要等 **4.3 秒**才出声。拆开算账：

| 走法 | 到齐时间 | 首包 |
| --- | --- | --- |
| Node `fetch`（不走代理，直连） | 12.6s~88s | 经常 ECONNRESET |
| PowerShell 一次性 + `sync` | 4.3s | —（等整段） |
| PowerShell 一次性 + `/stream`（冷） | 3.0s | 1.7~3.0s |
| **常驻进程 + `/stream`（热）** | **2.1~2.6s** | **0.65~0.85s** |

实现：`lib/breeze-worker.ps1` 是个常驻进程，`HttpClient` 留着不销毁，连接复用，
stdin/stdout 走 base64 JSON 一问一答；Node 侧 `lib/breeze-worker.mjs` 负责起进程、串行发请求、
超时/崩溃后自动重起。进程起不来时自动退回"一次性 PowerShell"（慢，但独立）。

⚠️ **工作进程那条路必须显式带 `instructions` / `voice_settings`**：第一版漏了，
结果"语气活泼、带点傲娇"这段描述被静默丢弃，音色描述等于白写。`breeze-worker.ps1` 里已补上。

`status` 的 `tts.lastSynth` 会显示实测值，例如
`BreezeBlue 合成 17 字 → 3.20 秒音频（首包 664ms / 共 2091ms）`。

### 计费和缓存

按量计费（每次合成扣额度），所以同一句话走磁盘缓存 `voice-cache\breeze-<hash>.wav`，
重复的固定台词不重复扣费；带观众昵称的句子每次都不同，会正常计费。

## 十一、语音后端：小米 MiMo（默认）

`ttsEngine: 'mimo'`。小米 MiMo-V2.5-TTS 的接口**反直觉** —— 它不提供 `/v1/audio/speech`，
而是**骑在 `/v1/chat/completions` 上**，音频以 base64 塞在返回消息里：

```
messages[user]      = 语气/音色要求（voicedesign 模型必填，用来"捏"音色）
messages[assistant] = 要念的正文   ← 正文必须在 assistant 里，放 user 里没用
audio.format        = wav | mp3 | pcm | pcm16（流式建议 pcm16）
audio.voice         = 内置音色名 / 克隆模型的 DataURL 样本
```

输出统一 **24000Hz 单声道 16bit**，和 BreezeBlue 一致，口型模块直接复用。

### 三个模型

| 模型 | 能力 | 延迟（实测） |
| --- | --- | --- |
| `mimo-v2.5-tts` | 内置音色（mimo_default / 冰糖 / Mia 等） | 1.1~1.7s |
| `mimo-v2.5-tts-voicedesign` | **文字描述捏音色**（当前在用） | 1.4~2.1s |
| `mimo-v2.5-tts-voiceclone` | 音频样本克隆音色 | 3.2s（每次重传样本） |

### 捏音色的三个实测结论

1. **描述越短，语速越快**。同一句话：
   `圆滚滚的胖鲸鱼，年轻女声，语速快` → 3.3 字/秒（慢得黏）
   `可爱的少女音，语速快，气鼓鼓的` → 4.0 字/秒
   `活泼的年轻女声，语速快` → 5.0 字/秒
   模型会把"圆滚滚"理解成慢吞吞的状态。想要可爱/气鼓鼓，用**情绪词**（软萌、嘟嘴、
   奶凶、撒娇），别用外形词。
2. **加「吐字清晰」会顺带变快**。同一句话只加这四个字：4.2 → **5.0 字/秒**。
   但"清亮 + 咬字"这类组合反而变慢，不是加得越多越好。
3. 当前用的描述：
   `甜而不腻的少女音，吐字干净清晰，语速快，有点小脾气。`

### 克隆的代价和红线

克隆只要 3~10 秒干净样本就够了（3 秒样本实测 2.2s 合成，8 秒样本不会更准反而可能更慢）。
但**每次请求都要重新上传样本**：8 秒 wav → base64 513 KB，合成涨到 3.2 秒，比捏音色慢一倍多。

⚠️ **克隆真人的声音用于商业直播属于侵权风险**，B 站还要标 AI 生成内容。
模型不拦，但站不住。建议只用：自己的声音、有明确授权的、或本来由 TTS 生成的声音。

### 计费

TTS 系列**当前限时免费**（RPM 100 / TPM 10M）。设计模型和克隆模型都免费。

### 换回 BreezeBlue

`ttsEngine` 改成 `'breeze'` 即可，代码两条路都在；`'sapi'` 是本地兜底。
任一路失败都会退回 SAPI，并把原因写进 `plan`（`语音（SAPI 兜底：…）`），绝不静默换声音。

## 十二、边下边播（ffplay）

`SoundPlayer` 只能播**完整文件**，所以流式 TTS 等于白给：首包 0.9 秒就到了，
还得等 1.8 秒整段到齐才能出声。用 `ffplay` 吃 stdin 的裸 PCM，喂一片播一片。

| 走法 | 开口时间 |
| --- | --- |
| 先整段合成再播 | 1.4~3.4s（随字数增长） |
| **边下边播** | **1.1~2.0s**（≈首包时间） |

### 三个坑

1. **ffplay 没有 `-ac` / `-ar`** —— 那是 ffmpeg 的**输出**参数。裸 PCM 必须用 demuxer 参数：
   `-f s16le -sample_rate 24000 -ch_layout mono -i pipe:0`。写错会直接 exit 1，
   而 `-loglevel quiet` 会把错误一起吞掉，只看到"进程秒退、零字节"。所以这里用 `-loglevel error`。
2. **口型不能按"数据到哪"算** —— 音频是以约 3 倍实时速度灌进 ffplay 的，缓冲区会积压。
   必须按"开始播放后的真实流逝时间"去已收数据里回读该位置的波形：
   `pos = (now - startedAt) * 24000 * 2 / 1000`，取 40ms 帧算 RMS。
3. **DSH 宿主进程的 PATH 是启动快照** —— 装完 ffmpeg 宿主看不见，`spawn('ffplay')` 会 ENOENT。
   `resolveFfplay()` 直接去 `%LOCALAPPDATA%\Microsoft\WinGet\Links\ffplay.exe` 找。

### 顺带拿到的能力：打断

`activeSession.stop()` 可以中途掐断当前这句。弹幕一来就打断旧回复，
但**至少让它念 0.5 秒**再掐（`Date.now() - startedAt > 500`），否则像卡带。

实测：`say` 一句 25 字（首包 1973ms、6.4 秒音频），第 4 秒插一条弹幕 →
事件流里记 `chat（打断上一句）`，长句确实停住，新回复接上。

### 长句的首包会变慢

同一套配置下：11 字 → 1116ms · 25 字 → 1973ms · 65 字 → 3444ms。
**字数越多，首包越晚**，所以想让大肥鱼反应快，回复就得短。这也是弹幕回复要限长、
并且"只回最新那条"的原因。

## 十三、语音长度上限 `ttsMaxChars`（默认 40）

超长就截断，只念前半句。断点按这个顺序找：

1. `max` 之内最后一个**句末**标点（。！？；…），且不能早于一半 —— 最自然；
2. `max` 之后 8 个字之内的**第一个**句末标点 —— 宁可多说几个字，也不切在词中间；
3. `max` 之内最后一个**逗号类**软断点，同样不能早于一半；
4. 都没有 → 按字数硬切。

第 2 条是踩出来的：最初只"向前找"，遇到"句号在 16 位、上限 40"就会硬切在 40 字处，
念成"……玩哦，真"这种断在词中间的样子。改成允许向后溢出 8 个字后，
同样一句会干净地停在"……玩哦，"或上一个句号。

### 顺便：省略号要归一化

文字里「这个嘛……我再想想」很自然，但 TTS 会把它读成一段很长的空白 ——
观众只会觉得卡了。所以 `normalizeForSpeech()` 会在合成前把这些符号改掉：

| 原文 | 念出来的样子 |
| --- | --- |
| `……` / `...` | `，`（短停顿） |
| `～～` / `~` | `，` |
| `！！` / `？？` | 收成一个 |

实测同一句话：带「……」音频 6.9 秒，换成逗号 4.5 秒。

代价要说清楚：**截断之后后半句的信息就真的没了**。所以台词还是要写短 ——
上限只是保险，不是让文案偷懒的理由。