import { estimateRequestTokens } from '../utils/token-counter.js';
import { RouterConfig } from '../config.js';

export interface RequestFeatures {
  hasWebSearch: boolean;
  hasThinking: boolean;
  isLongContext: boolean;
  estimatedTokens: number;
}

/**
 * 规则探测器（Rule Detector）：提取请求特征
 */
export function detectRequestFeatures(
  request: any,
  routerConfig: RouterConfig
): RequestFeatures {
  const estimatedTokens = estimateRequestTokens(request);

  // 1. 探测 Web Search 需求
  let hasWebSearch = false;
  
  // 检查模型后缀是否携带 -search
  if (typeof request.model === 'string' && request.model.toLowerCase().endsWith('-search')) {
    hasWebSearch = true;
  }

  // 检查 Tools 定义中是否含有 web_search 相关的自定义工具
  if (Array.isArray(request.tools)) {
    for (const tool of request.tools) {
      if (tool?.name === 'web_search' || tool?.name === 'google_search') {
        hasWebSearch = true;
        break;
      }
    }
  }

  // 2. 探测 Thinking 深度思维需求
  let hasThinking = false;
  if (request.thinking && typeof request.thinking === 'object') {
    if (request.thinking.type === 'enabled') {
      hasThinking = true;
    }
  }

  // 3. 探测 Long Context 需求
  const threshold = routerConfig.longContextThreshold || 60000;
  const isLongContext = estimatedTokens >= threshold;

  return {
    hasWebSearch,
    hasThinking,
    isLongContext,
    estimatedTokens
  };
}
