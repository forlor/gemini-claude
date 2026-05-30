import { logger } from '../../utils/logger.js';

export interface TruncationResult {
  messages: any[];
  prefillText: string;
}

/**
 * 从多轮对话历史中提取文本内容的辅助函数
 */
function extractTextFromContent(content: any): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(block => block && typeof block === 'object' && block.type === 'text')
      .map(block => block.text || '')
      .join('');
  }
  return '';
}

/**
 * 扫描消息队列尾部。若包含连续的助理/模型角色（assistant/model），自动裁剪剥离并提取预填文本。
 * 确保发送给不支持预填充（Pre-fill）的上游接口消息队列以 user 角色安全收尾。
 * 
 * @param messages 原始 Anthropic 消息列表
 * @returns 截断后的消息列表和提取出的预填文本
 */
export function truncateTrailingAssistant(messages: any[]): TruncationResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], prefillText: '' };
  }

  // 深度复制一份，防止修改外部入参引用
  const clonedMessages = [...messages];
  let prefillText = '';

  // 循环向上查找，剥离结尾的所有助理/模型消息
  while (clonedMessages.length > 0) {
    const lastMsg = clonedMessages[clonedMessages.length - 1];
    if (!lastMsg || typeof lastMsg !== 'object') {
      clonedMessages.pop();
      continue;
    }

    const role = (lastMsg.role || '').toLowerCase();
    if (role === 'assistant' || role === 'model') {
      const text = extractTextFromContent(lastMsg.content);
      if (text) {
        // 向上合并预填文本
        prefillText = prefillText ? text + prefillText : text;
      }
      clonedMessages.pop();
    } else {
      // 遇到第一个 user 或 system 消息，停止截断
      break;
    }
  }

  if (prefillText) {
    logger.debug(`[TRUNCATOR] 成功截断末尾助理消息并提取预填文本 (长度: ${prefillText.length} 字符)`);
  }

  return {
    messages: clonedMessages,
    prefillText
  };
}

/**
 * 将被裁剪剥离的预填文本优雅地回填至非流式响应的第一个内容块中
 */
export function injectPrefillToResponse(response: any, prefillText: string): any {
  if (!prefillText || !response) {
    return response;
  }

  // 情况 A：传入的本身就是 content 数组 (如 [ { type: "text", text: "..." } ])
  if (Array.isArray(response)) {
    const cloned = response.map(block => block ? { ...block } : block);
    const firstTextBlock = cloned.find(block => block && block.type === 'text');
    if (firstTextBlock) {
      firstTextBlock.text = prefillText + (firstTextBlock.text || '');
    } else {
      cloned.unshift({
        type: 'text',
        text: prefillText
      });
    }
    return cloned;
  }

  // 情况 B：传入的是完整的 Response 对象 (如 { content: [...] })
  const clonedResponse = { ...response };
  const content = clonedResponse.content;

  if (Array.isArray(content)) {
    const clonedContent = content.map(block => block ? { ...block } : block);
    const firstTextBlock = clonedContent.find(block => block && block.type === 'text');
    if (firstTextBlock) {
      firstTextBlock.text = prefillText + (firstTextBlock.text || '');
    } else {
      clonedContent.unshift({
        type: 'text',
        text: prefillText
      });
    }
    clonedResponse.content = clonedContent;
  } else if (typeof content === 'string') {
    clonedResponse.content = prefillText + content;
  } else {
    clonedResponse.content = [
      {
        type: 'text',
        text: prefillText
      }
    ];
  }

  return clonedResponse;
}
