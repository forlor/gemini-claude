import { IAdapter, AdapterResponse } from './types.js';
import { ProviderConfig, getConfig } from '../config.js';
import { logger } from '../utils/logger.js';

export class GeminiAdapter implements IAdapter {
  name: string;
  type: 'gemini' = 'gemini';
  private provider: ProviderConfig;

  constructor(provider: ProviderConfig) {
    this.name = provider.name;
    this.provider = provider;
  }

  private resolveModelAndKey(payload: any, headers?: Record<string, string>) {
    // 1. 提取 target model
    let model = headers?.['x-target-model'] || headers?.['X-Target-Model'] || payload?._targetModel;
    if (!model) {
      // 从 payload 中自动探测
      if (payload?.model) {
        model = payload.model;
      } else {
        // 回退至 provider 配置中的第一个模型
        model = this.provider.models[0] || 'gemini-2.5-pro';
      }
    }

    // 剥离可能存在的 models/ 前缀，防止拼接出双重前缀的无效 URL
    if (model && model.startsWith('models/')) {
      model = model.substring(7);
    }

    // 2. 提取 apiKey
    let apiKey = headers?.['x-api-key'] || headers?.['X-Api-Key'] || this.provider.api_key;
    if (!apiKey) {
      apiKey = process.env.GEMINI_API_KEY || '';
    }

    // 清洗临时字段
    if (payload) {
      delete payload._targetModel;
    }

    return { model, apiKey };
  }

  /**
   * 执行非流式调用
   */
  async execute(
    payload: any,
    headers?: Record<string, string>
  ): Promise<AdapterResponse> {
    const requestId = headers?.['x-request-id'] || 'unknown';
    const { model, apiKey } = this.resolveModelAndKey(payload, headers);

    // 构建基础 URL
    let baseUrl = this.provider.api_base_url || 'https://generativelanguage.googleapis.com/v1beta/models/';
    if (!baseUrl.endsWith('/')) {
      baseUrl += '/';
    }

    const url = `${baseUrl}${model}:generateContent`;
    logger.debug(`[GEMINI_ADAPTER] 发起非流式请求. URL: ${baseUrl}${model}:generateContent`, requestId);

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-goog-api-client': 'gemini-gateway/1.0.0',
    };
    if (apiKey) {
      reqHeaders['x-goog-api-key'] = apiKey;
    }

    // 复制客户端传入的非敏感/非网关控制 header
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        const lowerK = k.toLowerCase();
        if (!['host', 'content-length', 'content-type', 'connection', 'x-api-key', 'x-target-model', 'authorization'].includes(lowerK)) {
          reqHeaders[k] = v;
        }
      }
    }

    const startTime = Date.now();
    const config = getConfig();
    const timeoutMs = config.API_TIMEOUT_MS || 600000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });

      let responseBody: any;

      // 安全读取响应体，防止上游挂起导致网关无限期卡死
      const textPromise = response.text();
      const bodyTimeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout reading response body')), 15000)
      );
      let text: string;
      try {
        text = await Promise.race([textPromise, bodyTimeoutPromise]);
      } catch (err: any) {
        controller.abort();
        text = 'Timeout reading response body';
      }

      try {
        responseBody = text ? JSON.parse(text) : {};
      } catch (e) {
        responseBody = { error: { message: text } };
      }

      logger.info(`[GEMINI_ADAPTER] 非流式请求响应. Code: ${response.status}. 耗时: ${Date.now() - startTime}ms`, requestId);

      return {
        status: response.status,
        headers: responseHeaders,
        body: responseBody
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        logger.error(`[GEMINI_ADAPTER] 非流式请求超时 (限制: ${timeoutMs}ms)`, requestId);
        throw new Error(`Upstream request timeout (${timeoutMs}ms)`);
      }
      logger.error(`[GEMINI_ADAPTER] 非流式请求异常. 错误: ${err.message}`, requestId);
      throw err;
    }
  }

  /**
   * 执行流式调用
   */
  async executeStream(
    payload: any,
    headers?: Record<string, string>
  ): Promise<ReadableStream<Uint8Array>> {
    const requestId = headers?.['x-request-id'] || 'unknown';
    const { model, apiKey } = this.resolveModelAndKey(payload, headers);

    let baseUrl = this.provider.api_base_url || 'https://generativelanguage.googleapis.com/v1beta/models/';
    if (!baseUrl.endsWith('/')) {
      baseUrl += '/';
    }

    const url = `${baseUrl}${model}:streamGenerateContent?alt=sse`;
    logger.debug(`[GEMINI_ADAPTER] 发起流式请求. URL: ${baseUrl}${model}:streamGenerateContent`, requestId);

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'x-goog-api-client': 'gemini-gateway/1.0.0',
    };
    if (apiKey) {
      reqHeaders['x-goog-api-key'] = apiKey;
    }

    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        const lowerK = k.toLowerCase();
        if (!['host', 'content-length', 'content-type', 'connection', 'x-api-key', 'x-target-model', 'authorization'].includes(lowerK)) {
          reqHeaders[k] = v;
        }
      }
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s 握手超时保护

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        // 安全读取错误体，防止上游挂起导致网关无限期卡死
        const textPromise = response.text();
        const bodyTimeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout reading error body')), 5000)
        );
        let text: string;
        try {
          text = await Promise.race([textPromise, bodyTimeoutPromise]);
        } catch (err: any) {
          controller.abort();
          text = 'Timeout reading error body';
        }

        logger.error(`[GEMINI_ADAPTER] 流式请求握手失败. Code: ${response.status}. 详情: ${text}`, requestId);
        throw new Error(`Upstream stream error (${response.status}): ${text}`);
      }

      if (!response.body) {
        throw new Error('Upstream response body is empty');
      }

      logger.info(`[GEMINI_ADAPTER] 流式连接成功建立. 握手耗时: ${Date.now() - startTime}ms`, requestId);
      return response.body as any;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        logger.error(`[GEMINI_ADAPTER] 流式请求握手超时 (限制: 30000ms)`, requestId);
        throw new Error('Upstream stream handshake timeout (30000ms)');
      }
      logger.error(`[GEMINI_ADAPTER] 流式请求异常. 错误: ${err.message}`, requestId);
      throw err;
    }
  }
}
