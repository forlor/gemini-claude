import { logger } from '../../utils/logger.js';

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args: Record<string, any> };
  functionResponse?: { id?: string; name: string; response: Record<string, any> };
  thoughtSignature_val?: string;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * 清洗并净化单个 Part：剔除空值、格式异常的数据
 */
export function cleanPart(part: any): GeminiPart | null {
  if (!part || typeof part !== 'object') {
    return null;
  }

  const result: Record<string, any> = {};

  // 1. 清理 text 字段，若是列表形式，合并为 string；去除无意义的纯空白
  if ('text' in part) {
    let txt = part.text;
    if (Array.isArray(txt)) {
      txt = txt.filter(t => t).join(' ');
    }
    if (txt === null || txt === undefined) {
      return null;
    }
    const finalTxt = String(txt);
    if (!finalTxt.trim()) {
      return null;
    }
    // 允许普通文本或特定占位符文本
    result.text = finalTxt;
  }

  // 2. 净化 inlineData
  if (part.inlineData && typeof part.inlineData === 'object') {
    const mimeType = part.inlineData.mimeType;
    const data = part.inlineData.data;
    if (mimeType && data) {
      result.inlineData = { mimeType, data };
    }
  }

  // 3. 净化 functionCall
  if (part.functionCall && typeof part.functionCall === 'object') {
    const fc = part.functionCall;
    if (fc.name) {
      result.functionCall = {
        id: fc.id,
        name: fc.name,
        args: fc.args || {}
      };
    }
  }

  // 4. 净化 functionResponse
  if (part.functionResponse && typeof part.functionResponse === 'object') {
    const fr = part.functionResponse;
    if (fr.name) {
      result.functionResponse = {
        id: fr.id,
        name: fr.name,
        response: fr.response || {}
      };
    }
  }

  // 5. 保留 thought 标记及签名
  if (part.thought) {
    result.thought = true;
  }
  if (part.thoughtSignature) {
    result.thoughtSignature = part.thoughtSignature;
  }

  // 如果没有任何有效的内容键，判定为无效 part 并抛弃
  const keys = Object.keys(result);
  if (keys.length === 0 || (keys.length === 1 && 'thought' in result)) {
    return null;
  }

  return result as GeminiPart;
}

/**
 * 递归合并同一角色连续发送的消息内容。
 * 同时清洗所有 Parts，剔除冗余节点。
 */
export function mergeSameRoleMessages(contents: GeminiContent[]): GeminiContent[] {
  if (!Array.isArray(contents) || contents.length === 0) {
    return [];
  }

  const merged: GeminiContent[] = [];

  for (const item of contents) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.parts)) {
      continue;
    }

    const role = item.role === 'model' ? 'model' : 'user';
    const cleanedParts = item.parts
      .map(p => cleanPart(p))
      .filter((p): p is GeminiPart => p !== null);

    if (cleanedParts.length === 0) {
      continue;
    }

    const lastMerged = merged[merged.length - 1];
    if (lastMerged && lastMerged.role === role) {
      // 角色相同，合并 Parts
      for (const part of cleanedParts) {
        const lastPart = lastMerged.parts[lastMerged.parts.length - 1];
        if (lastPart && 'text' in lastPart && 'text' in part && (!!lastPart.thought === !!part.thought)) {
          // 如果连续两个 part 都是相同属性的文本/思考块，合并为一个，避免冗余
          lastPart.text = (lastPart.text || '') + '\n' + (part.text || '');
        } else {
          lastMerged.parts.push(part);
        }
      }
    } else {
      // 创建新条目，但内部也需要合并连续的文本 part
      const finalParts: GeminiPart[] = [];
      for (const part of cleanedParts) {
        const lastPart = finalParts[finalParts.length - 1];
        if (lastPart && 'text' in lastPart && 'text' in part && (!!lastPart.thought === !!part.thought)) {
          lastPart.text = (lastPart.text || '') + '\n' + (part.text || '');
        } else {
          finalParts.push(part);
        }
      }
      merged.push({
        role,
        parts: finalParts
      });
    }
  }

  return merged;
}

/**
 * 完美交替重排算法：对 contents 中并行的工具调用进行拆分和排列对齐，满足严格的交替对话规则。
 * 
 * 将类似以下的结构：
 * model -> parts: [fc1, fc2]
 * user  -> parts: [fr1, fr2]
 * 
 * 转换为符合上游严格校验的：
 * model -> parts: [fc1]
 * user  -> parts: [fr1]
 * model -> parts: [fc2]
 * user  -> parts: [fr2]
 * 
 * @param contents 经 mergeSameRoleMessages 合并清洗后的内容列表
 */
export function reorganizeToolMessages(contents: GeminiContent[]): GeminiContent[] {
  if (!Array.isArray(contents) || contents.length === 0) {
    return [];
  }

  // 1. 首先提取所有的 functionResponse，并以工具 ID (id) 为 Key 存储，用于后续快速定位和匹配
  const toolResults: Record<string, GeminiPart[]> = {};
  for (const content of contents) {
    for (const part of content.parts) {
      if (part && part.functionResponse) {
        const toolId = part.functionResponse.id;
        if (toolId) {
          const idStr = String(toolId);
          if (!toolResults[idStr]) {
            toolResults[idStr] = [];
          }
          toolResults[idStr].push(part);
        }
      }
    }
  }

  // 2. 将所有的消息打碎为单一 Part 组成的独立内容片段
  const flattened: GeminiContent[] = [];
  for (const content of contents) {
    const role = content.role;
    for (const part of content.parts) {
      flattened.push({
        role,
        parts: [part]
      });
    }
  }

  // 3. 按交替对话机制重组
  const reorganized: GeminiContent[] = [];
  const usedToolResponseParts = new Set<GeminiPart>();
  let i = 0;

  while (i < len(flattened)) {
    const current = flattened[i];
    const part = current.parts[0];

    // 如果是单个 functionResponse，且在前面已经和其对应的 functionCall 成对匹配并写入过，则跳过
    if (part && part.functionResponse) {
      if (usedToolResponseParts.has(part)) {
        i++;
        continue;
      }
      // 如果没有被成对写入过，说明这是一个孤立的或无 ID 的工具结果，我们将其作为普通消息保留并原样写入，绝不丢弃！
      reorganized.push(current);
      i++;
      continue;
    }

    // 如果是 functionCall，强行将其 and 对应的 functionResponse 组织成一个紧密交替对
    if (part && part.functionCall) {
      const toolId = part.functionCall.id;

      // 写入当前 functionCall (model 角色)
      reorganized.push({
        role: 'model',
        parts: [part]
      });

      // 紧接着寻找并写入对应的 functionResponse (user 角色)
      if (toolId !== undefined && toolId !== null && toolResults[String(toolId)]) {
        const matchedResponses = toolResults[String(toolId)];
        for (const matchedResponse of matchedResponses) {
          reorganized.push({
            role: 'user',
            parts: [matchedResponse]
          });
          usedToolResponseParts.add(matchedResponse);
        }
      } else {
        logger.warn(`[REORGANIZER] 未能在上下文中找到 tool_use_id 为 '${toolId}' 的工具执行结果! 正在自动合成虚拟执行结果以防止 Gemini 返回 400 INVALID_ARGUMENT 报错`, 'role-reorganizer');
        reorganized.push({
          role: 'user',
          parts: [{
            functionResponse: {
              id: toolId,
              name: part.functionCall.name,
              response: {
                output: 'Error: Tool execution was aborted, cancelled, or interrupted.'
              }
            }
          }]
        });
      }

      i++;
      continue;
    }

    // 普通文本或多模态消息，直接原样写入
    reorganized.push(current);
    i++;
  }

  const finalMerged = mergeSameRoleMessages(reorganized);

  // 4. 递归剥离所有非标准的 id 字段，确保完全符合 Gemini 官方 API 规范，防止 Vertex AI 返回 400 错误
  for (const content of finalMerged) {
    for (const part of content.parts) {
      if (part.functionCall) {
        delete (part.functionCall as any).id;
      }
      if (part.functionResponse) {
        delete (part.functionResponse as any).id;
      }
    }
  }

  return finalMerged;
}

// 辅助：TS 环境下的长度获取
function len(arr: any[]): number {
  return arr.length;
}
