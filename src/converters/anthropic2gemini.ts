import { IConverter } from './types.js';
import { cleanAndCaseJsonSchema } from './utils/schema-case.js';
import { truncateTrailingAssistant, injectPrefillToResponse } from './utils/message-truncator.js';
import { encodeToolId, decodeToolId, buildHistoricalToolMap } from './utils/tool-map.js';
import { injectWebSearchTool, appendSearchCitations } from './utils/web-search.js';
import { convertMultimodalBlock } from './utils/multimodal.js';
import { mergeSameRoleMessages, reorganizeToolMessages, GeminiPart, GeminiContent } from './utils/role-reorganizer.js';
import { detectAndApplyCaching } from './utils/context-cache.js';
import { parseSSEStream } from '../utils/sse-parser.js';
import { logger } from '../utils/logger.js';
import crypto from 'node:crypto';

export class AnthropicToGeminiConverter implements IConverter {
  /**
   * 转换请求体：将标准的 Anthropic 请求转换为目标协议的请求
   */
  async convertRequest(
    request: any,
    targetModel: string,
    options: Record<string, any> = {}
  ): Promise<any> {
    const requestId = options.requestId || 'unknown';
    logger.debug(`[CONVERTER] 开始转换请求. 目标模型: ${targetModel}`, requestId);

    // 1. 提取并清理 System Prompt
    let systemInstruction: any = undefined;
    if (request.system) {
      let systemText = '';
      if (typeof request.system === 'string') {
        systemText = request.system;
      } else if (Array.isArray(request.system)) {
        systemText = request.system
          .filter((block: any) => block && (typeof block === 'string' || block.type === 'text'))
          .map((block: any) => (typeof block === 'string' ? block : block.text || ''))
          .join('\n');
      }
      
      if (systemText.trim()) {
        systemInstruction = {
          parts: [{ text: systemText }]
        };
      }
    }

    // 2. 预填裁剪支持（Tail Truncation）
    // 裁剪掉尾部连续的 assistant 消息以保证交替规则，提取出 prefillText 传入 options 中
    const { messages: truncatedMessages, prefillText } = truncateTrailingAssistant(request.messages || []);
    if (prefillText) {
      options.prefillText = prefillText;
    }

    // 3. 构建历史消息并转换多模态和工具 ID
    const toolMap = buildHistoricalToolMap(request.messages || []);
    const contents: GeminiContent[] = [];

    for (const msg of truncatedMessages) {
      if (!msg || typeof msg !== 'object') continue;

      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts: GeminiPart[] = [];
      const rawContent = msg.content;

      if (typeof rawContent === 'string') {
        if (rawContent.trim()) {
          parts.push({ text: rawContent });
        }
      } else if (Array.isArray(rawContent)) {
        for (const block of rawContent) {
          if (!block || typeof block !== 'object') continue;

          if (block.type === 'text') {
            if (block.text?.trim()) {
              parts.push({ text: block.text });
            }
          } else if (block.type === 'image' || block.type === 'document') {
            const converted = convertMultimodalBlock(block);
            if (converted) {
              parts.push(converted);
            }
          } else if (block.type === 'tool_use') {
            // 解码并还原真实的 toolId，剥离 thoughtSignature
            const encodedId = block.id;
            const { originalId, signature } = decodeToolId(encodedId);
            
            const part: any = {
              functionCall: {
                id: originalId,
                name: block.name,
                args: block.input || {}
              }
            };

            if (signature) {
              part.thoughtSignature = signature;
            }

            parts.push(part);
          } else if (block.type === 'tool_result') {
            // 解码并还原 tool_use_id
            const encodedUseId = block.tool_use_id;
            const { originalId } = decodeToolId(encodedUseId);

            // 寻找对应的函数名。由于 Anthropic tool_result 没有 name 字段，必须从历史 tool_use 中查找
            let funcName = block.name || toolMap[encodedUseId] || toolMap[originalId];
            if (!funcName) {
              funcName = 'unknown_function';
            }

            // 提取工具输出内容为 string
            let outputText = '';
            if (typeof block.content === 'string') {
              outputText = block.content;
            } else if (Array.isArray(block.content)) {
              outputText = block.content
                .filter((b: any) => b && (typeof b === 'string' || b.type === 'text'))
                .map((b: any) => (typeof b === 'string' ? b : b.text || ''))
                .join('\n');
            }

            parts.push({
              functionResponse: {
                id: originalId,
                name: funcName,
                response: { output: outputText }
              }
            });
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    // 4. 合并相同角色 & 并行工具调用交替对齐重组
    const mergedContents = mergeSameRoleMessages(contents);
    const alignedContents = reorganizeToolMessages(mergedContents);

    // 5. 转换工具声明并递归净化（JSON Schema Sanitizer）
    let tools: any = undefined;
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      // 检查当前 Provider 是否需要 uppercase 规范
      const isUppercase = options.providerType !== 'openai-compat';
      const casedTools: any[] = [];

      for (const tool of request.tools) {
        if (!tool || typeof tool !== 'object') continue;
        const name = tool.name;
        const description = tool.description || '';
        const inputSchema = tool.input_schema || {};
        
        const cleanedSchema = cleanAndCaseJsonSchema(inputSchema, isUppercase ? 'uppercase' : 'lowercase');

        casedTools.push({
          name,
          description,
          parametersJsonSchema: cleanedSchema
        });
      }

      if (casedTools.length > 0) {
        tools = [{
          functionDeclarations: casedTools
        }];
      }
    }

    // 6. 联网检索（Web Search）自动注入
    if (targetModel.endsWith('-search') || options.enableWebSearch) {
      tools = injectWebSearchTool(tools);
    }

    // 7. 处理工具调用选项（Tool Choice）
    let toolConfig: any = undefined;
    if (request.tool_choice && typeof request.tool_choice === 'object') {
      const choiceType = request.tool_choice.type;
      if (choiceType === 'auto') {
        toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      } else if (choiceType === 'any') {
        toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      } else if (choiceType === 'tool') {
        const toolName = request.tool_choice.name;
        if (toolName) {
          toolConfig = {
            functionCallingConfig: {
              mode: 'ANY',
              allowedFunctionNames: [toolName]
            }
          };
        }
      }
    }

    // 8. 汇聚基础的 GenerationConfig
    const generationConfig: Record<string, any> = {
      temperature: request.temperature !== undefined ? request.temperature : 0.4,
      maxOutputTokens: request.max_tokens || 4000,
      candidateCount: 1
    };

    if (request.top_p !== undefined) generationConfig.topP = request.top_p;
    if (request.top_k !== undefined) generationConfig.topK = request.top_k;
    if (Array.isArray(request.stop_sequences) && request.stop_sequences.length > 0) {
      generationConfig.stopSequences = request.stop_sequences;
    }

    // 9. 智能思考深度匹配（Extended Thinking）
    const isThinkingModel = targetModel.includes('pro') || targetModel.includes('think') || options.isThinkingModel;
    if (isThinkingModel && request.thinking && typeof request.thinking === 'object') {
      const thinkingType = request.thinking.type;
      const budget = request.thinking.budget_tokens;

      if (thinkingType === 'enabled') {
        const thinkingConfig: Record<string, any> = {
          thinkingBudget: budget || 16000
        };

        // 如果是 Gemini 3 系列模型，支持并默认设置 thinkingLevel 为 HIGH
        if (targetModel.includes('gemini-3')) {
          const clientLevel = request.thinking.thinking_level || request.thinking.thinkingLevel;
          thinkingConfig.thinkingLevel = clientLevel || 'HIGH';
        }

        generationConfig.thinkingConfig = thinkingConfig;
        // 扩展最大输出以容纳思考 token 预算
        generationConfig.maxOutputTokens = (request.max_tokens || 4000) + (budget || 16000);
      }
    }

    // 10. 组装最终的上游 Gemini 请求体
    // 注意：Gemini url 自带模型名称参数，请求体中通常无需 model 字段，我们将其挂载在 options 中传输
    let geminiRequest: any = {
      contents: alignedContents,
      generationConfig
    };

    if (systemInstruction) geminiRequest.systemInstruction = systemInstruction;
    if (tools) geminiRequest.tools = tools;
    if (toolConfig) geminiRequest.toolConfig = toolConfig;

    // 11. 挂载缓存桥（Context Caching）
    if (options.apiKey && options.apiBaseUrl) {
      geminiRequest = await detectAndApplyCaching(
        geminiRequest,
        options.apiKey,
        options.apiBaseUrl,
        requestId
      );
    }

    return geminiRequest;
  }

  /**
   * 转换非流式响应：将上游的响应体还原为标准的 Anthropic 响应
   */
  async convertResponse(
    response: any,
    targetModel: string,
    options: Record<string, any> = {}
  ): Promise<any> {
    const requestId = options.requestId || 'unknown';
    logger.debug('[CONVERTER] 开始转换非流式响应', requestId);

    if (!response || typeof response !== 'object') {
      throw new Error('Invalid upstream response');
    }

    const candidate = response.candidates?.[0] || {};
    const parts = candidate.content?.parts || [];
    const finishReason = candidate.finishReason || 'STOP';
    
    let content: any[] = [];
    let hasToolUse = false;

    // 先扫描获取 thoughtSignature
    let responseThoughtSignature: string | undefined = undefined;
    for (const part of parts) {
      if (part && part.thought === true && part.thoughtSignature) {
        responseThoughtSignature = part.thoughtSignature;
        break;
      }
    }

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;

      if (part.thought === true) {
        if (!options.clientSupportsThinking) {
          // 客户端不支持 thinking，直接过滤掉，不发射任何内容
          continue;
        }
        // 处理思考过程
        const block: any = {
          type: 'thinking',
          thinking: part.text || ''
        };
        if (part.thoughtSignature) {
          block.signature = part.thoughtSignature;
        }
        content.push(block);
      } else if (part.functionCall) {
        // 遭遇工具调用：利用双轨制对工具 ID 进行高可靠自编码
        hasToolUse = true;
        const fc = part.functionCall;
        const useFallback = options.providerType === 'vertex-gemini';

        // 还原/自编码
        const originalId = fc.id || `toolu_${crypto.randomUUID().replace(/-/g, '')}`;
        const encodedId = encodeToolId(originalId, part.thoughtSignature || responseThoughtSignature, fc.name, useFallback);

        content.push({
          type: 'tool_use',
          id: encodedId,
          name: fc.name,
          input: fc.args || {}
        });
      } else if ('text' in part) {
        // 处理常规文本
        let text = part.text || '';
        // 谷歌检索 Grounding 融合
        if (response.groundingMetadata) {
          text = appendSearchCitations(text, response.groundingMetadata);
        }
        content.push({
          type: 'text',
          text
        });
      }
    }

    // 自动回填裁剪掉的预填文本
    if (options.prefillText) {
      content = injectPrefillToResponse(content, options.prefillText);
    }

    // 映射 stop_reason
    let stop_reason = 'end_turn';
    if (hasToolUse && finishReason === 'STOP') {
      stop_reason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
      stop_reason = 'max_tokens';
    }

    // 解析 usage 统计
    const usageMetadata = response.usageMetadata || {};
    const cachedTokens = usageMetadata.cachedContentTokenCount || 0;
    const promptTokens = usageMetadata.promptTokenCount || 0;
    const usage: any = {
      input_tokens: Math.max(promptTokens - cachedTokens, 0),
      output_tokens: usageMetadata.candidatesTokenCount || 0
    };
    if (cachedTokens > 0) {
      usage.cache_read_input_tokens = cachedTokens;
    }

    return {
      id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      model: targetModel,
      content,
      stop_reason,
      stop_sequence: null,
      usage
    };
  }

  /**
   * 转换流式响应：实现高保真细粒度事件状态机
   */
  convertStream(
    upstreamStream: ReadableStream<Uint8Array>,
    targetModel: string,
    options: Record<string, any> = {}
  ): ReadableStream<Uint8Array> {
    const requestId = options.requestId || 'unknown';
    logger.debug('[CONVERTER] 开始转换流式响应管道', requestId);

    const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
    const prefillText = options.prefillText || '';
    const useFallback = options.providerType === 'vertex-gemini';

    // 15 秒定时心跳保护
    let pingInterval: NodeJS.Timeout | null = null;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const sseStream = parseSSEStream(upstreamStream, requestId);
        let messageStartSent = false;
        
        let currentBlockType: 'text' | 'thinking' | null = null;
        let currentBlockIndex = -1;
        let currentThinkingSignature: string | null = null;
        let hasToolUse = false;
        
        let cachedTokens = 0;
        let promptTokens = 0;
        let outputTokens = 0;
        let finishReason = 'STOP';
        const accumulatedFunctionCalls = new Map<string, {
          id: string;
          name: string;
          args: Record<string, any>;
          thoughtSignature?: string;
        }>();
        let lastActiveToolKey: string | null = null;

        function sseEmit(event: string, data: any) {
          const raw = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(new TextEncoder().encode(raw));
        }

        // 启动心跳定时器
        pingInterval = setInterval(() => {
          controller.enqueue(new TextEncoder().encode(': ping\n\n'));
        }, 15000);

        function closeBlock() {
          if (currentBlockType !== null) {
            sseEmit('content_block_stop', {
              type: 'content_block_stop',
              index: currentBlockIndex
            });
            currentBlockType = null;
          }
        }

        function buildUsagePayload() {
          const payload: any = {
            input_tokens: Math.max(promptTokens - cachedTokens, 0),
            output_tokens: outputTokens
          };
          if (cachedTokens > 0) {
            payload.cache_read_input_tokens = cachedTokens;
          }
          return payload;
        }

        try {
          // 注入被裁剪的预填内容
          if (prefillText) {
            logger.debug('[CONVERTER_STREAM] 开始回填裁剪后的预填文本事件', requestId);
            
            // 确保 message_start 已发出
            messageStartSent = true;
            sseEmit('message_start', {
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: targetModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
              }
            });

            // 预填一个 text content_block
            currentBlockIndex = 0;
            currentBlockType = 'text';
            sseEmit('content_block_start', {
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: { type: 'text', text: '' }
            });
            sseEmit('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'text_delta', text: prefillText }
            });
            // 保持 currentBlockType = 'text' 开启，方便后续增量直接追加
          }

          for await (const chunk of sseStream) {
            const candidate = chunk.candidates?.[0] || {};
            const parts = candidate.content?.parts || [];
            
            // 更新 Usage 信息 (采用上游最新帧数据)
            if (chunk.usageMetadata) {
              const usage = chunk.usageMetadata;
              if (usage.promptTokenCount !== undefined) promptTokens = usage.promptTokenCount;
              if (usage.candidatesTokenCount !== undefined) outputTokens = usage.candidatesTokenCount;
              if (usage.cachedContentTokenCount !== undefined) cachedTokens = usage.cachedContentTokenCount;
            }

            if (candidate.finishReason) {
              finishReason = candidate.finishReason;
            }

            // 发送 message_start（如果在回填 prefillText 时未发送过）
            if (!messageStartSent) {
              messageStartSent = true;
              sseEmit('message_start', {
                type: 'message_start',
                message: {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  model: targetModel,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: buildUsagePayload()
                }
              });
            }

            // 处理 Parts 状态流转
            for (let partIndex = 0; partIndex < parts.length; partIndex++) {
              const part = parts[partIndex];
              if (!part || typeof part !== 'object') continue;

              // 1. 处理思考模块
              if (part.thought === true) {
                if (!options.clientSupportsThinking) {
                  // 客户端不支持 thinking，直接过滤掉，不发射任何内容
                  continue;
                }
                const text = part.text || '';
                const sig = part.thoughtSignature || '';

                // 如果状态不同或者签名发生了变化，强行关闭当前块，开启新的 thinking 块
                if (currentBlockType !== 'thinking' || (sig && sig !== currentThinkingSignature)) {
                  closeBlock();
                  currentBlockIndex++;
                  currentBlockType = 'thinking';
                  currentThinkingSignature = sig;

                  const startBlock: any = { type: 'thinking', thinking: '' };
                  if (sig) startBlock.signature = sig;

                  sseEmit('content_block_start', {
                    type: 'content_block_start',
                    index: currentBlockIndex,
                    content_block: startBlock
                  });
                }

                if (text) {
                  sseEmit('content_block_delta', {
                    type: 'content_block_delta',
                    index: currentBlockIndex,
                    delta: { type: 'thinking_delta', thinking: text }
                  });
                }
                continue;
              }

              // 2. 处理工具调用模块 (移到 text 之前，并使用 partIndex 保证并行工具调用的唯一性)
              if (part.functionCall) {
                hasToolUse = true;
                const fc = part.functionCall;
                // 使用 fc.id 或 name + partIndex 作为唯一 key，防止并行同名工具调用（如多个子 agent）被合并覆盖
                const key = fc.id || `${fc.name}_${partIndex}`;

                if (!accumulatedFunctionCalls.has(key)) {
                  accumulatedFunctionCalls.set(key, {
                    id: fc.id || `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
                    name: fc.name,
                    args: {},
                    thoughtSignature: part.thoughtSignature || currentThinkingSignature || undefined
                  });
                }

                const existing = accumulatedFunctionCalls.get(key)!;

                // 持续更新 thoughtSignature
                if (part.thoughtSignature) {
                  existing.thoughtSignature = part.thoughtSignature;
                } else if (currentThinkingSignature && !existing.thoughtSignature) {
                  existing.thoughtSignature = currentThinkingSignature;
                }

                if (fc.args) {
                  existing.args = {
                    ...existing.args,
                    ...fc.args
                  };
                }

                lastActiveToolKey = key;
                continue;
              }

              // 3. 处理常规文本模块
              if ('text' in part) {
                let text = part.text || '';
                if (!text) continue;

                if (chunk.groundingMetadata) {
                  text = appendSearchCitations(text, chunk.groundingMetadata);
                }

                if (currentBlockType !== 'text') {
                  closeBlock();
                  currentBlockIndex++;
                  currentBlockType = 'text';

                  sseEmit('content_block_start', {
                    type: 'content_block_start',
                    index: currentBlockIndex,
                    content_block: { type: 'text', text: '' }
                  });
                }

                sseEmit('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'text_delta', text }
                });
                continue;
              }
            }
          }

          // 循环读取结束，关闭最后可能依然处于开启状态的内容块
          closeBlock();

          // 在流结束前，将所有累积并聚合后的工具调用（functionCall）统一发射给客户端
          if (accumulatedFunctionCalls.size > 0) {
            for (const fc of accumulatedFunctionCalls.values()) {
              currentBlockIndex++;
              // 使用自适应双轨制进行工具 ID 还原/自编码
              const encodedId = encodeToolId(fc.id, fc.thoughtSignature, fc.name, useFallback);
              
              sseEmit('content_block_start', {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: encodedId,
                  name: fc.name,
                  input: {}
                }
              });

              sseEmit('content_block_delta', {
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify(fc.args)
                }
              });

              sseEmit('content_block_stop', {
                type: 'content_block_stop',
                index: currentBlockIndex
              });
            }
          }

          // 统一映射流式 stop_reason
          let stop_reason = 'end_turn';
          if (hasToolUse && finishReason === 'STOP') {
            stop_reason = 'tool_use';
          } else if (finishReason === 'MAX_TOKENS') {
            stop_reason = 'max_tokens';
          }

          // 发送最后一帧统计 Usage
          sseEmit('message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason,
              stop_sequence: null
            },
            usage: buildUsagePayload()
          });

          sseEmit('message_stop', {
            type: 'message_stop'
          });

        } catch (err: any) {
          logger.error(`[CONVERTER_STREAM_CRITICAL] 流式变换管道遭遇致命报错: ${err.message}`, requestId);
          sseEmit('error', {
            type: 'error',
            error: {
              type: 'api_error',
              message: `Stream translation error: ${err.message}`
            }
          });
        } finally {
          if (pingInterval) clearInterval(pingInterval);
          controller.close();
        }
      }
    });
  }

  /**
   * 错误转换
   */
  convertError(error: any): any {
    const status = error.status || 500;
    const message = error.message || 'Unknown upstream gateway error';

    let errType = 'api_error';
    if (status === 429) errType = 'rate_limit_error';
    else if (status === 503 || status === 529) errType = 'overloaded_error';
    else if (status === 400) errType = 'invalid_request_error';
    else if (status === 401 || status === 403) errType = 'authentication_error';
    else if (status === 404) errType = 'not_found_error';

    return {
      type: 'error',
      error: {
        type: errType,
        message
      }
    };
  }
}
