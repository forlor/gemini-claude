import { logger } from '../../utils/logger.js';

/**
 * 在请求向 Gemini 转换时，注入标准的 Google Search Grounding 声明
 */
export function injectWebSearchTool(tools: any[] | undefined): any[] {
  const finalTools = Array.isArray(tools) ? [...tools] : [];
  
  // 检查是否已经存在 Google 搜索工具，避免重复添加
  const hasSearch = finalTools.some(t => t && (t.googleSearch || t.googleSearchRetrieval));
  if (!hasSearch) {
    finalTools.push({ googleSearch: {} });
    logger.debug('[WEB_SEARCH] 已向上游 tools 中成功注入 Google Search Grounding 工具');
  }
  
  return finalTools;
}

/**
 * 高保真解析上游返回的 Grounding 检索元数据，并格式化为 markdown 块拼接于助理输出的最末尾
 * 
 * @param text 原始助理回复文本
 * @param groundingMetadata 上游返回的 groundingMetadata 字段
 * @returns 附加了网页检索引用源的最终文本
 */
export function appendSearchCitations(text: string, groundingMetadata: any): string {
  if (!groundingMetadata || typeof groundingMetadata !== 'object') {
    return text;
  }

  const queries: string[] = groundingMetadata.webSearchQueries || [];
  const chunks: any[] = groundingMetadata.groundingChunks || [];

  if (queries.length === 0 && chunks.length === 0) {
    return text;
  }

  let citationMarkdown = '\n\n---\n> 🌐 **Google Search Grounding:**';

  // 1. 拼接搜索关键词
  if (queries.length > 0) {
    const formattedQueries = queries.map(q => `*"${q}"*`).join(', ');
    citationMarkdown += `\n> - **Queries Conducted:** ${formattedQueries}`;
  }

  // 2. 拼接引用文献源
  if (chunks.length > 0) {
    citationMarkdown += '\n> - **Sources Referenced:**';
    
    // 过滤并过滤出合法的 web 源
    let sourceIndex = 1;
    for (const chunk of chunks) {
      if (chunk && chunk.web && typeof chunk.web === 'object') {
        const title = chunk.web.title || 'Source Link';
        const uri = chunk.web.uri || '#';
        citationMarkdown += `\n>   ${sourceIndex}. [[${sourceIndex}] ${title}](${uri})`;
        sourceIndex++;
      }
    }
  }

  return text + citationMarkdown;
}
