# dsh-llm-vertex

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 **Google Cloud Vertex AI（Gemini）** provider 插件。

Harness 自带的兼容层只认静态 API Key，而 Vertex AI 需要 OAuth2 Bearer token 加上 `projects/{project}/locations/{location}` 路径，静态 key 会被谷歌直接拒绝。这个插件实现了一个原生 `LlmAdapter`，注册 provider route `vertex`，让 Vertex 上的 Gemini 在 Harness 里作为一等模型来源出现：模型选择器可选、会话可切、流式输出与工具调用走原生管线。

## 能力

- **认证**：gcloud ADC（`authorized_user`）刷新令牌，或 Service Account JSON（本地 RS256 签 JWT 换 token）；token 内存缓存，过期前 5 分钟刷新。
- **流式对话**：调用 `publishers/google/models/{model}:streamGenerateContent?alt=sse`，把 SSE 翻译成 Harness 的 `StreamChunk`（text / reasoning / tool-call / usage / finish）。
- **工具调用**：工具定义投影成 `functionDeclarations`（schema 白名单清洗），`functionResponse` 回传；Gemini 3/4 要求回传的 `thoughtSignature` 按 `sessionId + toolCallId` 落盘保存，避免多轮工具调用 400。
- **设置页**：Harness 设置里独立的「Vertex AI」页，可看状态、改 project / location / 凭证路径 / 代理、测试连接、拉取可用模型并逐个测速。
- **强制限流**：进程级滑动窗口（默认 60 请求/分钟）+ 并发上限（默认 4），FIFO 排队、可取消。
- **显式代理**：支持 `http://`、`https://`、`socks5://`、`socks5h://`，本地代理或 VPS 均可，不需要 TUN 模式；代理凭据只在本机使用，接口返回时遮蔽为 `kind://host:port (auth)`。
- **静默重试**：一次请求若在 `silenceRetryMs`（默认 120s）内完全没有输出（连首 token 都没来），自动重试一次；重试使用完整预算，且只在尚未输出任何内容时触发。
- **两段式超时**：响应头预算 `firstByteTimeoutMs`（默认 180s，冷启动模型可能排队很久）与流式空闲预算 `timeoutMs`（默认 300s，相邻两段数据的间隔）分开计算，持续输出的长回答不会被总时长截断。
- **零第三方依赖**：只用 Node.js 内置模块。

## 安装

```sh
dsh plugin add github:OWNER/dsh-llm-vertex
```

装完后在 **设置 → 插件** 里启用 `llm-vertex`（或在 Harness 的插件页打开），然后到 **设置 → Vertex AI** 配置项目与区域。也可以从本地目录安装：

```sh
dsh plugin add /absolute/path/to/dsh-llm-vertex
```

## 前置准备

需要一个开通了 **Vertex AI API**（`aiplatform.googleapis.com`）的 Google Cloud 项目，以及一份可用凭据：

1. **Service Account JSON（推荐，权限最小）**：只授予 `roles/aiplatform.user`，把密钥文件路径填进设置页的「凭证文件」。
2. **gcloud ADC（开发用）**：

   ```sh
   gcloud auth application-default login
   gcloud config set project <你的项目ID>
   ```

   默认写到 `%APPDATA%\gcloud\application_default_credentials.json`（Windows）或 `~/.config/gcloud/application_default_credentials.json`，插件会自动读取。

> ADC 的刷新令牌携带 `cloud-platform` 全量 scope，继承该 Google 账号在项目里的全部 IAM 权限。长期使用建议换成只绑定 `roles/aiplatform.user` 的服务账号密钥。

## 设置页

**设置 → Vertex AI** 提供：

| 区域 | 作用 |
| --- | --- |
| 状态 | 凭证类型、账号、quota project、token 剩余有效期、当前生效的 project / location / 代理 |
| 项目与区域 | 保存后立即生效（写回 Loader 配置，无需重启应用） |
| 凭证文件 | 本地 JSON 路径；留空则回退到 `GOOGLE_APPLICATION_CREDENTIALS` 与 gcloud ADC |
| 代理 | `http://127.0.0.1:7890`、`socks5://user:pass@vps:1080` 等；留空直连 |
| 测试连接 | 用当前配置发一次真实请求，显示耗时、返回文本与 usage |
| 模型清单 | 从 Vertex 目录拉取可用的 Gemini 模型，逐个测试，勾选后保存为模型列表 |

设置页需要登录 Harness 的浏览器会话：写接口校验 CSRF token，并对匿名请求返回 401。

## 配置

设置页会把这些字段写回 Loader 配置；也可以手写 `cordis.patch.yml`：

```yaml
- id: llm-vertex
  name: dsh-llm-vertex
  config:
    # 留空则按凭证里的 quota_project_id → gcloud 默认项目推断
    projectId: ""
    # Gemini 3 预览模型当前发布在 global；要用固定区域就填 us-central1 等白名单区域
    location: global
    # 上下文窗口上限：200000 / "200K"、524288 / "512K"、1048576 / "1M"
    contextWindow: 1048576
    # 留空则读 GOOGLE_APPLICATION_CREDENTIALS 或 gcloud ADC 文件
    credentialPath: ""
    # 出站代理；留空直连。支持 http://、https://、socks5://、socks5h://
    proxyUrl: ""
    # 流式空闲超时（毫秒）：相邻两段数据到达的间隔
    timeoutMs: 300000
    # 响应头预算（毫秒）：冷启动/排队中的模型可能很久才回响应头
    firstByteTimeoutMs: 180000
    # 首 token 预算（毫秒）：响应头已回、模型还在静默推理时使用
    firstTokenTimeoutMs: 300000
    # 第一次请求完全静默多久后自动重试一次
    silenceRetryMs: 120000
    # 强制限流：每分钟请求数与并发上限
    requestsPerMinute: 60
    maxConcurrent: 4
    # 排队等槽位的最长时间（毫秒）；超时报 CONCURRENCY_TIMEOUT 而不是无限等待
    acquireTimeoutMs: 30000
    # 可选：单条工具结果最大字符数（0 = 不截断）
    maxToolResultChars: 0
    # 可选：工具结果发送前脱敏 ya29./1// 令牌、私钥与本地绝对路径
    redactToolResults: false
    models:
      - id: gemini-3.1-pro-preview
        name: Gemini 3.1 Pro Preview (Vertex AI)
        contextWindow: 1048576
        maxTokens: 65536
      - id: gemini-3-flash-preview
        name: Gemini 3 Flash Preview (Vertex AI)
        contextWindow: 1048576
        maxTokens: 65536
```

启用后模型选择器里会出现 **Google Vertex AI** 分组；也可以在子代理委托里直接写 `provider: "vertex"` 和任意 Vertex Gemini 模型 ID。

## 安全边界

- `location` 走区域白名单，只用于拼装主机名，不能注入任意 URL。
- `baseUrl` 仅允许 `https://*.googleapis.com`；本地调试只放行 `127.0.0.1` / `localhost` 并打印告警。
- 管理写接口要求 `Content-Type: application/json`、CSRF token（无 token 时才回退校验同源 `Origin` / `Sec-Fetch-Site`）以及 `X-Vertex-Admin` 头。
- 凭证文件只读，不写入配置；接口只返回凭证类型、账号与 quota project，不返回 token 或 refresh_token。
- OAuth access token 只驻留内存；思考签名写在配置目录下的 `thought-signatures.json`（权限 `0600`，默认上限 8 MiB）。

## 数据出境说明

启用 `vertex` 路由后，当前会话的**系统提示词、历史消息、工具定义与工具执行结果**会通过 HTTPS 发送到所选区域的 Vertex AI 端点（`aiplatform.googleapis.com` 或 `<region>-aiplatform.googleapis.com`）用于推理。`global` 可能被 Google 跨区路由；需要固定数据驻留区域时请显式指定区域，并用 `redactToolResults` / `maxToolResultChars` 控制工具输出的外发内容。

## 诊断

每次请求会在 `%DSH_HOME%\llm-vertex\debug.log`（默认 `C:\Users\<你>\.dsh\llm-vertex\debug.log`，超过 256 KiB 自动清空）留下几行：

- `req …`：模型、区域、消息条数、工具数、请求体字节数、是否走代理（不含任何凭据或正文）
- `hdr …`：响应头耗时与状态码
- `token …`：首个 token 耗时；`done …`：结束耗时、finish 原因与 token 用量
- `error …`：错误码与截断后的消息

如果某次请求超过 30 秒仍没有输出、并且日志里没出现对应的 `req` 行，通常是并发槽位被占满（旧版本中止的回合可能泄漏槽位）；新版本会直接报 `CONCURRENCY_TIMEOUT` 并说明排队情况。

## 已知限制

- 模型可用性取决于项目与区域：本插件在测试账号上观察到部分 2.5 系列模型返回 404（发布方模型已下架），Gemini 3 系列只在 `global` 可用。请用设置页的「获取可用模型」以目录为准。
- Gemini 3/4 的工具调用必须回传 `thoughtSignature`；签名落盘后跨进程仍可复用，但清空 `thought-signatures.json` 会让进行中的工具轮次失效。
- 只支持 Gemini 发布方模型，不支持 Vertex 上的 Claude / Llama 等第三方发布方。
- 冷启动：长时间未调用的模型（实测 gemini-4-carbon 直连约 72s 才回响应头）可能先排队再输出。响应头预算与流式空闲预算分开计算，必要时调大 `firstByteTimeoutMs`；同一模型经代理时可能更慢。

## 开发

```sh
node tests/test-vertex-unit.mjs   # 单元测试：消息投影、schema 清洗、分块协议、限流、签名
node tests/test-vertex-mock.mjs   # 本地 SSE 服务：文本、工具、404 路径
```

## 许可

MIT，见 [LICENSE](LICENSE)。
