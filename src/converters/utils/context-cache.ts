import crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { getConfig } from '../../config.js';

interface CacheEntry {
  cachedContentId: string;
  expireTime: string;
  model: string;
}

// 内存中的 HASH -> CachedContentId 缓存映射表
const cacheRegistry = new Map<string, CacheEntry>();

// 被自动检测探测为免费层级（不支持 Context Caching）的模型集合
const freeTierModels = new Set<string>();

/**
 * 清理过期的缓存条目，并限制 Map 最大容量为 1000 以防止内存泄漏
 */
function cleanupCacheRegistry() {
  const MAX_ENTRIES = 1000;
  const TRIGGER_THRESHOLD = 1050;

  // 只有当 Map 大小超过触发阈值时，才进行清理，避免每次写入都执行昂贵的 Array.from
  if (cacheRegistry.size <= TRIGGER_THRESHOLD) {
    return;
  }

  const now = new Date();

  // 1. 清理已过期的缓存
  for (const [key, entry] of cacheRegistry.entries()) {
    if (entry.expireTime) {
      const expireDate = new Date(entry.expireTime);
      if (expireDate < now) {
        cacheRegistry.delete(key);
      }
    }
  }

  // 2. 如果大小仍然超过 MAX_ENTRIES，进行批量淘汰 (FIFO)
  if (cacheRegistry.size > MAX_ENTRIES) {
    const excessCount = cacheRegistry.size - MAX_ENTRIES;
    const keysIterator = cacheRegistry.keys();
    for (let i = 0; i < excessCount; i++) {
      const nextKey = keysIterator.next();
      if (nextKey.done) {
        break;
      }
      cacheRegistry.delete(nextKey.value);
    }
  }
}

/**
 * 确定性 JSON 序列化，对对象键进行排序，保证语义相同的对象生成 100% 相同的字符串
 */
function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj).sort();
  const parts = sortedKeys.map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  return '{' + parts.join(',') + '}';
}

/**
 * 计算输入内容列表的确定性 SHA-256 HASH，用于零时延缓存匹配
 */
function calculatePrefixHash(contents: any[], systemInstruction?: any): string {
  const hash = crypto.createHash('sha256');

  if (systemInstruction) {
    hash.update(stableStringify(systemInstruction));
  }

  hash.update(stableStringify(contents));
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
  requestId: string,
  targetModel: string
): Promise<any> {
  const model = targetModel || '';
  const modelLower = model.toLowerCase();

  // 0. 检查是否显式关闭了缓存，或者当前模型是否在运行时已被自动探测并标记为不支持缓存的 Free Tier 免费层级
  const config = getConfig();
  if (config.disable_context_cache || freeTierModels.has(modelLower)) {
    return geminiRequest;
  }

  const contents = geminiRequest.contents || [];
  const systemInstruction = geminiRequest.systemInstruction;

  // 1. Caching 条件前置校验
  // 只有 2.5/3.0 推理及主系列模型支持缓存，且一般只有当对话多于一轮时，对前 N-1 轮进行缓存才具有意义
  if (!modelLower.includes('gemini') || contents.length < 3) {
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
    let isExpired = false;
    if (entry.expireTime) {
      const expireDate = new Date(entry.expireTime);
      if (expireDate < new Date()) {
        isExpired = true;
        cacheRegistry.delete(prefixHash);
      }
    }

    // 检查缓存对应的模型是否相同且未过期
    if (!isExpired && entry.model === modelNamePath) {
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
    const cleanBaseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;

    let cacheModelPath = modelNamePath;
    if (cleanBaseUrl.includes('aiplatform.googleapis.com')) {
      // Vertex AI 专属缓存模型路径格式: publishers/google/models/{model}
      const cleanModelName = model.startsWith('models/') ? model.substring(7) : model;
      cacheModelPath = `publishers/google/models/${cleanModelName}`;
    }

    // 准备创建缓存的请求体
    const cacheRequestBody = {
      model: cacheModelPath,
      contents: cachePrefixContents,
      systemInstruction: systemInstruction,
      ttl: '1800s', // 默认生命周期 30 分钟
      displayName: `claude_code_session_${prefixHash.substring(0, 12)}`
    };

    // 构建创建缓存的官方端点 URL
    // 上游标准端点：https://generativelanguage.googleapis.com/v1beta/cachedContents?key=...
    // 或者是：${api_base_url}/v1beta/cachedContents?key=...
    let createUrl = '';
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (cleanBaseUrl.includes('aiplatform.googleapis.com')) {
      // Vertex AI 专属缓存端点解析
      // 格式: https://{location}-aiplatform.googleapis.com/{version}/projects/{project}/locations/{location}/publishers/google/models/
      const parts = cleanBaseUrl.split('/publishers/');
      createUrl = `${parts[0]}/cachedContents`;
      reqHeaders['Authorization'] = `Bearer ${apiKey}`;
    } else {
      // AI Studio 标准端点
      if (cleanBaseUrl.includes('v1beta')) {
        const parts = cleanBaseUrl.split('/v1beta');
        createUrl = `${parts[0]}/v1beta/cachedContents`;
      } else {
        createUrl = `${cleanBaseUrl}/cachedContents`;
      }
      reqHeaders['x-goog-api-key'] = apiKey;
    }

    const t0 = Date.now();
    const response = await fetch(createUrl, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(cacheRequestBody)
    });

    if (response.ok) {
      const data: any = await response.json();
      const cachedContentId = data.name; // 格式如: cachedContents/some_unique_id
      const expireTime = data.expireTime;
      const duration = Date.now() - t0;

      if (cachedContentId) {
        cleanupCacheRegistry();
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

      // 自动检测免费层级：如果状态码是 429 且错误信息表示免费层级超限（limit=0），或者 403 权限拒绝，自动在运行时禁用该模型的缓存以避免多余的网络消耗
      if (errText.includes('TotalCachedContentStorageTokensPerModelFreeTier') || errText.includes('limit=0') || response.status === 403) {
        logger.warn(`[CONTEXT_CACHE] 自动检测到当前模型及密钥属于免费层级 (Free Tier - 缓存存储配额为 0)，已在此运行时周期内静默屏蔽 [${modelLower}] 模型的 Context Caching 以避免多余的缓存请求。`, requestId);
        freeTierModels.add(modelLower);
      }
    }
  } catch (err: any) {
    // 缓存失败应该完全“降级退路”，不能阻断用户请求！继续使用原始未缓存请求完成服务
    logger.error(`[CONTEXT_CACHE_ERROR] 申请上游缓存时发生意外异常 (已平滑降级): ${err.message}`, requestId);
  }

  return geminiRequest;
}
