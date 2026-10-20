# 实时语音：ASR → Agent → TTS

参考 `biography-v2` 的实时会话、火山 ASR 和豆包 TTS 实现，保留按轮隔离、ASR 最终结果稳定后断轮、分段音频播放的结构。这里中间层直接调用 `AgentService.run`，完整执行 Pi 会话、上下文拼装、工具循环、持久化及模型 Token/费用统计，没有另建一次性模型调用。

## 模块与协议

- `apps/api/src/voice/voice-session.ts`：会话编排与取消；依赖独立 ASR/TTS provider 接口及 Agent runner。
- `volcengine-asr.ts`：火山 `bigmodel_async` WebSocket，16 kHz 单声道 PCM16；使用 gzip 二进制帧与正/负序列号，开启二遍识别以获得 definite 句末确认。累计文本按快照替换，不重复拼接；同一最终快照不反复重置断轮窗口。凭证留在服务端。
- `doubao-tts.ts`：HTTP chunked PCM16 流；严格检查结束标记和服务错误，超时/打断可取消。
- `spoken-segments.ts`：按 messageId 累积普通回复，句末或长片段时送合成；completed 快照不重复播。工具参数、面板正文和内部事件不进入合成。
- `packages/contracts/src/voice.ts`：共享 WebSocket 协议。`/api/v1/voice` 接收 `listen`（轮次 ID、模型和上下文）、PCM 二进制帧、`finish`、`cancel`；返回 ASR、原始 Agent 事件、分段音频、结果和终态。所有返回事件均带 turnId 和相对轮次起点的 elapsedMs。
- `apps/debug-console/src/voice/`：麦克风 AudioWorklet 采集、重采样、WebSocket、Web Audio 排队播放和资源回收。
- `apps/miniprogram/miniprogram/lib/voice-client.ts`：微信录音管理器 PCM 帧和 WebAudio 播放适配；聊天页接收同一套协议、实时更新面板与回复。

## 交互与生命周期

点“开始语音对话”后申请麦克风并连接。新电话的首个 listen 先触发 Agent 开场，跳过 ASR，不生成用户 transcript；客户端播放排空后发送下一轮 listen，才开始录音并显示识别结果。开场复用 Agent 与 TTS 链路，默认一句、最多两句，通常不超过40字；按北京时间和已有近期背景选择零到一个线索，不逐项回顾、不固定问候，深夜不猜测失眠或催睡。长度是模型指引，不通过截断语音强制实现。

开场通过隐藏的 `bio_call_opening` 服务端消息启动，包含接通时间，不把触发内容归档为用户证据。助手开场仍保存为助手原文。数据库 opening_claimed 原子标记保证同通重连不重复开场；打断或失败后不自动重播。只有开场、没有实际用户发言的电话不会生成摘要。未启用数据库记忆的本地模式按连接开场，新连接视为新电话，服务端分配新 conversationId；数据库模式沿用原 callId 恢复会话。

ASR 的句末最终结果稳定 2.5 秒后结束本轮；新的语音开始或中间识别结果会重置窗口，不把卡住的中间结果当作用户已说完。也可点“说完了”立即提交。语音中间结果不作为失败兜底提交给 Agent，避免错误执行用户操作。

普通回复可以在 Agent 继续执行工具时合成和播放，多条回复依次排队。Agent 完成、TTS 完成和客户端播放结束是三个不同时间点；播放队列排空后才重新录音。通过“打断并说话”立即停止本地音频并取消旧 ASR/Agent/TTS，服务端等待旧 Agent 释放会话锁再开启下一轮。已完成的工具修改不会回滚，旧轮音频和 ASR 回调被丢弃。

本次采用与参考项目相近的轮流收听/播放方式，支持按钮打断，**尚不支持播放中自动识别人声抢话的全双工 VAD**。默认稳定窗口保持 2.5 秒，避免人生故事讲述时抢话；可用 `VOICE_ENDPOINT_MS` 在 500～6000 ms 间调整。

调试页将实际音频播放状态传给小狐狸动作模块；文字模式仍用文本生成模拟口型。小程序聊天页已有播放状态，独立角色展示页尚未与聊天页合并。关闭会话、断线、页面隐藏/退出需释放麦克风、WebSocket、音频节点和计时器。

## 播放流控与断线恢复

Web 与小程序的 `listen` 声明 `playbackFeedback: true`，音频事件携带本轮累计 `endSample`。客户端在音频节点真正结束后发送 `playback.playedSamples`；不能在收到音频或服务端完成时提前确认。服务端使用 20 秒高水位 / 8 秒低水位暂停和恢复合成及 PCM 发送，每帧最多一秒、每个合成文本片段最多 100 字符。缓冲仍保留独立字节上限，45 秒没有足够播放进展会停止本轮语音并保留文字。旧客户端未声明反馈时不启用信用窗口，发布后需刷新客户端。

TTS 仅在当前片段尚未发出音频时重试一次；部分播出的片段不重试。合成、播放器或语音文字预算异常不关闭整通电话，也不取消仍在生成的 Agent 正文。客户端用 `playback.stop` 停止本轮语音，服务端错误用 `recoverable` 标记可继续交流。结构化 `voice.failure` 日志记录阶段、错误码、通话/轮次和排队样本数，不记录凭证或提供商原始响应。

意外断线最多以 1/3/7 秒间隔重连，沿用原 callId；主动挂断或页面隐藏不自动重启麦克风。Web 在账号隔离的 sessionStorage、小程序在账号隔离缓存保留三分钟恢复入口。`connected` 返回服务端确认的 callId、conversationId 和 resumed。当前进程中旧连接尚存时，先取消并等待其 Agent、播放记录和会话快照写入，再恢复；旧连接不能结束新连接。超出宽限、原电话已结束时建立新电话，附带最近通话读取入口，不重放用户消息或已执行的工具。

`bio_voice_playback` 保存每轮生成完成状态、累计发送/播放样本数、最近确认播完的文本片段和中断标记。播放回执只能证明播放器处理过，不能证明用户听清或同意。恢复后默认继续收听用户，不自动续播可能重复的音频；Agent 可根据恢复背景和原文回应“接着说”。后台记忆整理使用这些记录区分完整生成与已播放，不把未听完的建议当作双方共识。

## 配置与验证

填写根目录 `.env.example` 中列出的 ASR/TTS 配置到本地 `.env`，然后启动 `pnpm dev:api` 和 `pnpm dev:web`。未配置凭证时 WebSocket 返回 503，不影响原有文字对话。浏览器麦克风需要 HTTPS 或 localhost；小程序真机需配置实际服务地址、合法 WSS 域名、麦克风权限，并验证平台的 PCM 与 WebAudio 支持。已只读获取服务器运行容器中的火山配置，凭证仅保存到被 Git 忽略的本地 `.env`。ASR 使用 `volc.seedasr.sauc.duration`，TTS 使用 `seed-tts-2.0`。

现有 API 与调试台尚无用户鉴权，这条语音入口同样是本地开发入口，不应直接作为多用户公网服务使用；有同源检查、连接数、帧大小、录音长度和缓冲队列上限，不能代替用户鉴权。

调试历史保存识别文本、原始 Agent 结果和耗时；未完成讲述的尾部音频会暂存用于恢复，分块确认后删除对应音频；模型 Token、缓存与费用沿用 Agent 统计。语音时间字段均相对录音轮次开始，包括结束录音、最终识别、首文字、首音频、Agent 完成、合成完成、客户端开始/结束播放。ASR/TTS 费用未并入模型费用，也未在本次新增计费估算。当前播放器开始时点由 Web Audio 调度时间估算，不是扬声器硬件输出测量。

自动化测试使用合成 ASR/TTS 和本地模型响应，包含真实 Pi 工具循环测试，不访问真实用户数据或付费服务。真实服务、麦克风、扬声器以及微信真机效果需要配置凭证后的联调确认。

协议实现参考本地 `biography-v2/internal/provider/asr/volcengine/volcengine.go`；TTS 参考[火山引擎官方示例](https://github.com/bytedance/agentkit-samples/blob/main/skills/byted-text-to-speech/scripts/text_to_speech.py)。

## 火山服务联调记录（2026-09-08）

只读确认服务器运行容器使用火山 ASR（`volc.seedasr.sauc.duration`）和 TTS（`seed-tts-2.0`），本地使用同样资源。服务器未显式指定音色，按参考实现的默认首音色 `zh_male_shaonianzixin_uranus_bigtts` 验证；可通过本地配置切换。

使用自拟文本合成测试音频后以实时速度送入 ASR，不使用真实用户录音。独立 TTS 测试首包约 436 ms，ASR 正常返回文本。完整链路将“请在面板里写一句问候语。”交给真实 `qwen3.8-flash` Agent，执行 `update_content`，面板进入 editor 并返回语音。该轮首包回复音频距录音轮次开始约 5.724 秒（包含测试音频输入时间，不是纯推理耗时）；模型输入 3728 tokens，其中缓存命中 2688、未命中 1040，输出 145。

完整链路首次测试出现一次 TTS 合成失败，重跑成功，尚不能据此断定真实服务稳定性。现增加供应商错误码用于诊断，并过滤纯标点分段；未确认首次失败的具体原因。浏览器麦克风/扬声器与微信真机仍需人工体验验证。测试会话及其临时凭证文件已清理。

## 场景内开关麦体验版

调试页分为场景入口与深色通话页。通话页保留 96 × 120px 狐狸窗口，主内容区显示对话或浅色附件/草稿。底部按麦克风、结束、扬声器排列，可见圆形直径 36px，点击范围 48px，没有整条底色。关麦释放采集音轨；扬声器静音只关闭输出增益，不停止回复队列。结束通话清理音频、连接和计时器并返回场景。连接成功后开始计时；初始化失败使用中文提示，详细异常保留在控制台。

## 通话动作规则

动作由独立模块维护：`fox-activity.ts` 将运行事件转换为语义状态；共享的 `fox-behavior.ts` 负责状态与动作的对应及本子姿态衔接；`fox-animation-controller.ts` 负责播放、停顿和清理计时器。页面只传入运行状态、语音阶段和实际播放状态，不选择动画素材。

- 首次进入挥手一次；连接中、等待输入和倾听时保持自然姿态，不触发记笔记。
- 用户说完后的识别确认、思考、等待语音合成以及实际编辑使用记笔记动作，沿用短延迟和写几笔后停顿的节奏。
- 实际回复音频开始后使用说话动作，思考时拿起的本子延续到回复中；服务端完成但音频仍在播放时不提前停止说话。
- 读取附件/面板不新增阅读动作；打断、结束和异常停止当前动作，不增加专属动画。
- 查看附件不等于一直阅读：没有读取工具正在执行时，仍根据思考、倾听或回复状态选择动作。


## 连续讲述与持久化恢复（2026-10-15）

新版客户端通过 `durableCapture` 协商持久化采集。收听没有两分钟时长或累计音频大小限制；原有最终识别稳定窗口和“说完了”仍决定何时提交 Agent。内部每约 8 秒音频完成一个 ASR 块，保存确认文本后打开下一条识别连接；切块不触发 Agent。小程序录音管理器单次采集结束后继续采集，不提交整段讲述。

`bio_voice_captures` 标识未完成讲述；`bio_voice_capture_audio` 按连续包序号保存尾部 PCM；`bio_voice_capture_blocks` 按块保存最终转写。识别草稿最多每五秒更新一次。音频先事务落盘才返回 `capture.saved`；块文本与尾部音频删除在同一事务提交。数据库连接所有权隔离旧连接，账号隔离恢复查询。用户原文入库和讲述已提交标记原子完成，不因重连重复归档。

Web 在账号隔离的 sessionStorage、小程序在账号隔离的缓存中保存未确认音频。小记录逐包写入，确认后清除；缓存上限约一分钟，写入失败或溢出停止采集并提示重连，不静默丢弃。Web 自动重连期间继续暂存音频。页面刷新保留 sessionStorage；主动清除站点数据、关闭整个标签页或系统未交付的最后一个采集帧不属于此缓存的保证范围。

恢复时读取服务端连续序号，只补发之后的音频包。确认回复丢失时重复包由服务端去重；仅重放未封存尾部给 ASR，按实时速度发送以避免突发拥塞。已经保存的块不重新识别。恢复可能需要等待尾部重放完成；正常情况下尾部不超过约 8 秒。通话五分钟恢复窗口到期后，未完成讲述仍可在新通话中接续。完成原文保存后不自动重放模型操作。

自动化验证覆盖加速时钟下 50 分钟连续 PCM、分块和提交顺序、断线与进程重建、丢失确认、刷新创建新客户端、客户端缓存有界、数据库失败、跨账号隔离、旧连接写入隔离、过期通话恢复及重复提交归档。真实手机麦克风与系统后台行为仍需设备验证。


## 2026-10-15 interruption recovery

The product offers explicit continuation and an independent new call. Refresh preserves
active capture metadata; starting a new call parks that metadata and its unacknowledged
packets without deleting them. The shared product entry offers recovery when an active
or parked capture remains. The server selects an unfinished capture only from the current
call, unless an authenticated client explicitly supplies its capture ID. Unrelated pending
captures are never implicitly adopted by new calls.

Both clients use a PCM-duration-paced uploader with at most ten unacknowledged packets.
The browser also pauses uploads when its socket buffer exceeds 64 KB. Transport loss
pauses microphone capture; it resumes only after server tail replay and local pending
packets have been durably acknowledged. Upload stalls stop after 20 seconds without
progress and retain pending packets. A local finish waits for all durable ACKs. New clients negotiate orderedCapture;
the server requests capture.finish at a silence endpoint so the client can flush
its recorder and obtain the final durable ACK before sending finish. Legacy
clients retain their existing endpoint behavior. During
backlog recovery, capture.sync prevents a silence endpoint from submitting only the
first part of the upload. The server's existing 8-second recognition blocks still bound
replay; capture.recovering reports remaining replay duration. ASR readiness has a
60-second deadline and the browser bounds overall preparation at 120 seconds. Users
can leave preparation at any time, without deleting unfinished captures.

The public product and internal debugger share the recovery controls and failure state.
Terminal failures remain visible instead of being replaced by subsequent done events.
Structured diagnostics cover ASR failure codes, client upload/storage/preparation
failures, handshake rejection and connection-close codes/duration; they exclude
credentials, audio and provider response bodies. The original October 15 disconnect
trigger remains unproven because the old version omitted several of these events.


### Background preparation after disconnect (2026-10-16)

Disconnected and ended calls with pending audio are transcribed ahead of the next
restore request using the existing streaming ASR resource. A single background
connection processes at most 8 seconds per pass with a 50-second deadline; no
additional ASR product is required. The PostgreSQL audio journal is the durable
work queue, including after process restart. Active calls are excluded; calls with
heartbeats older than five minutes are treated as abandoned. Failures retain audio
and draft text and back off for one minute. No Agent run or user message submission
occurs in this worker.

A per-capture PostgreSQL advisory lock coordinates workers and authenticated live
takeover. The worker atomically saves canonical block text and deletes only the
corresponding audio, checking capture block, sequence and connection ownership.
Live recovery waits for an in-flight block before loading the snapshot. A crash
releases the lock; a committed block is reused and an uncommitted block is retried.
Sequence acknowledgements remain unchanged, including when the browser missed an ACK.

Audio that has not reached the server still requires the browser to reconnect.
While preparation or upload is pending, product UI shows only “正在恢复对话”.
Processing stages, packet counts, replay duration and diagnostic causes belong in
internal telemetry, not product copy. Failures offer a concise retry action.
