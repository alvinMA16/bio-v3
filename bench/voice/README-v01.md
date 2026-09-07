# Voice Reply Bench v0.1

评估人生故事访谈里**下一轮回复的质量和语音可听性**。同一段历史分别交给两种模型，LLM judge 匿名评分，并交换 A/B 再评一次。规则只做输入/输出校验、分数汇总和失败统计，不以关键词、字数或问号数判定质量。

这版是可以运行的小规模试评基座，尚不是正式模型排行榜。

## 数据来自哪里

2026-09-07 对现有部署进行了只读调查，查询使用 PostgreSQL `default_transaction_read_only=on` 和 10–15 秒 statement timeout；没有修改服务端文件、数据库内容、配置或服务。

调查发现：

- 未删除会话关联 4,111 条消息、47 个账号。账号不等于已核验的独立真人，也未确认哪些是测试账号。
- 会话模式：normal 303、first_session 29、photo 36、narration 50。
- 具备 `final/interim` 语音诊断记录的 normal 会话只有 7 场、3 个账号；first_session 4 场、photo 4 场、narration 9 场。
- **语音证据在会话级**，没有把每一条消息与逐轮 ASR 诊断精确关联，不能宣称案例逐条具有语音来源证明。
- 只查看了必要的截断片段，没有下载音频、用户资料、长期记忆、生成后摘要或完整会话快照。

完整会话导出被自动审批拒绝，实际采用最小化读取和人工去身份化改写。因此：

- `cases.jsonl` 包含 **24 个改写/扩展案例、8 个场景族**，不是生产原文导出，也不是原始会话的逐字重放。
- 每族第一个是 `observed_pattern_rewrite`：基于看到的问题改写，历史承接语也可能为人工重建。人名、地点、组织和非必要细节已去除或替换。
- 另外两个是 `derived_stress_variant`：以真实问题为出发点构造的压力变化，不冒充另一个真实用户案例。
- `provenance` 是批次级记录，未保存原始用户/会话标识和可反查映射；当前无法逐条回溯原文。它适合研发回归，不适合审计原话或估计线上出错率。
- 开发集 12 个、测试集 12 个，按**场景族**拆分，避免近似变体跨集合。不是用户级随机留出。测试集一旦用于调提示词，就不再是未见测试集。

场景族：纠错/能力边界、停顿与遗忘、悼念与情绪、工作压力/隐私、童年回忆、未来计划、对话修复/结束、转写歧义。其比例是人为设计，**不代表线上分布**。

重建数据：`python3 bench/voice/build_cases.py`。原始敏感数据如以后经授权引入，应保存在 `.bench-private/`；生成回复与评审在 `bench/voice/runs/`，均被 Git 忽略。

## 测什么，不测什么

当前是 **frozen-context next-turn**：候选只看到 `candidate-system.txt` 和截止到当前 user 消息的历史。不会看到案例评分目标、另一模型回复或未来用户反应。历史助手可能已经犯错，候选需要自然修复；历史助手不是金标准。

采用明确的语音访谈提示词，两种模型相同。参考了真实部署的访谈任务，但没有复制部署模板中允许虚构“我父亲也……”等行为，也没有补入采样时不存在的个人记忆；因此不能把分数差解释成旧系统与新系统的线上 A/B。

候选通过 OpenAI 兼容接口直接调用，复用现有 `QWEN_*` / `DEEPSEEK_*` 服务端配置，关闭这两家模型的思考，temperature=0.3、max_tokens=512。输出截断或错误被计为失败。bench 的短输出预算针对语音场景，与 Agent 的 8192 上限不同。

**不包含 Pi 工具循环、数据库写入、真正的 TTS/ASR、打断检测、用户模拟器或长期多轮展开。** 现阶段没有修改回忆录的工具，任何声称已经保存/更新数据库都应扣分。更换能力边界时必须同步修改候选提示词、judge 提示词、案例目标和版本，不可暗中更改。

暂不引入 LLM 用户模拟器：真实历史后的后续用户话语不能直接当作新模型回复的自然后续；如果以后做闭环多轮，需要单独构建用户目标、状态和结束条件，并验证模拟器的保真度。

## 评分方法

|维度|权重|关注点|
|---|---:|---|
|intent|20%|接住当轮意图、纠正、暂停、结束|
|grounding|25%|不脑补人物/时间/经历，不虚构已完成操作|
|continuity|15%|利用已知事实，接受修正，不重复盘问|
|spoken|15%|可直接听懂的口语，长度适合当前情境|
|pacing|15%|等待、追问负担、深浅与让出话语空间|
|empathy|10%|尊重情绪、隐私与自主权，克制共情|

每项1–5分，锚点和逐项证据要求见 `judge-system.txt`。judge 另给比较理由、主观 confidence 和严重错误标签。权重是本版设计选择，需产品/人工评审校准。

- A/B 标签不带模型名，使用固定种子随机首轮顺序，第二轮严格换序；生成调用顺序也随机。
- 差值小于0.25视为tie，否则判高分者胜。judge 声明的 winner 与自身分数不一致视为评审失败，不擅自修正其结论。
- 两次映射到真实模型后的 winner 不一致，标记 `inconsistent`，不冒充tie。
- 生成/评审失败单列，不能靠删除失败项制造优势；分数仅基于双向评审成功的共同案例。
- 描述性分数平均两次顺序，再场景内平均、场景间等权平均。它仍包括换序分歧案例的分数，胜出数单独报告。
- 本版数据同源且经过扩展，没有独立用户级采样，因此**不输出用户总体胜率、显著性或置信区间**。
- 种子仅固定顺序，不保证外部模型回复可复现。结果保存完整输入/提示词、模型配置、返回的模型名、用量、采样参数及 SHA-256 指纹；不保存 API Key。

## 运行

需要 Python 3.10+，只用标准库，从仓库根目录运行。默认 `validate` 不访问网络：

```bash
python3 bench/voice/run.py validate --split all
python3 -m unittest discover -s bench/voice -p 'test_*.py'
```

正式评审使用一个独立、能力足够且经过校准的 judge。在本地 `.env` 配置（不要提交密钥）：

```dotenv
BENCH_JUDGE_BASE_URL=https://your-provider.example/v1
BENCH_JUDGE_MODEL=your-judge-model
BENCH_JUDGE_API_KEY=
```

自定义 judge 使用基础 OpenAI Chat Completions 请求；如其要求特殊思考参数或不支持 temperature，需要扩展 `complete()`，不能假设所有厂商完全兼容。

先做三个简单校准题（尊重结束、不能虚构保存、抵抗候选评审注入），每题双向，总计6次调用：

```bash
python3 bench/voice/run.py calibrate --judge judge
```

校准通过只代表基本可用，**不代表 judge 与人一致**。人工应先盲评一批 dev 回复，比较逐维评分、pairwise偏好和分歧类型，修订 rubric 后冻结版本。至少复核全部严重错误/换序分歧/低把握项及其余案例的20%。`results.json` 保存两次完整评分证据，可直接用于人工复核。

小规模跑通（4案例 × 2候选 + 4案例 × 2顺序judge = 16次调用，无自动重试）：

```bash
python3 bench/voice/run.py run --split dev --limit 4 --judge judge
```

如果暂时只有千问和 DeepSeek 的密钥，可以用千问验证管线：

```bash
python3 bench/voice/run.py calibrate --judge qwen
python3 bench/voice/run.py run --split dev --limit 4 --judge qwen
```

这种结果带 `self_judge_risk=true`，**仅作冒烟，不用于宣称千问胜过 DeepSeek**。程序能识别相同 provider 名/模型 ID，别名或同厂商其他模型仍需人工检查。

正式测试：

```bash
python3 bench/voice/run.py run --split test --judge judge
# 或全量24题（96次调用），仅用于回归/覆盖审查
python3 bench/voice/run.py run --split all --judge judge
```

默认输出到 `bench/voice/runs/<timestamp>/`，可用 `--output` 指定不存在的目录。每次调用后保存检查点 `results.json`，最终生成 `summary.json` / `report.md`；任意失败返回退出码2，不会覆盖已有目录。当前没有自动断点续跑，重跑会产生新请求费用。

如果 macOS 自带 Python 报 CA 验证失败，可使用系统可信证书（不能关闭 TLS 校验）：

```bash
SSL_CERT_FILE=/etc/ssl/cert.pem python3 bench/voice/run.py calibrate --judge qwen
```

报告的 duration_ms 是非流式整次模型请求耗时，不是首字/首音延迟，不能据此做语音延迟排名。

## 下一版建议

1. 人工确认这8类问题及能力边界，增加少量人工偏好标签，校准独立 judge。
2. 经明确授权获取脱敏的逐轮可回溯数据，核对 ASR→消息映射、过滤测试账号，按用户与时间做隔离留出，增加用户覆盖。
3. 扩展 photo / first_session / narration 时分别提供对应上下文和输出协议，不能混用普通访谈评分。
4. 在文本质量稳定后，再做真实音频听评、语音打断和端到端 Agent 工具执行评估。

方法依据：[MT-Bench 的 LLM judge 偏差研究](https://arxiv.org/abs/2306.05685)、[位置偏差研究](https://arxiv.org/abs/2406.07791)、[τ²-Bench 的交互环境与模拟器方法](https://arxiv.org/abs/2506.07982)。本项目采用换序、匿名、证据和人工校准建议，不把它们当作消除偏差的保证。
