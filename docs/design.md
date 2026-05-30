# Gemini to Claude Code API 网关 (Gemini-Claude Gateway) — 高级架构与可扩展设计文档

## 1. 架构总览与设计哲学

### 1.1 设计哲学
- **抽象与解耦 (Abstraction & Decoupling)**: 核心框架只关心控制流、插件机制和消息生命周期。所有的 API 协议转换（如 Anthropic ↔ Gemini, OpenAI ↔ Gemini）都作为具体的 `Converter` 与 `Adapter` 插件注入。
- **无状态设计 (Statelessness)**: 网关尽可能保持无状态，以支持分布式多实例部署。针对多轮对话中的 `tool_use_id` 到函数名映射、`thoughtSignature` 持久化等状态问题，通过**数据结构自携带（自签名 ID 编码等）**来消除网关的内存状态，从而避免因服务重启、多实例负载均衡带来的状态丢失问题。
- **极致的鲁棒性 (Robustness)**: 大模型接口升级频繁，工具调用、JSON Schema 等协议极为脆弱。网关应内置强大的 Schema 净化与退级处理器，确保不因客户端微小的 Schema 差异导致上游 API 报错 (400)。
- **高性能流式管道 (High-Performance Streaming Pipe)**: 采用响应式流处理，逐字节/逐事件在管道中即时完成协议变换，实现最低的首字延迟与无感的流式体验。

### 1.2 整体架构图
```
                        ┌───────────────────────────────────────┐
                        │      Claude Code / Client CLI         │
                        └───────────────────┬───────────────────┘
                                            │ Anthropic API Protocol (JSON / SSE)
                                            ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                  Gateway Engine                                       │
│                                                                                       │
│  ┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐  │
│  │   Request Receiver   ├────>│     Router Engine    ├────>│  Dispatcher/Executor │  │
│  │  (Schema Validation) │     │(Dynamic/Rule Routing)│     │  (Load Balancing)    │  │
│  └──────────────────────┘     └──────────┬───────────┘     └──────────┬───────────┘  │
│                                          │                            │               │
│                                          ▼                            ▼               │
│  ┌────────────────────────────────────────────────────────────────────────────────┐  │
│  │                               Converter Pipeline                               │  │
│  │                                                                                │  │
│  │  ┌─────────────────────┐   ┌─────────────────────┐   ┌──────────────────────┐  │  │
│  │  │  Schema Sanitizer   │   │  Pre-fill Sanitizer │   │  Signature Roundtrip │  │  │
│  │  │ (JSON Schema Clean) │   │ (Truncation/Tail)   │   │   (Tool ID Encoding) │  │  │
│  │  └─────────────────────┘   └─────────────────────┘   └──────────────────────┘  │  │
│  │                                                                                │  │
│  │  ┌─────────────────────┐   ┌─────────────────────┐   ┌──────────────────────┐  │  │
│  │  │  Anthropic2Gemini   │   │   OpenAI2Gemini     │   │      Passthrough     │  │  │
│  │  │      Converter      │   │     Converter       │   │       Converter      │  │  │
│  │  └──────────┬──────────┘   └──────────┬──────────┘   └──────────┬───────────┘  │  │
│  └─────────────┼─────────────────────────┼─────────────────────────┼──────────────┘  │
│                │                         │                         │                  │
│                ▼                         ▼                         ▼                  │
│  ┌─────────────┴──────────┐   ┌──────────┴──────────┐   ┌──────────┴──────────┐      │
│  │    Gemini Adapter      │   │   OpenAI Adapter    │   │  Anthropic Adapter  │      │
│  │   (Google AI Studio)   │   │ (Compat API/DeepSeek)│  │   (Direct Anthropic)│      │
│  └─────────────┬──────────┘   └──────────┬──────────┘   └─────────────┬───────┘      │
└────────────────┼─────────────────────────┼─────────────────────────┼──────────────────┘
                 │                         │                         │
                 ▼                         ▼                         ▼
      ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
      │ Google AI Studio │      │DeepSeek/OpenRouter│     │  Anthropic API   │
      └──────────────────┘      └──────────────────┘      └──────────────────┘
```

---

## 2. 核心抽象与接口定义 (Core Abstraction)

网关设计围绕着三个核心抽象：`Route`、`Converter` 与 `Adapter`，实现关注点分离。

### 2.1 核心抽象接口定义

#### 2.1.1 `IConverter` (协议转换器)
```typescript
export interface IConverter {
  /**
   * 转换请求体：将标准的 Anthropic 请求转换为目标协议的请求
   * @param request 客户端原始 Anthropic 请求
   * @param targetModel 转换的目标模型（例如映射后的 gemini-2.5-pro）
   * @param options 转换附加参数（如是否开启 Thinking、思考预算、特定接口微调等）
   */
  convertRequest(
    request: AnthropicRequest,
    targetModel: string,
    options?: Record<string, any>
  ): Promise<any>;

  /**
   * 转换非流式响应
   * @param response 目标 upstream 返回的响应体
   * @param targetModel 转换的目标模型
   */
  convertResponse(
    response: any,
    targetModel: string
  ): Promise<AnthropicResponse>;

  /**
   * 转换流式响应：将上游的 Stream 变换为标准的 Anthropic SSE 事件流
   * @param upstreamStream 上游返回的原始 SSE 流或 Byte 流
   * @param targetModel 转换的目标模型
   */
  convertStream(
    upstreamStream: ReadableStream<Uint8Array>,
    targetModel: string
  ): ReadableStream<Uint8Array>;

  /**
   * 转换错误信息：将上游的异常统一映射为标准的 Anthropic Error 结构
   */
  convertError(error: any): AnthropicError;
}
```

#### 2.1.2 `IAdapter` (上游通道适配器)
```typescript
export interface IAdapter {
  name: string;
  type: string; // 'gemini' | 'vertex-gemini' | 'openai' | 'anthropic'
  
  /**
   * 执行非流式调用
   */
  execute(
    payload: any, 
    headers?: Record<string, string>
  ): Promise<AdapterResponse>;

  /**
   * 执行流式调用
   */
  executeStream(
    payload: any, 
    headers?: Record<string, string>
  ): Promise<ReadableStream<Uint8Array>>;
}
```

#### 2.1.3 `IRouter` (智能路由引擎)
```typescript
export interface IRouter {
  /**
   * 解析路由：根据请求特征和上下文动态解析出路由目标
   */
  resolve(
    request: AnthropicRequest,
    headers?: Record<string, string>
  ): Promise<RouteTarget>;
}

export interface RouteTarget {
  provider: ProviderConfig;
  targetModel: string;
  converter: IConverter;
  adapter: IAdapter;
}
```

---

## 3. 关键业务机制转换设计 (Core Mechanics & Optimization)

为了在 Claude Code 中完美、流畅地运行 Gemini 及其他接口，网关必须具备处理各种边缘情况（Corner Cases）和协议不兼容的“鲁棒层”。以下是借鉴并升级的高级机制设计：

### 3.1 思考闭环：Thinking Signature 往返设计
**挑战**：Gemini 2.5/3.0 推理模型会返回思考过程（`thought`）以及对应的 `thoughtSignature`。对于多轮对话，Google 要求必须完整回传历史消息中 model 的 `thoughtSignature`，以保持上下文的一致性和安全性。
但在工具调用循环中，Claude 客户端并不会自动保留上一步的自定义字段，甚至在生成 `tool_result` 时不会附带 `thoughtSignature`，从而在多轮后导致 400 错误 (Corrupted thought signature)。

**高级设计：Tool ID 自签名编码技术 (Zero-Memory Token Routing)**
- **设计原理**：网关保持无状态，将 `thoughtSignature` 编码嵌入到返回给客户端的工具调用 `id` 中（格式如 `toolu_<uuid>__thought__<thoughtSignature>`）。
- **流程图**：
  ```
  1. Gemini 推理 ──> 返回 thoughtSignature ("sig_xyz123") 和 tool_use.id ("call_abc")
  2. 网关合并 ────> 编码生成新 ID: "call_abc__thought__sig_xyz123"
  3. Claude 客户端 ─> 收到该 ID，执行工具
  4. Claude 客户端 ─> 发送 tool_result，其 tool_use_id 仍然是 "call_abc__thought__sig_xyz123"
  5. 网关解码 ────> 1) 还原原始工具 ID: "call_abc" 用于 functionResponse
                     2) 提取 thoughtSignature: "sig_xyz123" 重建 Gemini 侧的 thoughtSignature 节点
  ```
- **特殊签名过滤器**：对于预填充或系统额外生成的思考块，使用特殊的虚拟签名占位符 `skip_thought_signature_validator` 标记，确保在流和内容的边缘环节不引发上游校验失败。
- **无签名清理**：过滤模型历史消息，对于从 Claude 回传的、缺少签名的 `thinking` / `redacted_thinking` 节点，自动剥离其签名或将其转化为标准的 `text` 块。

### 3.2 鲁棒工具定义：JSON Schema 极致清洗
**挑战**：客户端（例如 Roo-Code / Claude Code）生成的工具调用 JSON Schema 包含许多高级 JSON Schema 规范（如 `$schema`、`oneOf`、`anyOf`、`additionalProperties`、`nullable: true`、`pattern` 等）。直接转发给 Google API 会导致严重的 400 参数格式错误。

**高级设计：JSON Schema 递归清洗与提示词退级 (Sanitizer)**
- **规范类型名大小写**：类型名称的大小写取决于上游 Provider。例如 Google AI Studio (API V1beta) 强要求 Schema 的 `type` 值为大写（`STRING`, `OBJECT`, `ARRAY`, `NUMBER`, `INTEGER`, `BOOLEAN` 等），而 OpenAI 兼容平台或某些中转 API 采用 lowercase 格式。网关的 `Schema Sanitizer` 在 `Converter` 处理阶段会读取目标 Provider 的元数据，自动映射类型名大小写。
- **不支持字段剔除**：彻底过滤并移除 `$schema`、`$id`、`$ref`、`definitions`、`additionalProperties`、`const` 等不支持的高级关键字。
- **anyOf / oneOf 单一退级**：
  - 如果 `anyOf` / `oneOf` 仅仅是支持联合 `null`（如 `type: ["string", "null"]`），转换为 `type: "string"`，并在描述中附加 `nullable` 说明。
  - 否则，优先保留支持 `object` / `array` 级别的复杂分支，或提取首个有效分支。
- **验证项隐式退级**：剥离 `minLength`, `maxLength`, `minimum`, `maximum`, `pattern`, `format` 等验证字段，将其自动转换并格式化为字符串，拼接在字段的 `description` 后部（例如：原 `description: "用户名"`，处理后 `description: "用户名 (validation - minLength: 3, maxLength: 20)"`），从而既保留了模型的约束引导，又避免了上游 Schema 报错。

### 3.3 预填充处理与收尾裁剪 (Pre-filling & Truncation)
**挑战**：Claude Code 常使用“预填充”技术（在 messages 列表最后追加一个 `role: assistant` 的消息来诱导模型输出）。然而，Vertex AI、某些特定的 OpenRouter 节点以及部分中转 API 严格限制连续的相同 role 消息，或限制列表结尾必须是 `user` 角色，否则直接拒绝请求。

**高级设计：消息末尾自动截断 (Tail Truncation)**
- 针对不支持预填充（Pre-fill）的 Provider 节点，网关启用末尾裁剪策略。
- **算法流程**：
  - 在请求转换前，扫描 `messages` 列表尾部。
  - 如果检测到结尾是 `role: assistant / model` 的消息，网关将循环 `pop` 移除该消息，直到尾端消息的角色为 `user`。
  - 记录移除的内容，将其作为 `pre-fill text` 融合到模型输出的第一帧，或干净移除。
  - 在响应端，将输出自动拼回裁剪掉的部分，保证客户端在多轮对话中上下文状态的一致性。

### 3.4 上下文缓存：Context Caching 自动管理
**挑战**：Claude Code 处理海量文件时，上下文会极速膨胀（往往达到几十万 token），这会导致极其昂贵的费用和巨大的首字延迟。Gemini 原生支持 Context Caching，但需要手动调用缓存端点创建并引用，这与 Claude 的 `cache_control` 的就地（In-place）声明逻辑相冲突。

**高级设计：零侵入式就地缓存机制 (Context Caching Bridge)**
- **探测逻辑**：网关实时监控 Anthropic 请求消息体中的 `cache_control` 标记。
- **阈值管理**：当检测到 `cache_control: { type: "ephemeral" }` 且消息总体积超过阈值（如 32k tokens）时，网关启动缓存管理。
- **创建与复用**：
  1. 通过对前缀内容（除最后一轮交互外的所有历史数据）进行 HASH 运算，生成唯一的 Context Cache 标识。
  2. 探测上游是否存在该 HASH 的 `cachedContents`。
  3. 若不存在，在后台（或同步）向上游 `/v1beta/cachedContents` 端点提交创建缓存。
  4. 缓存成功后，在接下来的主请求体中，自动附加 `"cachedContent": "projects/.../cachedContents/..."` 属性，直接跳过大量的 Prompt token。
  5. 实现了对客户端完全无感的秒级大文件分析。

### 3.5 并行工具调用重组与角色对齐 (Parallel Tool Call Realignment)
**挑战**：Claude Code 常发起并行工具调用（在单个助理消息中包含多个 `tool_use` 节点），并在下一步回传多个对应的 `tool_result` 节点。Gemini 原生虽然支持 `functionCall` 列表，但对其排序、结构对齐和严格的“交替对话规则”（Role Alternation）有着极强的校验：
- Gemini 强制要求 `functionResponse` 必须在紧接 `functionCall` 的下一个消息中提供。
- 若客户端因为工具异步加载导致回传的消息顺序、层级有细微偏差（例如分离成多次消息回复），或包含空的占位符，上游将返回 400。

**高级设计：完美交替重排算法 (Alternating Alignment Reorganizer)**
- **对齐处理**：在请求被转换送往 Gemini 之前，网关执行**完美交替重排算法**对 `contents` 树进行深度扫描。
- **双向规范化重排**：
  1. **扁平化分裂**：将同一个 `model` 消息中并行的多个 `functionCall` 与其在随后的多个 `user` 消息中的 `functionResponse` 抽离，拉平成按工具 ID 一一对应的 `functionCall -> functionResponse` 纯交替序列。
  2. **自对齐映射**：生成 `model` 角色的 `parts`，里面只包含一个 `functionCall`；紧接着生成一个 `user` 角色的 `parts`，里面只包含与该工具 `id` 精确对应的单个 `functionResponse`。
  3. **空 Part 清洗防御**：在重排过程中，若检测到含有非空白 `text` 的 Part 却存在空的 `text: ""`、空字典或未定义字段，网关将对其执行彻底清洗，剔除无效 Part，避免因空节点触发 Google 的请求拦截。

### 3.6 谷歌搜索 Grounding 工具自动融合（Web Search Grounding）
**挑战**：Gemini 推理与生成模型的一大核心能力是其内置的谷歌搜索实时 Grounding（`googleSearchRetrieval`）。如果无法优雅对接，客户端无法感知模型的联网检索意图和检索数据，也无法将搜索引用源展示给用户。

**高级设计：联网检索智能双向映射器**
- **请求触发端**：
  - **触发特征**：网关在路由解析或转换时，如检测到所选模型名称携带 `-search` 后缀（如 `gemini-2.5-pro-search`），或请求体中包含特殊的 `web_search` 工具标识，网关将自动向上游工具集 `tools[]` 注入标准的谷歌搜索 Grounding 声明：
    ```json
    { "googleSearch": {} } // Google AI Studio Native Search Tool
    ```
- **响应解析端**：
  - **元数据提取**：当上游响应（非流式或流式最后一帧）返回 `groundingMetadata` 时，网关的 Converter 收集其中所有的 `webSearchQueries`（检索词）与 `groundingChunks`（网页快照源，包含 `title` 和 `uri`）。
  - **引用源渲染（Grounding Citation Append）**：网关会自动将搜索词和引用文献，以优雅的 Markdown 格式（如 `> **Grounding Sources:** [1] [Python Docs](https://...)`）拼接到 Assistant 文本响应的最末端（或置入特定 block 中）。
  - 这保证了 Claude Code 无需做任何修改，就能原生具备带完整引用与来源链接的联网编码和解答能力。

### 3.7 工具 ID 双轨防御机制（Alphanumeric Pattern Adapter）
**挑战**：虽然通过在 `tool_use_id` 中嵌入 `__thought__<thoughtSignature>` 的 **Tool ID 自签名编码技术** 极其精妙且完全无状态，但在部分 Provider 部署中（例如企业级 Google Cloud Vertex AI 配置、以及某些兼容 Gateway 平台），上游对 `tool_use_id` 或 `id` 字段执行了严格的正则表达式安全校验（例如：仅允许 `^[a-zA-Z0-9_]+$`，长度不超过 64 等）。
此时，我们的 `__thought__` 编码连接符可能会因为包含特殊字符、双下划线或超长而被上游拒绝。

**高级设计：无损双轨映射策略**
- 网关引入 **工具 ID 模式自适应双轨适配机制**：
  - **Inline 轨道（无状态）**：默认启用。如果检测到目标 Provider 没有字符校验限制，优先采用 Tool ID 自签名嵌入。
  - **In-Memory Fallback 轨道（请求域生命周期）**：当识别到目标 Provider 为 `vertex-gemini` 或者是具有字符限制的节点时，网关自动回退至**有界生命周期内存双向映射表 (Bounded Lifecycle Context Map)**。
  - **运行逻辑**：
    1. 在本次 API 交互的请求域内，生成符合 `^[a-zA-Z0-9_]{32,64}$` 标准的纯净随机工具 ID（例如 `toolu_vertex_01ABC`）。
    2. 在本次请求生命周期内（非长期全局持久，随单个会话转换而分配并及时销毁），在 Context 级别维护 `toolu_vertex_01ABC` ─> `(original_id, thoughtSignature)` 的映射关系。
    3. 在接收到该请求对应的工具执行响应后，精准提取真正的签名，完成上游回传，在满足安全沙箱严格校验的前提下无损实现思考签名的闭环。

### 3.8 统一错误转译与自适应自动重试降级 (Error Translation & Fallback Routing)
**挑战**：上游 API 经常因为高负载、配额超限（Rate Limit 429）或网络波动产生暂时性报错。如果直接将原始的 429 或 500 JSON 报错抛回给 Claude Code，客户端会直接中断整个工作流，导致开发者体验极差。

**高级设计：错误容灾与级联降级策略**
- **标准错误转译 (Standardized Error Mapping)**：网关统一捕获上游异常，按照 HTTP 状态码和错误属性，高保真地映射为标准的 Anthropic 异常类型（如：将 `RESOURCE_EXHAUSTED` / `429` 映射为 `rate_limit_error`，将 `INVALID_ARGUMENT` / `400` 映射为 `invalid_request_error`），防止客户端解析异常崩溃。
- **自适应指数避让重试 (Exponential Backoff Retry)**：网关内置轻量级重试回路。遇到可重试状态码（429、500、503）时，在预设的重试次数限制内（如最大重试 3 次），自动执行带随机抖动的指数避让重试，在网关层将瞬时抖动消解。
- **备用 Provider 级联路由 (Cascade Fallback Routing)**：如果当前选用的 Provider 发生不可恢复的错误（如 API Key 额度耗尽、配额持续被限），路由引擎会启动备用降级，自动将该请求重定向到备用通道（例如：从 `Google AI Studio` 降级到 `Vertex AI`，或降级到 `OpenRouter/DeepSeek`），确保编码过程的绝对连续不中断。

### 3.9 多模态输入与长文档支持 (Multi-modal & PDF Native Document Bridge)
**挑战**：Claude Code 在进行复杂诊断时经常会发送图片（如编译报错截图、架构图）或上传 PDF/文本格式的长文档。Gemini 在原生多模态支持上极为强悍，但数据节点结构与 Anthropic 差异明显：
- Anthropic 采用 `type: "image"` 搭配 `source: { type: "base64", ... }`。
- Gemini 采用 `inlineData: { mimeType: "...", data: "..." }`，且支持丰富的 mimeTypes 甚至包括 `application/pdf`（PDF 文档原生多模态输入）。

**高级设计：全模态内容自适应适配器**
- **全格式 MimeType 解析器**：网关在处理 `messages` 数组时，自动解析 base64 数据的头部。若是常见图片格式（`png`、`jpeg`、`webp`、`gif`），完美重组为 `inlineData`。
- **长文档（PDF/TXT）就地多模态化**：针对客户端作为文件传输发送的 PDF 文档，网关自动提取其 base64 源，以 `application/pdf` 的原生类型通过 `inlineData` 喂给 Gemini 1.5/2.5/3.0，充分释放 Gemini 的多模态长文本原生解析潜力，免去在外部将 PDF 转换为大段拼接文本的损耗。

### 3.10 Token 计数与预算审计接口 (Token Counter & Cost Auditing)
**挑战**：Claude Code 在运行时会严格监控输入和输出 token 数量，以此来动态管理其上下文滑窗、计费统计和运行预算。
如果网关不能快速响应客户端的 Token 计数请求（如 `/v1/messages/count_tokens`），或者上游响应缺少真实的 usage 统计，客户端会失去控制，从而做出错误的上下文裁剪决定。

**高级设计：高性能双态 Token 估算器**
- **上游真实 Usage 追踪**：每一个流式或非流式的上游响应，网关都要求或追踪其 `usageMetadata`。利用 SSE 最后一帧的累积数据，回填进 Anthropic SSE 事件的 `message_delta` 的 `usage` 节点中，将 cached 算入 cache_read。
- **本地高性能启发式估算 (Heuristic Local Estimator)**：对于非核心、需要毫秒级瞬时返回的 Token 计数请求，网关使用本地优化后的高性能 BPE 算法（如对齐 GPT-4/Claude 风格的 Tokenizer）或高速启发式字符系数算法，根据消息字符数进行无阻碍的就地估算并极速响应，从而避免为了计数而频繁向上游发起昂贵的网络往返请求，显著降低网关的整体首字延迟（TTFT）。

### 3.11 极致可观测性：调试日志与流量转储 (Observability, Metrics & Traffic Dumping)
**挑战**：在日常开发或复杂的工具调用交互中，由于工具 Schema 调整频繁、思考签名繁多，排查转换协议对齐 bug 往往需要深入分析请求响应报文的微观字节流，若无良好的观测手段，调优会变得盲目。

**高级设计：全链路流量可观测总线**
- **动态日志分级 (Structured Logging)**：内置结构化日志输出，针对每笔请求生成唯一的 `request_id`，输出包含：路由决策（如：`Rule Matched: thinking -> gemini-2.5-pro`）、首字延迟（TTFT）、总传输耗时（Total Time）、以及 Token 吞吐指标。
- **流量离线转储总线 (Raw Traffic Dumping)**：当环境变量中开启 `DUMP_RAW_TRAFFIC=true` 时，网关会自动将该笔请求中的：`原始 Anthropic 请求` ─> `转换后的 Gemini 请求` ──> `上游返回的原始 SSE 数据流` ──> `转换后的 Anthropic SSE 数据流`，分别保存到本地 `.gemini-gateway/dumps/req_<request_id>/` 下。这为协议的微观对齐、调试和持续集成测试（CI）提供了坚不可摧的数据依据。

---

---

## 4. SSE 流式状态机设计 (SSE State Machine)

由于 Gemini 的 SSE 协议与 Anthropic 的细粒度事件协议（如 `message_start` -> `content_block_start` -> `content_block_delta` -> `content_block_stop` -> `message_delta` -> `message_stop`）完全不同，网关必须具备一个严密的流式响应合并状态机。

```
                              ┌──────────────────────────────┐
                              │          Initialize          │
                              └──────────────┬───────────────┘
                                             │ 发送 message_start
                                             ▼
                              ┌──────────────────────────────┐
                              │      Wait First Chunk        │
                              └──────────────┬───────────────┘
                                             │
                                             ├─────────────────────────────────────────┐
                                             ▼ (if text)                               ▼ (if thinking)
                              ┌──────────────────────────────┐          ┌──────────────────────────────┐
                              │       State: Text Block      │          │     State: Thinking Block    │
                              └──────────────┬───────────────┘          └──────────────┬───────────────┘
                                             │                                         │
               发送 delta (同类型)            │           切换 Part 类型                 │           发送 delta (同类型)
               ┌─────────────────────────────┼─────────────────────────────────────────┼─────────────────────────────┐
               │                             │                                         │                             │
               ▼                             ▼                                         ▼                             ▼
      [text_delta]                    发送 content_block_stop                  [thinking_delta]               发送 content_block_stop
                                      current_block_index++                    (thought signature)            current_block_index++
                                      发送 content_block_start                                                发送 content_block_start
                                             │                                                                       │
                                             └─────────────────────────┬─────────────────────────────────────────────┘
                                                                       │
                                                                       ▼
                                                       ┌──────────────────────────────┐
                                                       │    State: Tool Use Block     │
                                                       └───────────────┬──────────────┘
                                                                       │ 一次性发送 start + delta (input_json) + stop
                                                                       ▼
                                                       ┌──────────────────────────────┐
                                                       │          Stream End          │
                                                       └───────────────┬──────────────┘
                                                                       │ 发送 message_delta (stop_reason, usage)
                                                                       │ 发送 message_stop
                                                                       ▼
```

### 4.1 核心流控策略
1. **Part 类型切换检测**：网关必须时刻跟踪内存中的 `current_block_type`。每当上游 chunk 的 part 发生类型变动（例如：从 `thought` 变为 `text`，或从 `text` 变为 `functionCall`），先触发 `content_block_stop` 事件关闭旧块，递增 `block_index`，接着派发新的 `content_block_start` 事件，最后输出增量。
2. **跨 Chunk 内容拼接保证**：Gemini 有可能在多个连续的 chunk 中持续返回同一种 Part（如连续输出 `text`）。状态机此时必须抑制创建新 Block 的动作，直接将其作为 Delta 流向下游，避免客户端的 UI 显示破碎或引发 index error。
3. **延迟心跳保障**：流式连接长时间无数据传输可能会被客户端或中转网关切断。流处理器后台需启动定时器（例如每 15 秒），若无上游事件，自动写入 `: ping` 保持心跳。

---

## 5. 模块化路由与多 Provider 适配

为保证系统的扩展性，所有的模型请求都通过统一的路由引擎分发到具体的通道。

### 5.1 路由解析流
1. **提取上下文特征**：
   - 估算输入 Token 数量。
   - 识别是否有 Web Search 需求。
   - 探测 `thinking` 参数配置。
   - 检测特定的子代理标识。
2. **多层规则匹配**：
   - 检查高优先级的“显式模型重定向”标签（如特定注释或 headers 中的标签）。
   - 匹配规则：`longContext` -> `think` -> `background` -> `default`。
3. **加载自定义路由逻辑**：
   - 支持动态加载配置的 `CUSTOM_ROUTER_PATH` 外部路由脚本，赋予开发者通过编写简单 js 函数即可控制模型流量走向的能力。

### 5.2 统一配置矩阵示例
```json
{
  "PORT": 3456,
  "PROXY_URL": null,
  "Router": {
    "default": "gemini,gemini-2.5-pro",
    "background": "gemini,gemini-2.5-flash",
    "think": "gemini,gemini-2.5-pro",
    "longContext": "gemini,gemini-2.5-pro",
    "longContextThreshold": 60000
  },
  "Providers": [
    {
      "name": "gemini",
      "type": "gemini",
      "api_base_url": "https://generativelanguage.googleapis.com/v1beta/models/",
      "api_key": "$GEMINI_API_KEY",
      "models": ["gemini-2.5-pro", "gemini-2.5-flash"]
    },
    {
      "name": "vertex-gemini",
      "type": "vertex-gemini",
      "api_base_url": "https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/publishers/google/models/",
      "models": ["gemini-2.5-pro", "gemini-2.5-flash"]
    }
  ]
}
```

---

## 6. 扩展开发指南 (Extensibility Guide)

得益于完全的解耦设计，添加新的 Provider 或转换协议变得极其简单。

### 6.1 如何增加一个新的 Provider
1. 在 `src/converters/` 目录下创建一个新的转换器类，实现 `IConverter` 接口。
2. 在 `src/server/` 或对应工厂中注册该转换器。
3. 在配置文件 `config.json` 中的 `Providers` 数组中添加对应的配置，指定 `type` 即可。

### 6.2 如何自定义过滤与修改规则 (Middleware/Plugins)
转换管道采用中间件设计风格（Pipeline pattern）。任何在请求前和响应后的处理（如注入特定的 systemPrompt、敏感词过滤、监控指标采集等），只需注册对应的拦截器。
