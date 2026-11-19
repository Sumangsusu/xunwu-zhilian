# API 秘钥配置教程：寻物智联网页内的寻物助手

本文说明如何为已经集成的寻物助手配置模型 API Key（密钥）。默认的站内检索不需要密钥；配置后，登录用户可以在助手页面主动选择“模型辅助”。

配置文件放在 **包含 server.js、package.json 的“失物招领”目录**，不是 GitHub 仓库最外层，也不是 public 目录。程序会自动读取这里的 .env，不需要安装 dotenv 或修改 JavaScript 源码。

## 1. 准备模型服务账号与密钥

选择一种服务即可：

| 服务 | 密钥申请入口 / 官方说明 | 本项目 AGENT_PROVIDER |
| --- | --- | --- |
| OpenAI | [开发者快速开始](https://developers.openai.com/api/docs/quickstart) | openai_compatible |
| DeepSeek 等 OpenAI 兼容服务 | [DeepSeek 官方接入说明和密钥入口](https://api-docs.deepseek.com/) | openai_compatible |
| Gemini | [Google AI Studio 密钥管理](https://aistudio.google.com/apikey)、[官方密钥说明](https://ai.google.dev/gemini-api/docs/api-key) | gemini |

在服务商平台登录，进入 API Key 管理，按页面指引创建密钥，并确认账号可用模型和调用额度。保存生成的密钥，稍后填入服务器配置。具体费用、可用地区、模型名称和权限以服务商平台为准。

本项目已有 OpenAI 兼容与 Gemini 接口适配；是否能使用某个具体模型，还取决于模型支持的接口参数。OpenAI 兼容模式需要 Chat Completions 接口及 temperature、max_tokens 参数；默认还需要 JSON Object 输出支持。仅支持 Responses API、Anthropic Messages 或不同参数格式的模型不能仅靠替换地址接入。

## 2. 创建或打开 .env

在项目的“失物招领”目录打开 PowerShell。首次配置执行：

~~~powershell
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
notepad .env
~~~

已有 .env 时直接编辑，保留原来的数据库、登录、地图等配置。不要重复添加同名变量；找到已有 AGENT_ 开头的配置并替换。

文件名必须是 **.env**，不是 .env.txt。Windows 可在资源管理器中启用“文件扩展名”检查。修改后保存为 UTF-8。

### 首次本地运行时的必要设置

.env.example 默认用于生产部署，包含 NODE_ENV=production，但 SESSION_SECRET 留空。直接复制后启动会被登录安全检查拦截。

仅在自己电脑上测试时，将这些项目改为：

~~~dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
BASE_URL=http://localhost:3000
TRUST_PROXY=0
~~~

然后使用 http://localhost:3000 打开网站，保持访问地址与 BASE_URL 一致。

如果在服务器生产部署，保留 NODE_ENV=production、原有 HOST 和 TRUST_PROXY，并填写随机 SESSION_SECRET。可运行以下命令生成随机值，把输出填到 .env 的 SESSION_SECRET= 后：

~~~powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
~~~

SESSION_SECRET 是网站登录签名密钥，和模型 API Key 是两个不同配置。已有正常运行的站点只改 AGENT_ 项，不要重新生成登录密钥，以免让现有用户会话失效。生产部署的其他设置见 [DEPLOY.md](DEPLOY.md)。

## 3. 填写模型配置（选择一组）

以下“替换为……”都是占位文字，必须换成自己的值。每个变量独占一行，不要把中文引号复制进去。

### 方案 A：OpenAI

~~~dotenv
AGENT_PROVIDER=openai_compatible
AGENT_API_KEY=替换为你的OpenAI_API密钥
AGENT_BASE_URL=https://api.openai.com/v1
AGENT_MODEL=替换为账号可用且兼容上述参数的模型名称
AGENT_TIMEOUT_MS=12000
AGENT_JSON_MODE=true
~~~

密钥填 API 平台生成的值；不要填写网站登录密码或聊天软件的会话令牌。模型名称必须是 API 模型 ID，而不是自己给助手起的名字。

### 方案 B：DeepSeek 或其他 OpenAI 兼容服务

DeepSeek 使用的 OpenAI 兼容基础地址见其[官方接入说明](https://api-docs.deepseek.com/)：

~~~dotenv
AGENT_PROVIDER=openai_compatible
AGENT_API_KEY=替换为你的DeepSeek_API密钥
AGENT_BASE_URL=https://api.deepseek.com
AGENT_MODEL=替换为DeepSeek官方当前可用的模型ID
AGENT_TIMEOUT_MS=12000
AGENT_JSON_MODE=true
~~~

其他服务按其官方文档替换 AGENT_BASE_URL、AGENT_API_KEY、AGENT_MODEL，AGENT_PROVIDER 仍填写 openai_compatible。服务商账号、密钥、地址和模型必须配套。

地址需要指向 API 服务，不能填聊天网页地址。本项目会在基础地址后拼接 /chat/completions，也接受已经以 /chat/completions 结尾的完整地址。不要重复拼接。外部地址要求 HTTPS；仅本机 localhost、127.0.0.1、[::1] 允许 HTTP。

若服务明确不支持 response_format 参数，可改为 AGENT_JSON_MODE=false。这样只是不发送该参数，仍要求模型返回项目需要的 JSON；它不能解决密钥无效、模型不存在或其他参数不兼容的问题。

### 方案 C：Gemini

在 [Google AI Studio](https://aistudio.google.com/apikey) 创建属于目标项目的密钥；如果创建按钮不可用，按[官方权限说明](https://ai.google.dev/gemini-api/docs/api-key)检查项目权限。

~~~dotenv
AGENT_PROVIDER=gemini
AGENT_API_KEY=替换为你的Gemini_API密钥
AGENT_BASE_URL=
AGENT_MODEL=替换为支持generateContent和JSON输出的模型ID
AGENT_TIMEOUT_MS=12000
AGENT_JSON_MODE=true
~~~

AGENT_MODEL 填模型 ID，不要带 models/ 前缀。此模式调用固定的 Google generateContent 接口，AGENT_BASE_URL 保持为空。

本项目统一读取 AGENT_API_KEY，不会直接读取官方 SDK 常用的 OPENAI_API_KEY、DEEPSEEK_API_KEY、GEMINI_API_KEY 或 GOOGLE_API_KEY。AGENT_JSON_MODE 开关仅影响 OpenAI 兼容模式；Gemini 模式固定请求 JSON 输出。

## 4. 重启，让配置生效

### Windows / Node 直接运行

如果服务正在运行，在原终端按 Ctrl+C 停止，然后在“失物招领”目录执行：

~~~powershell
npm ci
npm start
~~~

npm ci 仅在首次安装或依赖更新后需要执行，单纯修改密钥时重新 npm start 即可。不要同时启动两个占用 3000 端口的服务。

配置加载发生在服务启动时，刷新网页不会重新读取 .env。如果操作系统或启动工具已经设置同名环境变量，它们会优先于 .env；发现旧值仍生效时，检查启动环境，而不是把密钥硬编码到源码。

### 已有 Docker Compose 部署

在服务器项目目录修改 .env，然后执行：

~~~sh
docker compose up -d --force-recreate app
docker compose ps
~~~

如果尚未部署本次助手代码，先更新代码，再运行：

~~~sh
docker compose up -d --build --wait
~~~

.env 通过 env_file 注入容器，修改后必须重建容器配置；只执行 docker compose restart 不能更新已有容器的环境变量。

使用 HTTPS 覆盖文件、自定义 Compose 文件或项目名的部署，应在上述命令中沿用原部署命令的 -f / -p 参数，保持同一套服务配置。不要删除数据库卷。

## 5. 在网页里启用并验证

1. 打开正在运行的网站并登录，进入导航中的“寻物助手”（/agent.html）。
2. 找到“查询方式”，把“站内检索”切换为“模型辅助 · 模型名称”。每次刷新页面默认仍是站内检索，需要重新选择。
3. 发送“我在图书馆丢了黑色水杯”。不要只发“你好”：问候、帮助等简单指令会在本地直接回答，无法验证模型调用。
4. 查看是否返回查询结果，以及是否出现“模型服务未完成本次查询，已使用站内检索”。出现这句说明本次发生回退，需要继续排查。
5. 数据库没有匹配启事时返回“没有符合条件的启事”是正常现象，不能据此判断密钥无效。

需要进一步确认时，在已登录的助手页面按 F12，打开 Network（网络），查看：

| 请求 / 字段 | 如何判断 |
| --- | --- |
| GET /api/agent/config → api_configured | true 只表示必填配置已填写，不代表密钥有效或外网调用成功 |
| POST /api/agent/query → provider | 本次若调用了模型，会显示 openai_compatible 或 gemini；简单本地回答可为 local |
| 同一响应 → fallback_used | true 表示模型未完成查询并回退；正常模型查询应为 false |
| 同一响应 → execution_status | COMPLETED 表示流程完成，仍须结合 provider 和 fallback_used 判断是否使用模型 |

/health 只检查网站与数据库，不检查外部模型。npm run test:agent 使用模拟模型进行自动化测试，通过也不代表你的真实 API Key 已验证。

## 6. 常见问题

| 现象 | 排查方法 |
| --- | --- |
| “模型辅助”显示尚未配置、无法选择 | 检查 AGENT_PROVIDER 是否仍是 heuristic；确认密钥、模型已填写，兼容模式还需要 BASE_URL；确认 .env 路径和文件名；重启服务并刷新页面 |
| 选择后仍回退本地查询 | 检查密钥、模型权限、余额/配额、服务器出网、地址及接口参数兼容性；到服务商用量页确认请求情况 |
| 模型不支持 JSON 参数 | 仅对 OpenAI 兼容模式尝试 AGENT_JSON_MODE=false；仍需模型输出合法 JSON |
| 请求较慢或超时 | 可将 AGENT_TIMEOUT_MS 改成 20000，允许范围为 1000–30000；总体查询仍限制 35 秒，慢模型可能回退 |
| 启动提示必须设置 SESSION_SECRET | 首次复制了生产模板但没有设置登录密钥；按第 2 节区分本地测试和生产部署 |
| 请求来源不被允许 | 检查 BASE_URL 与实际访问源是否一致，包括协议、域名和端口 |
| 接口返回 401 | 网站登录已失效，重新登录后再试；这是本站鉴权，不等同于模型服务商返回密钥错误 |
| 接口返回 429 | 同一账号已有请求进行中，或触发本站限流；等待后重试 |
| 修改 .env 后仍用旧配置 | 重启正确的 Node 进程；Docker 用 force-recreate；检查启动环境中的同名变量 |
| 外部模型地址校验失败 | 使用合法 HTTPS 地址，不带用户名、密码、查询参数或 fragment |
| 联系方式仍被打码 | 正常行为，需在启事详情完成防冒领问答，配置模型不会绕过验证 |

本项目会将模型错误统一处理为回退提示，不会在浏览器里暴露服务商原始错误和密钥。排查实际服务商鉴权、模型权限或配额时，结合服务商控制台查看；本站的 provider 字段也不能单独证明外部调用成功。

## 7. 密钥保存与关闭模型

- 真实密钥只写运行服务的 .env 或部署环境变量。不要写入本教程、.env.example、前端文件、截图或 GitHub。
- .env 已在仓库忽略规则中。提交前可运行 git check-ignore .env 确认其被忽略，不要使用 git add -f 强制上传。
- 如果误公开密钥，先在服务商控制台撤销并生成新密钥，再更新服务器配置；仅删除公开文件不能使旧密钥失效。
- 模型辅助会向配置的服务商发送消息、最近 8 条对话和检索字段。不要在聊天里输入个人敏感信息或防冒领答案。

不使用模型时，把助手配置恢复为以下值并重启：

~~~dotenv
AGENT_PROVIDER=heuristic
AGENT_API_KEY=
AGENT_BASE_URL=
AGENT_MODEL=
AGENT_TIMEOUT_MS=12000
AGENT_JSON_MODE=true
~~~

关闭后站内物品检索、相似匹配和原有防冒领流程继续可用。

本文按当前 agent/gateway.js、config.js、docker-compose.yml 与页面行为编写，官方入口核对日期：2026-11-19。示例未包含真实密钥，未对真实付费模型执行调用。实现与测试说明见 [AGENT.md](AGENT.md)。
