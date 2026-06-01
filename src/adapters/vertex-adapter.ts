import { IAdapter, AdapterResponse } from './types.js';
import { ProviderConfig, getConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { exec } from 'node:child_process';

export class VertexGeminiAdapter implements IAdapter {
  name: string;
  type: 'vertex-gemini' = 'vertex-gemini';
  private provider: ProviderConfig;
  private cachedToken: string = '';
  private tokenExpiry: number = 0;
  private lastGcloudFailureTime: number = 0;
  private activeTokenPromise: Promise<string> | null = null;

  constructor(provider: ProviderConfig) {
    this.name = provider.name;
    this.provider = provider;
  }

  private async resolveModelAndToken(payload: any, headers?: Record<string, string>) {
    // 1. 提取 target model
    let model = headers?.['x-target-model'] || headers?.['X-Target-Model'] || payload?._targetModel;
    if (!model) {
      if (payload?.model) {
        model = payload.model;
      } else {
        model = this.provider.models[0] || 'gemini-2.5-pro';
      }
    }

    // 2. 提取 Bearer Token
    let token = headers?.['authorization'] || headers?.['Authorization'];
    if (token && token.startsWith('Bearer ')) {
      token = token.substring(7);
    } else {
      token = await this.getBearerToken();
    }

    // 清洗临时字段
    if (payload) {
      delete payload._targetModel;
    }

    return { model, token };
  }

  private async getBearerToken(): Promise<string> {
    if (this.provider.api_key && !this.provider.api_key.startsWith('$')) {
      return this.provider.api_key;
    }
    if (process.env.VERTEX_BEARER_TOKEN) {
      return process.env.VERTEX_BEARER_TOKEN;
    }
    if (process.env.GCP_ACCESS_TOKEN) {
      return process.env.GCP_ACCESS_TOKEN;
    }
    if (process.env.VERTEX_API_KEY) {
      return process.env.VERTEX_API_KEY;
    }

    const now = Date.now();

    // 如果有有效的缓存 Token，直接返回
    if (this.cachedToken && now < this.tokenExpiry) {
      return this.cachedToken;
    }

    // 如果最近尝试 gcloud 失败，在 5 分钟内不再重复尝试，防止同步阻塞
    const FAILURE_CACHE_DURATION = 5 * 60 * 1000;
    if (now - this.lastGcloudFailureTime < FAILURE_CACHE_DURATION) {
      return '';
    }

    if (this.activeTokenPromise) {
      return this.activeTokenPromise;
    }

    // 智能开发者回退：尝试通过 gcloud cli 获取 (异步)
    this.activeTokenPromise = new Promise<string>((resolve) => {
      exec('gcloud auth print-access-token', {
        timeout: 2000
      }, (error, stdout) => {
        this.activeTokenPromise = null; // 任务完成后清除 Promise 引用
        if (error) {
          // 忽略，说明 gcloud cli 不可用或未登录
          this.lastGcloudFailureTime = Date.now();
          resolve('');
        } else {
          const gcloudToken = stdout.toString().trim();
          if (gcloudToken) {
            logger.info('[VERTEX_ADAPTER] 成功通过 gcloud cli 自动获取 Google Cloud Access Token');
            this.cachedToken = gcloudToken;
            const TOKEN_CACHE_DURATION = 50 * 60 * 1000; // 缓存 50 分钟
            this.tokenExpiry = Date.now() + TOKEN_CACHE_DURATION;
            resolve(gcloudToken);
          } else {
            resolve('');
          }
        }
      });
    });

    return this.activeTokenPromise;
  }

  /**
   * 执行非流式调用
   */
  async execute(
    payload: any,
    headers?: Record<string, string>
  ): Promise<AdapterResponse> {
    const requestId = headers?.['x-request-id'] || 'unknown';
    const { model, token } = await this.resolveModelAndToken(payload, headers);

    let baseUrl = this.provider.api_base_url;
    if (!baseUrl.endsWith('/')) {
      baseUrl += '/';
    }

    // Vertex AI URL 格式: https://{location}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent
    const url = `${baseUrl}${model}:generateContent`;
    logger.debug(`[VERTEX_ADAPTER] 发起非流式请求. URL: ${baseUrl}${model}:generateContent`, requestId);

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      reqHeaders['Authorization'] = `Bearer ${token}`;
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
      const text = await Promise.race([textPromise, bodyTimeoutPromise]).catch(() => 'Timeout reading response body');

      try {
        responseBody = text ? JSON.parse(text) : {};
      } catch (e) {
        responseBody = { error: { message: text } };
      }

      logger.info(`[VERTEX_ADAPTER] 非流式响应. Code: ${response.status}. 耗时: ${Date.now() - startTime}ms`, requestId);

      return {
        status: response.status,
        headers: responseHeaders,
        body: responseBody
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        logger.error(`[VERTEX_ADAPTER] 请求超时 (限制: ${timeoutMs}ms)`, requestId);
        throw new Error(`Upstream Vertex request timeout (${timeoutMs}ms)`);
      }
      logger.error(`[VERTEX_ADAPTER] 请求异常. 错误: ${err.message}`, requestId);
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
    const { model, token } = await this.resolveModelAndToken(payload, headers);

    let baseUrl = this.provider.api_base_url;
    if (!baseUrl.endsWith('/')) {
      baseUrl += '/';
    }

    // Vertex AI Stream URL: https://{location}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent?alt=sse
    const url = `${baseUrl}${model}:streamGenerateContent?alt=sse`;
    logger.debug(`[VERTEX_ADAPTER] 发起流式请求. URL: ${baseUrl}${model}:streamGenerateContent`, requestId);

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    };
    if (token) {
      reqHeaders['Authorization'] = `Bearer ${token}`;
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
        const text = await Promise.race([textPromise, bodyTimeoutPromise]).catch(() => 'Timeout reading error body');

        logger.error(`[VERTEX_ADAPTER] 流式请求握手失败. Code: ${response.status}. 详情: ${text}`, requestId);
        throw new Error(`Upstream Vertex stream error (${response.status}): ${text}`);
      }

      if (!response.body) {
        throw new Error('Upstream Vertex response body is empty');
      }

      logger.info(`[VERTEX_ADAPTER] 流式连接成功建立. 握手耗时: ${Date.now() - startTime}ms`, requestId);
      return response.body as any;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        logger.error(`[VERTEX_ADAPTER] 流式请求握手超时 (限制: 30000ms)`, requestId);
        throw new Error('Upstream Vertex stream handshake timeout (30000ms)');
      }
      logger.error(`[VERTEX_ADAPTER] 流式请求异常. 错误: ${err.message}`, requestId);
      throw err;
    }
  }
}
