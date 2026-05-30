import { IAdapter } from '../adapters/types.js';
import { AppConfig, ProviderConfig } from '../config.js';
import { GeminiAdapter } from '../adapters/gemini-adapter.js';
import { VertexGeminiAdapter } from '../adapters/vertex-adapter.js';
import { AnthropicToGeminiConverter } from '../converters/anthropic2gemini.js';
import { detectRequestFeatures, RequestFeatures } from './detector.js';
import { logger } from '../utils/logger.js';
import fs from 'node:fs';
import path from 'node:path';

export interface RouteTarget {
  provider: ProviderConfig;
  targetModel: string;
  converter: AnthropicToGeminiConverter;
  adapter: IAdapter;
}

export class RouterEngine {
  private config: AppConfig;
  private adapters: Map<string, IAdapter> = new Map();
  private converter: AnthropicToGeminiConverter;

  constructor(config: AppConfig) {
    this.config = config;
    this.converter = new AnthropicToGeminiConverter();
    this.initializeAdapters();
  }

  private initializeAdapters() {
    for (const provider of this.config.Providers) {
      const adapter = this.createAdapter(provider);
      if (adapter) {
        this.adapters.set(provider.name, adapter);
        logger.info(`[ROUTER_ENGINE] 已注册通道适配器: ${provider.name} (${provider.type})`);
      }
    }
  }

  private createAdapter(provider: ProviderConfig): IAdapter | null {
    if (provider.type === 'gemini') {
      return new GeminiAdapter(provider);
    } else if (provider.type === 'vertex-gemini') {
      return new VertexGeminiAdapter(provider);
    }
    logger.warn(`[ROUTER_ENGINE] 不支持的 Provider 类型: ${provider.type}`);
    return null;
  }

  private getAdapterForProvider(provider: ProviderConfig): IAdapter {
    let adapter = this.adapters.get(provider.name);
    if (!adapter) {
      const created = this.createAdapter(provider);
      if (!created) {
        throw new Error(`Failed to create adapter for provider: ${provider.name}`);
      }
      this.adapters.set(provider.name, created);
      adapter = created;
    }
    return adapter;
  }

  /**
   * 尝试动态加载并执行外部自定义路由脚本 (Task 5.5)
   */
  private async tryCustomRouter(
    request: any,
    features: RequestFeatures,
    headers?: Record<string, string>
  ): Promise<{ providerName: string; targetModel: string } | null> {
    const customPath = this.config.CUSTOM_ROUTER_PATH;
    if (!customPath) return null;

    try {
      const resolvedPath = path.isAbsolute(customPath)
        ? customPath
        : path.resolve(process.cwd(), customPath);

      if (!fs.existsSync(resolvedPath)) {
        return null;
      }

      // 动态导入自定义路由脚本。支持 CJS 或 ESM 格式
      // 自定义路由脚本应默认导出一个函数：
      // export default function route(request, features, headers) { return { provider: "...", model: "..." }; }
      const module = await import(`file://${resolvedPath}`);
      const routeFn = module.default || module.route;
      
      if (typeof routeFn === 'function') {
        const result = await routeFn(request, features, headers);
        if (result && result.provider && result.model) {
          logger.info(`[ROUTER_ENGINE] 触发自定义外部路由脚本. 决策目标 -> Provider: ${result.provider}, Model: ${result.model}`);
          return {
            providerName: result.provider,
            targetModel: result.model
          };
        }
      }
    } catch (err: any) {
      logger.error(`[ROUTER_ENGINE] 自定义路由脚本执行异常: ${err.message}. 退回标准路由规则。`);
    }
    return null;
  }

  /**
   * 核心路由决策逻辑 (Task 5.2)
   */
  public async resolve(
    request: any,
    headers?: Record<string, string>
  ): Promise<RouteTarget> {
    const requestId = headers?.['x-request-id'] || 'unknown';
    
    // 1. 运行规则探测器获取当前请求的特征
    const features = detectRequestFeatures(request, this.config.Router);
    logger.debug(`[ROUTER_ENGINE] 特征探测完成 - Token 估算: ${features.estimatedTokens}, WebSearch: ${features.hasWebSearch}, Thinking: ${features.hasThinking}, LongContext: ${features.isLongContext}`, requestId);

    // 2. 尝试执行自定义路由
    const customDecision = await this.tryCustomRouter(request, features, headers);
    
    let chosenTargetStr = '';
    let reason = '';

    if (customDecision) {
      chosenTargetStr = `${customDecision.providerName},${customDecision.targetModel}`;
      reason = 'Custom Router Script';
    } else {
      // 3. 按照级联优先级决策规则：WebSearch -> Think -> longContext -> background -> default
      const r = this.config.Router;
      if (features.hasWebSearch) {
        // 联网检索强制分流至 Think (或默认) 具备更高推理和格式约束的高级模型中
        chosenTargetStr = r.think || r.default;
        reason = 'Feature: Web Search';
      } else if (features.hasThinking) {
        chosenTargetStr = r.think || r.default;
        reason = 'Feature: Thinking Budget';
      } else if (features.isLongContext) {
        chosenTargetStr = r.longContext || r.default;
        reason = `Feature: Long Context (Tokens: ${features.estimatedTokens} >= ${r.longContextThreshold || 60000})`;
      } else {
        // 根据客户端请求的模型名进行特征判断
        const reqModel = String(request.model || '').toLowerCase();
        if (reqModel.includes('haiku') || reqModel.includes('flash')) {
          chosenTargetStr = r.background || r.default;
          reason = 'Model Class: Fast / Background (Haiku/Flash)';
        } else {
          chosenTargetStr = r.default;
          reason = 'Default Route';
        }
      }
    }

    // 4. 解析选择的目标，格式如 "gemini,gemini-2.5-pro"
    const parts = chosenTargetStr.split(',');
    const providerName = parts[0]?.trim();
    const targetModel = parts[1]?.trim();

    if (!providerName || !targetModel) {
      throw new Error(`Invalid router destination: ${chosenTargetStr}`);
    }

    // 5. 匹配 Provider
    const provider = this.config.Providers.find(p => p.name === providerName);
    if (!provider) {
      throw new Error(`Route destination specifies provider "${providerName}", but it is not defined in Providers config.`);
    }

    const adapter = this.getAdapterForProvider(provider);

    logger.info(`[ROUTER] 路由解析结果: [${providerName}] -> [${targetModel}]. 依据: ${reason}`, requestId);

    return {
      provider,
      targetModel,
      converter: this.converter,
      adapter
    };
  }

  /**
   * 生成所有候选降级级联目标 (Task 5.3)
   */
  public getFallbackCandidates(primary: RouteTarget): RouteTarget[] {
    const candidates: RouteTarget[] = [primary];

    // 1. 寻找支持完全相同 targetModel 的其他提供商
    const peerProviders = this.config.Providers.filter(
      p => p.name !== primary.provider.name && p.models.includes(primary.targetModel)
    );

    for (const prov of peerProviders) {
      const adapter = this.getAdapterForProvider(prov);
      candidates.push({
        provider: prov,
        targetModel: primary.targetModel,
        converter: this.converter,
        adapter
      });
    }

    // 2. 如果是 Pro 系列模型，备选降级可以追加到 Flash 模型
    if (primary.targetModel.includes('pro') || primary.targetModel.includes('sonnet')) {
      const backupModel = 'gemini-2.5-flash';
      const flashProviders = this.config.Providers.filter(p => p.models.includes(backupModel));
      for (const prov of flashProviders) {
        // 避免重复加入同一个 provider+model
        const alreadyExists = candidates.some(
          c => c.provider.name === prov.name && c.targetModel === backupModel
        );
        if (!alreadyExists) {
          const adapter = this.getAdapterForProvider(prov);
          candidates.push({
            provider: prov,
            targetModel: backupModel,
            converter: this.converter,
            adapter
          });
        }
      }
    }

    return candidates;
  }

  /**
   * 统一级联故障转移与指数避让重试执行入口 (Task 5.3)
   */
  public async executeRequestWithFallback(
    request: any,
    headers: Record<string, string>,
    isStream: boolean,
    requestId: string
  ): Promise<any> {
    // 1. 动态解析首选路由目标
    const primary = await this.resolve(request, { ...headers, 'x-request-id': requestId });

    // 2. 获取候选的级联降级链
    const candidates = this.getFallbackCandidates(primary);
    let lastError: any = null;

    for (let i = 0; i < candidates.length; i++) {
      const target = candidates[i];
      const isLastCandidate = i === candidates.length - 1;

      let retries = 3;
      let delay = 500; // 毫秒

      while (retries > 0) {
        try {
          logger.info(`[CASCADE] 尝试通道: [${target.provider.name}] -> [${target.targetModel}] (类型: ${target.provider.type}). 剩余尝试: ${retries}`, requestId);

          // A. 转换请求体
          const converterOptions: Record<string, any> = {
            requestId,
            apiKey: target.provider.api_key,
            apiBaseUrl: target.provider.api_base_url,
            providerType: target.provider.type
          };
          const convertedPayload = await target.converter.convertRequest(request, target.targetModel, converterOptions);

          // B. 构建请求头
          const activeHeaders: Record<string, string> = {
            ...headers,
            'x-target-model': target.targetModel,
            'x-request-id': requestId
          };

          // C. 执行调用
          if (isStream) {
            const rawStream = await target.adapter.executeStream(convertedPayload, activeHeaders);
            
            // 握手成功，将其交由转换器转换成标准的 Anthropic SSE 事件流
            logger.info(`[CASCADE] 通道 [${target.provider.name}] 握手成功，正在转换流式响应`, requestId);
            return target.converter.convertStream(rawStream, target.targetModel, {
              requestId,
              prefillText: converterOptions.prefillText
            });
          } else {
            const response = await target.adapter.execute(convertedPayload, activeHeaders);

            if (response.status === 200) {
              logger.info(`[CASCADE] 通道 [${target.provider.name}] 成功返回. 状态码: 200`, requestId);
              return await target.converter.convertResponse(response.body, target.targetModel, {
                requestId,
                prefillText: converterOptions.prefillText
              });
            } else if (response.status === 429) {
              if (!isLastCandidate) {
                logger.warn(`[CASCADE] 通道 [${target.provider.name}] 触发频控/配额超限(429). 立即切换至下一个备选通道.`, requestId);
                break; // 跳出当前重试循环，直接进入下一个 candidate
              }
              throw new Error(`Upstream rate limit (429): ${JSON.stringify(response.body)}`);
            } else if (response.status >= 500) {
              throw new Error(`Upstream server error (${response.status}): ${JSON.stringify(response.body)}`);
            } else {
              // 400, 401, 403, 404 等请求级别 validation error，一般不需要重试
              throw new Error(`Upstream validation error (${response.status}): ${JSON.stringify(response.body)}`);
            }
          }
        } catch (err: any) {
          lastError = err;
          logger.warn(`[CASCADE] 调用 [${target.provider.name}] 失败. 错误: ${err.message}`, requestId);

          // 如果是 400 / 校验或鉴权错误，且不是最后一个候选者，立即启动通道降级
          const isValidationError = err.message.includes('validation error') || err.message.includes('400') || err.message.includes('401') || err.message.includes('403');
          if (isValidationError && !isLastCandidate) {
            logger.warn(`[CASCADE] 发生非重试性校验/配置错误，静默切换下一个通道.`, requestId);
            break; // 直接进入下一个 candidate
          }

          retries--;
          if (retries > 0) {
            logger.info(`[CASCADE] 指数退避等待 ${delay}ms 后进行下一次重试...`, requestId);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
          }
        }
      }
    }

    logger.error(`[CASCADE] 严重错误：所有通道和重试选项全部耗尽！`, requestId);
    throw lastError || new Error('All cascade routing candidates exhausted.');
  }
}
