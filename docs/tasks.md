# Gemini-Claude Gateway — 开发任务清单 (Task Checklist)

本清单将 `docs/design.md` 中的系统设计分解为具体、可执行、高粒度的开发任务。每一项任务都与设计文档中的特定章节与机制相挂钩，从而确保开发路径清晰、闭环。

---

## 阶段一：项目初始化与底层脚手架搭建 (Directly maps to Section 1, 4 & 5)

- [ ] **Task 1.1: 基础脚手架与编译选项配置**
  - **设计映射**：Section 1.3 技术选型 / Section 4. 项目结构
  - **任务描述**：
    - 初始化 pnpm 空间，安装 TypeScript、eslint、prettier 并编写 `tsconfig.json` 配置。
    - 引入核心 HTTP 框架 `Hono`，完成项目目录结构的搭建（`src/converters/`、`src/router/`、`src/utils/` 等）。
- [ ] **Task 1.2: 结构化配置加载器实现**
  - **设计映射**：Section 3.2 配置文件格式 / Section 5.2 统一配置矩阵示例
  - **任务描述**：
    - 实现 `src/config.ts` 配置加载模块，支持加载全局 JSON 配置文件、解析当前环境变量插值（如将 `$GEMINI_API_KEY` 解析为具体值）并完成运行时类型校验。
- [ ] **Task 1.3: 高保真结构化审计日志模块开发**
  - **设计映射**：Section 3.11 极致可观测性：调试日志与流量转储
  - **任务描述**：
    - 实现唯一的 `request_id` 全链路追踪机制（基于 Hono 中间件）。
    - 编写结构化日志记录器（`src/utils/logger.ts`），输出包含：路由决策（如：`Rule Matched: thinking -> gemini-2.5-pro`）、首字延迟（TTFT）、总传输耗时以及 Token 吞吐指标。
- [ ] **Task 1.4: 流量转储总线实现 (Traffic Dumping)**
  - **设计映射**：Section 3.11 极致可观测性：调试日志与流量转储
  - **任务描述**：
    - 开发离线流量转储机制。当检测到环境变量 `DUMP_RAW_TRAFFIC=true` 时，在后台将原请求、上游请求、上游返回的原生流、以及网关转译后的 SSE 流实时输出转储到 `.gemini-gateway/dumps/req_<request_id>/` 目录下，为协议微调提供支撑。

---

## 阶段二：协议转换核心实现（Converter 核心层）(Directly maps to Section 2.1 & 3)

- [ ] **Task 2.1: JSON Schema 递归净化器与大小写转换器**
  - **设计映射**：Section 3.2 鲁棒工具定义：JSON Schema 极致清洗
  - **任务描述**：
    - 实现 `src/converters/utils/schema-case.ts` 清洗逻辑。递归剥离 `$schema`, `anyOf`, `additionalProperties` 等不支持的限制关键字。
    - 将验证性关键字转换为描述文本并拼接于 `description` 结尾。
    - 读取目标 Provider 元数据，自适应执行大小写映射（如 Google AI Studio 映射为 `STRING`，OpenAI 映射为 `string`）。
- [ ] **Task 2.2: 助手消息预填与收尾裁剪处理器（Tail Truncation）**
  - **设计映射**：Section 3.3 预填充处理与收尾裁剪
  - **任务描述**：
    - 实现 `src/converters/utils/message-truncator.ts`。自动检测并在请求转换前裁剪掉 `messages` 末尾连续的助理/模型角色（`assistant`/`model`）消息。
    - 记录被截断的文本并安全拼接到响应流的第一帧中，保证客户端在多轮对话中的上下文连续。
- [ ] **Task 2.3: 工具 ID 自编码双轨适配器实现（Inline vs In-Memory Fallback）**
  - **设计映射**：Section 3.1 思考闭环 / Section 3.7 工具 ID 双轨防御机制
  - **任务描述**：
    - 编写工具 ID 解析适配器 `src/converters/utils/tool-map.ts`。
    - **Inline 轨道（无状态）**：利用 `__thought__` 分隔符将 `thoughtSignature` 编码合并进 `tool_use_id`。
    - **In-Memory Fallback 轨道（请求周期生命范围）**：对有强正则校验（如仅支持字母数字）的 Provider（如 Vertex），自动使用随机无符号 ID 作为替换，并在单次请求响应生命周期内通过有界内存 Map 进行绑定还原，在不触发报错的前提下无损回传签名。
- [ ] **Task 2.4: 谷歌搜索（Web Search Grounding）双向映射器**
  - **设计映射**：Section 3.6 谷歌搜索 Grounding 工具自动融合
  - **任务描述**：
    - **请求侧**：识别 `-search` 特征后缀模型或联网请求指令，向 tools 集合中注入 `{ "googleSearch": {} }`。
    - **响应侧**：解析上游响应中的 `groundingMetadata`（提取 `webSearchQueries` 及 `groundingChunks` 链接与标题），以漂亮的 Markdown 块拼接到回复末尾。
- [ ] **Task 2.5: 多模态输入与 PDF 长文档原生转换桥**
  - **设计映射**：Section 3.9 多模态输入与长文档支持
  - **任务描述**：
    - 实现全模态自适应映射。将 base64 形式的图片无损包装为 `inlineData`。
    - 实现 PDF 文档原生识别：提取 PDF 的 base64 源，作为 `application/pdf` 原生多模态对象直接送入 Gemini，免除昂贵的文本解析和转译损耗。
- [ ] **Task 2.6: 完美交替重排与空节点过滤算法（Role Alternation）**
  - **设计映射**：Section 3.5 并行工具调用重组与角色对齐
  - **任务描述**：
    - 实现交替重排算法。扫描 `contents`，将并行的 `functionCall` 与其后回传的多个 `functionResponse`，在不丢失语境的前提下重排、拆分为完美交替的 `model -> user -> model` 节点。
    - 扫描整个请求体，执行空 Part 清洗防御，自动剔除无有效内容却包含空的 `text: ""` 或空字典的冗余节点，避免 400 校验错误。

---

## 阶段三：长上下文 Context Caching 管理层 (Directly maps to Section 3.4)

- [ ] **Task 3.1: cache_control 探测与 HASH 签名计算**
  - **设计映射**：Section 3.4 上下文缓存：Context Caching 自动管理
  - **任务描述**：
    - 实现在中间件或转换阶段对 `cache_control: { type: "ephemeral" }` 标记的实时检测。
    - 当消息达到 32k tokens 阈值时，对需要缓存的历史消息进行 HASH 运算，生成唯一的 Caching ID。
- [ ] **Task 3.2: 零侵入式 Context Cache Bridge 实现**
  - **设计映射**：Section 3.4 上下文缓存：Context Caching 自动管理
  - **任务描述**：
    - 封装上游 Caching 管理 API（`/v1beta/cachedContents`）。检查上游 HASH 的缓存是否存在：若不存在，自动将长上下文注册到上游；若存在，自动在请求体中附加 `"cachedContent": "..."` 引用，降本增效。

---

## 阶段四：高性能流式变换与状态机 (Directly maps to Section 4)

- [ ] **Task 4.1: SSE 增量解析与流式变换处理器**
  - **设计映射**：Section 4. SSE 流式状态机设计
  - **任务描述**：
    - 开发流式数据帧（Byte 级别）解析器，将流数据稳定重组为结构化 JSON 块，并能安全跳过或处理空 Part。
- [ ] **Task 4.2: 细粒度流控状态机实现 (State Machine)**
  - **设计映射**：Section 4. SSE 流式状态机设计 / Section 4.1 核心流控策略
  - **任务描述**：
    - 实现流式状态机控制逻辑。严密追踪 `current_block_type` 和单调递增的 `block_index`。
    - **类型切换机制**：遇到类型不同时先发 `content_block_stop`、自增 `block_index`、再发送 `content_block_start`，最后发送增量。
    - **Delta 合并机制**：对跨 chunk 同类型 Part 数据做直接合并发送（如连续 text 增量），防止前台 UI 文字撕裂或 index error。
- [ ] **Task 4.3: 延迟心跳保护与最后一帧 Usage 回填**
  - **设计映射**：Section 4.1 核心流控策略 / Section 3.10 Token 计数与预算审计接口
  - **任务描述**：
    - 开发每 15 秒定时派发的心跳保活逻辑（输出 `: ping\n\n` ），保持长连接活跃。
    - 在流最后一帧中精准捕获 `usageMetadata`。解析并将 `cachedContentTokenCount` 计入 `cache_read_input_tokens` 随最后一帧的 `message_delta` 的 `usage` 节点一同送回客户端。

---

## 阶段五：模块化路由与通道适配器层 (Directly maps to Section 2.2 & 5)

- [ ] **Task 5.1: 统一 Adapter 实现 (AI Studio & Vertex)**
  - **设计映射**：Section 2.2.2 `IAdapter`
  - **任务描述**：
    - 实现 AI Studio 适配器：基于 API Key 访问，支持流式与非流式。
    - 实现 Vertex AI 适配器：支持基于 OAuth2 默认应用凭证（ADC）动态刷新 Bearer 访问 Token，并支持自定义路径路由和 API 头设置。
- [ ] **Task 5.2: 规则探测器（Rule Detector）与智能路由引擎实现**
  - **设计映射**：Section 5. 模块化路由与多 Provider 适配 / Section 2.2.3 `IRouter`
  - **任务描述**：
    - 实现探测器（`src/router/detector.ts`），探测 Web Search 需求、估算输入 Token、探测 Thinking 配置。
    - 级联路由决定引擎：`WebSearch` -> `Think` -> `longContext` -> `background` -> `default`。
- [ ] **Task 5.3: 级联降级路由与自动避让重试中间件集成**
  - **设计映射**：Section 3.8 统一错误转译与自适应自动重试降级
  - **任务描述**：
    - 将 Task 3.8 翻译层、自动避让重试逻辑包装成统一的代理中间件。
    - 实现多 Provider 级联降级路由，保证主通道挂掉后静默转接到备用通道并映射输出。
- [ ] **Task 5.4: 高性能本地 Token 计数器与估算端点**
  - **设计映射**：Section 3.10 Token 计数与预算审计接口
  - **任务描述**：
    - 实现 `/v1/messages/count_tokens` 高速估算端点。在本地采用轻量 BPE 算法对文本长度、字符特征等进行毫秒级估算，避免向 Google AI Studio 发起耗时且昂贵的 API 往返。
- [ ] **Task 5.5: 自定义路由脚本动态加载机制**
  - **设计映射**：Section 5.1 路由解析流 / Section 3.2 统一配置矩阵示例
  - **任务描述**：
    - 实现对 `CUSTOM_ROUTER_PATH` js 外部路由文件的动态加载、安全沙箱执行（动态干预拦截流量并重定向）。

---

## 阶段六：系统整合与端到端回归测试 (Directly maps to Section 7 & 8)

- [ ] **Task 6.1: 统一服务暴露与路由分发**
  - **设计映射**：Section 4. 项目结构 / Section 7. 使用方式
  - **任务描述**：
    - 串联 Hono 服务器、中间件与路由引擎，将主入口 `/v1/messages` 接口接入转换管道。
- [ ] **Task 6.2: 端到端高保真回归测试套件**
  - **设计映射**：Section 8. 开发阶段 (P0 & P1)
  - **任务描述**：
    - 针对非流式/流式普通对话、流式并行工具调用、Thinking 回传、大小写自动规范、网络中断/Rate Limit (429) 重试、备用降级、谷歌检索 Grounding 引用拼接进行回归测试编写，确保 100% 兼容。
