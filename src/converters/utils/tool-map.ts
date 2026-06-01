import { logger } from '../../utils/logger.js';

const SEPARATOR_THOUGHT = '__thought__';
const SEPARATOR_NAME = '__name__';

// 内存双轨防御映射表，限额 10000 避免溢出
const fallbackMap = new Map<string, { originalId: string; signature?: string; name: string }>();
const MAX_FALLBACK_ENTRIES = 10000;

/**
 * 编码工具调用 ID，支持 Inline 无状态轨道和 In-Memory Fallback 轨道
 * 
 * @param toolId 原始工具调用 ID (例如: toolu_01ABC)
 * @param signature 思考过程签名 thoughtSignature
 * @param funcName 工具/函数名称 name
 * @param useFallbackMap 是否强行启用内存防御映射（适用于对 ID 字符集有正则限制的上游，如 Vertex AI）
 * @returns 编码后的安全工具 ID
 */
export function encodeToolId(
  toolId: string,
  signature: string | undefined,
  funcName: string,
  useFallbackMap = false
): string {
  if (!useFallbackMap) {
    // 1. 无状态 Inline 轨道：将 signature 和 funcName 直接编码进 ID 中
    let encoded = toolId;
    if (signature) {
      encoded += `${SEPARATOR_THOUGHT}${signature}`;
    }
    encoded += `${SEPARATOR_NAME}${funcName}`;
    return encoded;
  }

  // 2. In-Memory Fallback 轨道：生成纯净字母数字的临时 ID 并存入映射表
  const randPart = Math.random().toString(36).substring(2, 10).toUpperCase();
  const cleanId = `toolu_vertex_${Date.now().toString().substring(9)}_${randPart}`;

  if (fallbackMap.size >= MAX_FALLBACK_ENTRIES) {
    // 自动滑动窗口清理旧条目
    const firstKey = fallbackMap.keys().next().value;
    if (firstKey) fallbackMap.delete(firstKey);
  }

  fallbackMap.set(cleanId, {
    originalId: toolId,
    signature,
    name: funcName
  });

  logger.debug(`[TOOL_MAP] 启用 Vertex 防御轨道. 映射: ${cleanId} -> { originalId: ${toolId}, name: ${funcName} }`);
  return cleanId;
}

/**
 * 解码工具 ID，自动检测来源轨道，无损提取原始工具 ID、思考签名和函数名称
 * 
 * @param encodedId 客户端传回的工具 ID
 * @returns 解码结果对象
 */
export function decodeToolId(encodedId: any): { originalId: string; signature?: string; name?: string } {
  if (encodedId === undefined || encodedId === null) {
    return { originalId: '' };
  }

  const idStr = String(encodedId);

  // 1. 优先检测是否属于 In-Memory Fallback 轨道的 ID
  if (fallbackMap.has(idStr)) {
    const entry = fallbackMap.get(idStr)!;
    return {
      originalId: entry.originalId,
      signature: entry.signature,
      name: entry.name
    };
  }

  // 2. 属于 Inline 轨道，进行正则/字符串解析
  let originalId = idStr;
  let signature: string | undefined;
  let name: string | undefined;

  // 解析 Name
  if (idStr.includes(SEPARATOR_NAME)) {
    const parts = idStr.split(SEPARATOR_NAME, 2);
    originalId = parts[0];
    name = parts[1];
  }

  // 解析 Signature
  if (originalId.includes(SEPARATOR_THOUGHT)) {
    const parts = originalId.split(SEPARATOR_THOUGHT, 2);
    originalId = parts[0];
    signature = parts[1];
  }

  return {
    originalId,
    signature,
    name
  };
}

/**
 * 辅助：从历史 messages 中提取 tool_use_id 到 function_name 的映射，确保 100% 还原。
 * 这是一个强鲁棒的双保险层。
 * 
 * @param messages 历史消息列表
 * @returns tool_use_id 到 function_name 的映射表
 */
export function buildHistoricalToolMap(messages: any[]): Record<string, string> {
  const toolMap: Record<string, string> = {};
  if (!Array.isArray(messages)) {
    return toolMap;
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = msg.content;
    
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && block.type === 'tool_use') {
          const id = String(block.id);
          const name = String(block.name);
          if (id && name) {
            toolMap[id] = name;
            // 同时也对解码后的原始 ID 建立映射，提供多重冗余保护
            const decoded = decodeToolId(id);
            toolMap[decoded.originalId] = name;
          }
        }
      }
    }
  }

  return toolMap;
}
