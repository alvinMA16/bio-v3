# 本地修改提交记录 · 2026-09-19

当前已提交并发布的基线：`2454f8a73c2f06bc288696220c9ab304bd34fac4`。用户已确认将以下本地修改全部提交、推送，并按发布流程上线。

## 内容分组

| 组 | 内容与影响 | 主要文件 | 建议 |
| --- | --- | --- | --- |
| 1 | Gemini 原生 Google Search：对话默认启用，支持配置关闭，后台记忆整理不启用。搜索查询费用不在当前 token 费用统计中。 | `apps/api/src/models/gemini-search.ts`、`apps/api/src/agent/pi-session.factory.ts`、`apps/api/test/gemini.test.mjs`、`.env.example`、README 与发布文档相关段落 | 独立功能提交，明确默认行为变化 |
| 2 | 记忆任务调度：先选每个用户最早未完成任务，再筛选可执行用户，避免失败或延迟队首占满候选窗口；保持同用户顺序与锁内复核。 | `apps/api/src/memory/memory-worker.ts`、`apps/api/test/memory-scheduling.test.mjs`、`docs/memory.md`、技术债记录相关段落 | 独立修复提交 |
| 3 | 发布验证与构建缓存：在隔离临时 PostgreSQL 中运行镜像测试，拒绝跳过关键数据库测试；拆分依赖缓存层，延长冷启动探测等待。 | `infra/production/Dockerfile`、`deploy.sh`、`runtime-smoke.mjs`、`test-image.sh`、`test-release.mjs`、`test/`、根 `package.json`、发布文档与技术债记录相关段落 | 独立基础设施提交；后续发布执行镜像级检查 |
| 4 | 已完成的磁盘迁移记录及操作约束。修正旧文档里“当前版本”的时间语境，更新已上线修复的状态。 | `AGENTS.md`、`docs/storage-assessment-2026-09-17.md`、技术债记录相关段落 | 文档提交，不执行迁移操作 |
| 5 | 本轮 04E 棱光玻璃：阵列位置固定，明暗边界开合；语音保留行进波，思考使用独立对称光循环；加强玻璃棱边与厚度。保留 04D 对照。本地真实通话组件改用 04E。 | `apps/debug-console/src/glass-light-field.js`、`voice-glass-stack.js`、`voice-call-status.tsx`、`voice-motion.js`、`voice-motion.css`、`voice-motion.html`、`test/glass-light-field.test.mjs` | 单独动效提交 |

代码按功能分组提交；跨功能的发布说明与历史记录集中在文档提交中。

## 旧探索代码

`apps/debug-console/src/voice-motion-legacy.js` 是未被引用的旧探索绘制代码；当前保留版已由现有 renderer 提供。按用户“没提交的都提交”的最新确认，一并归档提交；不接入产品。

## 验证范围

- 本轮 Web 测试 58 项通过，包括新增光场测试：向外点亮顺序、向内熄灭顺序、思考循环的左右对称、短暂停顿与减少动态效果。
- Web 类型检查/构建通过；浏览器检查 04D/04E 对比与玻璃材质。
- 发布脚本回归 9 项通过。
- 上一轮全仓回归通过，但普通测试会跳过未配置测试数据库的场景。本轮没有重新执行真实 PostgreSQL 调度集成测试或完整候选镜像检查，不能把脚本测试等同于发布验证。已有专项数据库验证记录保留在技术债文档中。

用户已明确确认全部提交。04E 进一步减淡棱线、减薄边缘并柔化高光，使质感介于 04D 与原 04E 之间；明暗开合和思考循环保持不变。本轮已获授权执行提交、推送和发布；发布结果以服务器验证为准。
