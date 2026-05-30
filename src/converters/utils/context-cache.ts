import crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';

interface CacheEntry {
  cachedContentId: string;
  expireTime: string;
  model: string;
}

// 内存中的 HASH -> CachedContentId 缓存映射表
const cacheRegistry = new Map<string, CacheEntry>();

/**
 * 计算输入内容列表的确定性 SHA-256 HASH，用于零时延缓存匹配
 */
function calculatePrefixHash(contents: any[], systemInstruction?: any): string {
  const hash = crypto.createHash('sha256');
  
  if (systemInstruction) {
    hash.update(JSON.stringify(systemInstruction));
  }
  
  hash.update(JSON.stringify(contents));
  return hash.digest('hex');
}

/**
 * 估算内容的字符数大小（作为 Token 的粗略估算，缓存阈值通常为 32,768 词以上，约 100k+ 字符）
 */
function estimateCharSize(contents: any[], systemInstruction?: any): number {
  let size = 0;
  
  if (systemInstruction && systemInstruction.parts) {
    for (const part of systemInstruction.parts) {
      if (part.text) size += part.text.length;
    }
  }

  for (const content of contents) {
    if (content && Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (part.text) size += part.text.length;
        else if (part.inlineData) size += part.inlineData.data?.length || 0;
      }
    }
  }

  return size;
}

/**
 * 零侵入式 Context Cache Bridge：自动计算前缀 HASH 并与上游 Context Caching 系统完成静默对接
 * 
 * @param geminiRequest 已经构建好的标准 Gemini 格式请求
 * @param apiKey API 密钥
 * @param apiBaseUrl API 基础网关地址
 * @param requestId 请求链路 ID
 * @returns 注入或处理缓存引用后的最终请求
 */
export async function detectAndApplyCaching(
  geminiRequest: any,
  apiKey: string,
  apiBaseUrl: string,
  requestId: string
): Promise<any> {
  const model = geminiRequest.model || '';
  const contents = geminiRequest.contents || [];
  const systemInstruction = geminiRequest.systemInstruction;

  // 1. Caching 条件前置校验
  // 只有 2.5/3.0 推理及主系列模型支持缓存，且一般只有当对话多于一轮时，对前 N-1 轮进行缓存才具有意义
  if (!model.includes('gemini') || contents.length < 3) {
    return geminiRequest;
  }

  // 2. 截取前缀内容进行缓存（除最后一轮 user 问答外的所有历史）
  // 按照 Google 最佳实践，缓存必须在最末尾留出至少一轮的交互空间
  const cachePrefixContents = contents.slice(0, -2);
  const totalChars = estimateCharSize(cachePrefixContents, systemInstruction);

  // 估算：通常一个 token 为 3~4 字符，32k token 大约是 100k~120k 字符。
  // 我们设置一个安全的 110,000 字符门槛作为自动启用缓存的触发条件。
  const AUTO_CACHE_CHAR_THRESHOLD = 110000;

  if (totalChars < AUTO_CACHE_CHAR_THRESHOLD) {
    return geminiRequest;
  }

  const prefixHash = calculatePrefixHash(cachePrefixContents, systemInstruction);
  const modelNamePath = model.startsWith('models/') ? model : `models/${model}`;

  // 3. 检查本地内存映射表，若是 Cache Hit，则瞬间就地引用，实现 0ms 接入耗时
  if (cacheRegistry.has(prefixHash)) {
    const entry = cacheRegistry.get(prefixHash)!;
    // 检查缓存对应的模型是否相同
    if (entry.model === modelNamePath) {
      logger.info(`[CONTEXT_CACHE] ⚡ Cache Hit! 已直接挂载上游缓存: ${entry.cachedContentId}`, requestId);
      return {
        ...geminiRequest,
        cachedContent: entry.cachedContentId
      };
    }
  }

  // 4. Cache Miss：静默、异步、安全地向上游申请创建 Context Cache
  logger.info(`[CONTEXT_CACHE] Cache Miss. 历史前缀满足缓存条件 (长度: ${totalChars} 字符)，准备注册上游缓存...`, requestId);

  try {
    // 准备创建缓存的请求体
    const cacheRequestBody = {
      model: modelNamePath,
      contents: cachePrefixContents,
      systemInstruction: systemInstruction,
      ttl: '1800s', // 默认生命周期 30 分钟
      displayName: `claude_code_session_${prefixHash.substring(0, 12)}`
    };

    // 构建创建缓存的官方端点 URL
    const cleanBaseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
    // 上游标准端点：https://generativelanguage.googleapis.com/v1beta/cachedContents?key=...
    // 或者是：${api_base_url}/v1beta/cachedContents?key=...
    let createUrl = '';
    if (cleanBaseUrl.includes('v1beta')) {
      const parts = cleanBaseUrl.split('/v1beta');
      createUrl = `${parts[0]}/v1beta/cachedContents?key=${apiKey}`;
    } else {
      createUrl = `${cleanBaseUrl}/cachedContents?key=${apiKey}`;
    }

    const t0 = Date.now();
    const response = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(cacheRequestBody)
    });

    if (response.ok) {
      const data: any = await response.json();
      const cachedContentId = data.name; // 格式如: cachedContents/some_unique_id
      const expireTime = data.expireTime;
      const duration = Date.now() - t0;

      if (cachedContentId) {
        cacheRegistry.set(prefixHash, {
          cachedContentId,
          expireTime,
          model: modelNamePath
        });
        
        logger.info(`[CONTEXT_CACHE] 成功写入并同步上游缓存 (耗时: ${duration}ms, 标识: ${cachedContentId}, 有效期至: ${expireTime})`, requestId);
        
        // 成功后，将本笔请求立刻升级挂载为缓存模式
        return {
          ...geminiRequest,
          cachedContent: cachedContentId
        };
      }
    } else {
      const errText = await response.text();
      logger.warn(`[CONTEXT_CACHE_WARN] 向上游创建缓存失败 (状态码: ${response.status}): ${errText.substring(0, 300)}`, requestId);
    }
  } catch (err: any) {
    // 缓存失败应该完全“降级退路”，不能阻断用户请求！继续使用原始未缓存请求完成服务
    logger.error(`[CONTEXT_CACHE_ERROR] 申请上游缓存时发生意外异常 (已平滑降级): ${err.message}`, requestId);
  }

  return geminiRequest;
}
