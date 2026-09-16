# 手机号账号 v1

手机号验证成功后自动创建账号；同一手机号再次登录恢复同一个 UUID。首版支持中国大陆手机号，不包含密码、微信登录、换绑手机号和注销账号。账号模式通过 `AUTH_ENABLED=true` 开启，需要 `MEMORY_DATABASE_URL`。启动时若缺少数据库、验证码哈希密钥或短信配置则拒绝启动，不退回共享用户。

## 短信

发送器移植自 `biography-v2/internal/provider/sms/aliyun/aliyun.go`：阿里云 SendSms、ACS3-HMAC-SHA256 签名、10 秒超时，保留自定义模板字段及 `code`、`minute`、`minutes`、`time`、`ttl`、`ttl_minutes`。验证码由服务端生成，通过阿里云短信送到手机；用户填写验证码，当前应用校验数据库中的 HMAC 摘要。无需接收短信回调。

服务端配置：

```dotenv
AUTH_ENABLED=true
MEMORY_DATABASE_URL=postgresql://...
AUTH_CODE_SECRET=<至少32字符的随机密钥>
SMS_PROVIDER=aliyun
ALIYUN_SMS_ACCESS_KEY_ID=<短信服务凭证>
ALIYUN_SMS_ACCESS_KEY_SECRET=<短信服务凭证>
ALIYUN_SMS_SIGN_NAME=<已审核的签名>
ALIYUN_SMS_TEMPLATE_CODE=<已审核的验证码模板>
ALIYUN_SMS_TEMPLATE_PARAM_KEY=code
TRUST_PROXY=true
```

与参考项目一致，短信专用 AccessKey 未设置时可回退 `ALIYUN_ACCESS_KEY_ID` 和 `ALIYUN_ACCESS_KEY_SECRET`。密钥只保存在被忽略的服务端环境文件。`AUTH_CODE_SECRET` 可用 `openssl rand -hex 32` 生成。

六位验证码有效期 5 分钟，每个手机号 60 秒内一次、每小时最多 5 次、每天最多 10 次，每个 IP 每小时最多 20 次。数据库事务与按手机号/IP 加锁处理并发发送。发送失败和结果不确定仍计入额度。最多验证错误 5 次，成功后验证码立即销毁，不能重放；重新发送会使旧码失效。生产环境不会接受本地测试码。接收手机号不写入请求 URL 或应用日志，凭证和验证码不进入 Trace。

## 会话与数据隔离

随机登录令牌有效期 30 天，数据库只保存 SHA-256 摘要。退出撤销当前令牌；HTTP 下一次请求即拒绝，已打开的语音连接最多 20 秒内关闭。关闭浏览器后可保持登录，过期后重新验证。网页其他标签页会在切换账号或退出时重新加载。账号模式不再接受原 `MEMORY_AUTH_TOKENS` 或开发默认用户。

HTTP 使用 Bearer；浏览器 WebSocket 使用原有 `bio-auth.<token>` 子协议，小程序 WebSocket 使用 Authorization 头。网页原件图片/下载使用 HttpOnly、SameSite=Strict 的专用 Cookie，仅只读原件接口接受 Cookie，生产添加 Secure。小程序原件用认证下载后预览临时文件。聊天历史及小票缓存按用户 ID 分开。

会话、记忆、文稿、运行记录沿用数据库用户归属校验；资料包含列表、原件、编辑、删除及模型引用，均绑定已认证用户。资料仍保存在服务器本地持久卷，以用户 ID 的哈希划分目录；多实例部署需共享该卷或后续接入对象存储。

已有 owner 记忆和无主本地资料不会自动分配给首个注册账号，也不会公开给其他账号。需要迁移时必须明确原用户与手机号账号的映射后单独迁移。

## 部署

先配置短信并运行迁移/验证，再部署启用账号模式的版本。`render-nginx.py` 根据生产配置切换：`AUTH_ENABLED=true` 时取消旧预览 Basic Auth，并透传客户端 Authorization，不能再注入 owner 令牌。未启用时保留旧私有预览配置。Nginx 重写 X-Forwarded-For 为客户端真实 IP；只有经单层受信代理、且 API 端口不公开时设置 `TRUST_PROXY=true`。

这一开关也会开放用户自行注册；上线前应确认使用的短信签名和模板可用。健康接口和登录配置公开，其余业务 API 必须认证。

## 接口与验证

- `GET /api/v1/auth/config`：账号模式开关。
- `POST /api/v1/auth/code`：`{phone}`，返回重发等待秒数与有效期。
- `POST /api/v1/auth/login`：`{phone,code}`，返回令牌、到期时间和脱敏用户信息。
- `GET /api/v1/auth/me`：当前用户。
- `POST /api/v1/auth/logout`：撤销当前令牌并清除文件 Cookie。

```sh
pnpm typecheck
pnpm build
AUTH_TEST_DATABASE_URL=postgresql://... MEMORY_TEST_DATABASE_URL=postgresql://... pnpm test
```

数据库测试仅使用独立测试库。覆盖验证码过期、错误次数、发送竞争、并发消费、服务重启后会话、退出撤销、旧身份拒绝、跨账号资料/原件/文稿/Trace 访问；短信通过模拟响应验证请求签名及失败路径，不向真实手机号发短信。小程序测试覆盖验证完成与页面就绪顺序、未登录及离开页面不能打开麦克风。

## 将旧 owner 绑定到指定手机号

若手机号还没有独立账号，迁移命令可把 `bio_auth_users` 的手机号直接绑定到原有内部 ID `owner`。旧用户沿用已有 ID，因此 Overview、原文、通话、任务、文稿快照、Trace 与用户目录无需搬动，所有外键和来源关联保持不变；之后该手机号正常验证码登录会返回这个旧用户，其他新账号仍使用随机 UUID。不会签发绕过验证码的永久登录凭证。

在独立测试库验证命令后，暂停写入并完成数据库/文件备份。通过私有环境文件设置 `OWNER_PHONE` 和 `MEMORY_DATABASE_URL`，先运行 `node infra/production/bind-owner-account.mjs` 预检，再加 `--apply` 执行。默认预检在事务结束时回滚。命令输出脱敏手机号及各表记录数量，可重复执行；若手机号已属于另一个用户，或 owner 已绑定其他手机号，则拒绝自动合并。运行前后核对记录数量及文稿可见性。

这项绑定只处理 owner 的数据库身份。若服务器另有无主全局资料或无主本地会话，须先单独核对来源并迁移；不要把其他人的资料一并归入 owner。当前此部署的预检没有无主资料或会话。
