# Voice Bench 运行索引

此目录只保存不含对话内容的运行摘要，随代码进入 Git。完整输入、模型回复、盲评分数和证据、费用明细在本地私有归档。

|运行ID|版本|样本|调用数|质量均分：千问 / DeepSeek|平均首字秒：千问 / DeepSeek|本次API费用|
|---|---|---|---:|---|---|---|
|[2026-09-07-real-001](2026-09-07-real-001.json)|v0.2|20回合 / 7会话 / 3账号|80|3.44 / 2.71|1.042 / 0.463|¥0.048967|

首条基线：Codex单次匿名评审；两模型各生成两轮，仅第一轮评分。费用跨越DeepSeek峰谷切换；不直接把下一次总费用变化解释成模型效率变化。

完整报告（只在保存了私有归档的本机可用）：[report.md](../../../.bench-private/archives/voice/2026-09-07-real-001/report.md)。

## 归档规则

- 每次生成使用新目录，每次归档使用新ID，不覆盖基线。
- 归档包含请求中实际使用的数据集与提示词、价格快照、逐次调用、评分、身份映射、报告、当时可用代码快照及文件校验清单。
- 代码快照是归档时版本，不保证与首次生成时源码逐字相同；生成时SHA保存在calls.json中，差异不隐藏。
- 公开摘要禁止包含消息、逐题点评、用户标识或真实片段。
- 全量归档当前仅在本地磁盘。Git推送保存代码和汇总，**不会备份真实数据和完整报告**。若需要跨电脑恢复，应另行选择受控的私有备份位置。

```bash
# 完成评分及finalize后，冻结一次运行
python3 bench/voice/archive_run.py create \
  --run .bench-private/voice-real/run-20260907 \
  --id 2026-09-07-real-001

# 验证内容未改变
python3 bench/voice/archive_run.py verify \
  --run .bench-private/archives/voice/2026-09-07-real-001

# 未来使用同一份真实基线复跑（会产生API调用，需遵循既有数据使用授权）
SSL_CERT_FILE=/etc/ssl/cert.pem python3 bench/voice/real_bench.py generate \
  --cases .bench-private/archives/voice/2026-09-07-real-001/cases.jsonl \
  --output .bench-private/voice-real/run-NEW --repeats 2
```

跨版本比较时核对数据指纹、提示词、模型ID、输出预算、评分规则、价格时段、输入长度与实际缓存命中。当前生成器会校验模型与价格快照；添加新模型时先更新适配及价格，不能沿用旧模型单价。
