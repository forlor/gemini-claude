# Gemini-to-Claude-Code API Gateway 使用指南 (Getting Started & Deployment)

本项目是一个专门针对 **Claude Code** (或 Roo-Code, Cline 等) 设计的高性能、低延迟本地 API 转换网关。它能将标准的 Anthropic 协议无缝转换为 Google Gemini 协议，并支持智能路由、级联故障转移、Context Caching 自动管理、联网检索双向融合以及 strict-regex 工具 ID 规避（Vertex AI 支持）。

本指南将为您详细梳理如何配置、开发、测试以及在生产环境中构建和部署本网关。

---

## 1. 前提条件 (Prerequisites)

运行本网关需要以下环境：
*   **Node.js**: `v22.0.0` 或更高版本（推荐使用内置 `fetch` 和标准 Web Streams 的最新 LTS 版本，本项目在 Node `v22.22.1` 下开发及测试完毕）。
*   **包管理工具**: 推荐使用 `pnpm` (本项目基于 `pnpm` 锁文件进行依赖锁定)。
*   *(可选)* **Google Cloud SDK (gcloud)**: 如果需要使用 GCP Vertex AI 通道，且未配置 explicit API 密钥或 Access Token，本地安装并登录 `gcloud` 即可自动实现 ADC (Application Default Credentials) 令牌的无缝刷新。

---

## 2. 配置文件说明 (Configuration)

网关启动时会**自动探测**并加载配置文件。其物理加载优先级顺序为：
1.  当前工作目录下的 `./config.json`
2.  `~/.gemini-gateway/config.json` (用户家目录)

### 2.1 默认自动生成的 `config.json` 模板：
如果您在启动时没有提供配置文件，网关会自动在当前目录下生成一个默认模板，内容如下：

```json
{
  "PORT": 3456,
  "LOG": true,
  "LOG_LEVEL": "info",
  "API_TIMEOUT_MS": 600000,
  "Providers": [
    {
      "name": "gemini",
      "type": "gemini",
      "api_base_url": "https://generativelanguage.googleapis.com/v1beta/models/",
      "api_key": "$GEMINI_API_KEY",
      "models": ["gemini-2.5-pro", "gemini-2.5-flash"]
    }
  ],
  "Router": {
    "default": "gemini,gemini-2.5-pro",
    "background": "gemini,gemini-2.5-flash",
    "think": "gemini,gemini-2.5-pro",
    "longContext": "gemini,gemini-2.5-pro",
    "longContextThreshold": 60000
  }
}
```

### 2.2 核心配置字段解析：
*   **`PORT`**: 网关服务监听的本地端口（默认 `3456`）。也可以通过环境变量 `PORT` 直接覆写。
*   **`APIKEY`**: *(可选)* 网关自身的 API 密钥。如果配置此项，客户端请求头中必须携带 `x-api-key: <您的网关密钥>` 或者是 `Authorization: Bearer <您的网关密钥>` 才能通过鉴权。
*   **`Providers`**: 上游通道提供商定义数组。
    *   `type`: `'gemini'` (AI Studio 格式) 或 `'vertex-gemini'` (GCP 格式)。
    *   `api_key`: 可以填入具体的密钥，或者填入以 `$` 开头的环境变量占位符（如 `$GEMINI_API_KEY`），网关在启动时会自动读取并插值替换。
*   **`Router`**: 智能流量流向路由矩阵。格式为 `"${provider_name},${target_model_name}"`。
    *   `default`: 默认路由指向的目标。
    *   `background`: 客户端发出 haiku / flash / 快速轻量任务时，分流至此通道（如 flash 廉价节点）。
    *   `think`: 客户端启用 thinking 推理或指定高级模型时，分流至此通道（如开启推理深度的 pro 节点）。
    *   `longContext`: 当探测到本次对话总 Token 数大于 `longContextThreshold` 时，强制分流至此高上下文承载通道。

---

## 3. 本地开发指南 (Local Development)

在本地进行开发、定制或协议微调时，请按以下步骤运行：

### 3.1 环境变量配置
在项目根目录下创建一个 `.env` 文件（或直接在终端中 `export` 环境变量）：

```env
# 谷歌 AI Studio API 密钥
GEMINI_API_KEY="您的_AI_Studio_ApiKey"

# (可选) 开启极细粒度的全链路报文离线流量转储 (用于协议对齐和 Debug)
DUMP_RAW_TRAFFIC=true

# (可选) 外部自定义 JavaScript 路由脚本绝对/相对路径 (Task 5.5)
# CUSTOM_ROUTER_PATH="./my-custom-router.js"
```

### 3.2 安装依赖
```bash
pnpm install
```

### 3.3 运行开发服务 (热重载监控)
使用内置的 `tsx` 工具运行。该脚本会监控 `src/` 目录下所有 TypeScript 源码的改动并自动重启服务，无需每次手动编译：

```bash
pnpm run dev
```
控制台将输出服务启动成功的日志：
`[SYSTEM] Gateway 成功启动并开始监听: http://localhost:3456`

---

## 4. 回归测试套件运行 (Testing)

网关内置了一套高保真、完全自闭环的单元/集成回归测试套件。它能够在本地 0ms 完美模拟各种极端的客户端请求、上游响应、SSE 帧变动、工具调用重排及路由解析决策。

在修改完核心代码或升级 Hono 路由逻辑后，**强烈建议在提交前运行此命令进行自测**：

```bash
npx tsx tests/regression.test.ts
```
如果测试通过，终端最末尾会高亮输出：
`🎉 ALL REGRESSION TESTS PASSED SUCCESSFULLY! 100% PROTOCOL COMPLIANT! 🎉`

---

## 5. 生产环境构建与启动 (Production Compilation & Run)

在生产、服务器或 Docker 环境中部署时，请按照标准 TypeScript 编译流程运行。

### 5.1 编译打包 (Production Compile)
执行以下命令，TypeScript 编译器（`tsc`）会根据 `tsconfig.json` 的严格类型约束进行校验并将其编译成标准的、支持 ESM (ES Modules) 的高效 JavaScript 产物：

```bash
pnpm run build
```
构建产物会统一输出到根目录下的 `dist/` 文件夹。

### 5.2 生产环境启动 (Production Start)
使用 Node.js 直接高效率、无开销地加载编译后的 JS 代码启动：

```bash
pnpm run start
```
或者直接运行：
```bash
node dist/index.js
```

---

## 6. 与 Claude Code 对接指南 (Claude Code Integration)

当网关在本地 `3456` 端口成功运行后，您可以极其简单地通过环境变量覆写，让 **Claude Code CLI** 的流量全部静默流经本网关，由 Gemini Pro 2.5 代替 Claude 的运行：

```bash
# 1. 设定任意非空 api-key 绕过 Claude CLI 的本地校验限制
export ANTHROPIC_API_KEY="sk-any-placeholder-string"

# 2. 将 Anthropic 的基础请求 URL 重定向到我们的本地网关
export ANTHROPIC_BASE_URL="http://localhost:3456/v1"

# 3. 启动 Claude Code CLI 体验由本地网关提供的 Gemini 推理服务！
claude
```

*(如果您在使用 Windows PowerShell)*:
```powershell
$env:ANTHROPIC_API_KEY="sk-any-placeholder-string"
$env:ANTHROPIC_BASE_URL="http://localhost:3456/v1"
claude
```

---

## 7. 流量与日志转储观测 (Observability & Traffic Dumps)

当您在 `.env` 中开启了 `DUMP_RAW_TRAFFIC=true`，对于客户端发送的每一笔会话，网关都会在本地生成一个调试包：
*   **路径**: `.gemini-gateway/dumps/req_<request_id>/`
*   **转储文件**:
    *   `client_request.json`: 客户端发送的原始标准 Anthropic 请求报文。
    *   `upstream_request.json`: 转换后的 Gemini 原生请求报文。
    *   `raw_upstream_stream.log`: 上游返回的未转译的原始 SSE 数据流。
    *   `converted_client_stream.log`: 网关向客户端发送的、经过状态机重构后的标准 Anthropic 细粒度 SSE 事件流。

这为可观测性、问题排查和离线集成测试提供了业界天花板级的可观测保障。
