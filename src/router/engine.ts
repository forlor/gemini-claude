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
   * 统一执行请求（仅进行协议翻译，不进行级联重试）
   */
  public async executeRequestWithFallback(
    request: any,
    headers: Record<string, string>,
    isStream: boolean,
    requestId: string
  ): Promise<any> {
    // 1. 动态解析首选路由目标
    const target = await this.resolve(request, { ...headers, 'x-request-id': requestId });

    // 2. 转换请求体
    const converterOptions: Record<string, any> = {
      requestId,
      apiKey: target.provider.api_key,
      apiBaseUrl: target.provider.api_base_url,
      providerType: target.provider.type
    };
    const convertedPayload = await target.converter.convertRequest(request, target.targetModel, converterOptions);

    // 3. 构建请求头
    const activeHeaders: Record<string, string> = {
      ...headers,
      'x-target-model': target.targetModel,
      'x-request-id': requestId
    };

    logger.info(`[ROUTER] 发起请求: [${target.provider.name}] -> [${target.targetModel}] (类型: ${target.provider.type})`, requestId);

    // 4. 执行调用
    try {
      if (isStream) {
        const rawStream = await target.adapter.executeStream(convertedPayload, activeHeaders);
        
        logger.info(`[ROUTER] 通道 [${target.provider.name}] 握手成功，正在转换流式响应`, requestId);
        return target.converter.convertStream(rawStream, target.targetModel, {
          requestId,
          prefillText: converterOptions.prefillText
        });
      } else {
        const response = await target.adapter.execute(convertedPayload, activeHeaders);

        if (response.status === 200) {
          logger.info(`[ROUTER] 通道 [${target.provider.name}] 请求成功. 状态码: 200`, requestId);
          return await target.converter.convertResponse(response.body, target.targetModel, {
            requestId,
            prefillText: converterOptions.prefillText
          });
        } else {
          logger.error(`[ROUTER] 通道 [${target.provider.name}] 请求失败. 状态码: ${response.status}`, requestId);
          throw new Error(`Upstream request error (${response.status}): ${JSON.stringify(response.body)}`);
        }
      }
    } catch (err: any) {
      logger.error(`[ROUTER] 调用 [${target.provider.name}] 异常. 错误: ${err.message}`, requestId);
      throw err;
    }
  }
}
