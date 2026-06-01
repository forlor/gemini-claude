import { logger } from '../../utils/logger.js';

/**
 * 将 Anthropic 格式的多模态块（image 或 document）转换为 Gemini 原生 inlineData part
 * 
 * @param block Anthropic 格式的内容块对象
 * @returns 转换后的 Gemini inlineData Part，若不符合格式则返回 null
 */
export function convertMultimodalBlock(block: any): any {
  if (!block || typeof block !== 'object') {
    return null;
  }

  const blockType = block.type;
  
  // 仅处理 image 或 document 类型的多模态块
  if (blockType !== 'image' && blockType !== 'document') {
    return null;
  }

  const source = block.source;
  if (!source || typeof source !== 'object' || source.type !== 'base64') {
    return null;
  }

  let mimeType = (source.media_type || '').toLowerCase();
  let data = source.data || '';

  // 1. 如果是图片类型但未指定 mimeType，默认指定为 image/png
  if (blockType === 'image' && !mimeType) {
    mimeType = 'image/png';
  }

  // 2. 如果是文档类型，通常如 application/pdf，默认兜底指定
  if (blockType === 'document' && !mimeType) {
    mimeType = 'application/pdf';
  }

  // 3. 处理 base64 数据的头部干扰（例如 data:image/png;base64,...）
  if (data.includes(';base64,')) {
    const parts = data.split(';base64,');
    data = parts[1] || '';
    if (!mimeType) {
      const mimePart = parts[0].split('data:');
      mimeType = mimePart[1] || '';
    }
  }

  if (!data) {
    logger.warn(`[MULTIMODAL] 检测到空的 base64 多模态数据: ${blockType}`);
    return null;
  }

  logger.debug(`[MULTIMODAL] 成功转换全模态数据. 类型: ${blockType}, mimeType: ${mimeType}, 字节数: ${data.length}`);

  return {
    inlineData: {
      mimeType,
      data
    }
  };
}
