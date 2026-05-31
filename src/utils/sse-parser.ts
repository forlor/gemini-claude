import { logger } from './logger.js';

/**
 * 健壮的 SSE (Server-Sent Events) 字节流增量解析器
 * 
 * 将上游二进制字节流（Uint8Array ReadableStream）变换为按行、按事件拆分的原始 JSON 数据生成器。
 * 完美应对跨 chunk 拆分、合并接收、空行和首部干扰等边界问题。
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  requestId: string
): AsyncGenerator<any> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      // 将二进制数据解码并合并入缓冲区
      buffer += decoder.decode(value, { stream: true });

      // 按行切分，保留可能属于下一帧的未结束部分
      let lineIndex;
      while ((lineIndex = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.substring(0, lineIndex).trim();
        buffer = buffer.substring(lineIndex + 1);

        // 跳过空行或心跳注释行
        if (!rawLine || rawLine.startsWith(':')) {
          continue;
        }

        if (rawLine.startsWith('data:')) {
          const dataContent = rawLine.substring(5).trim();

          if (dataContent === '[DONE]') {
            logger.debug('[SSE_PARSER] 收到上游 [DONE] 结束标记', requestId);
            return;
          }

          try {
            const parsedJson = JSON.parse(dataContent);
            yield parsedJson;
          } catch (err: any) {
            logger.warn(`[SSE_PARSER_WARN] 无法解析 data 字段内的 JSON: ${dataContent.substring(0, 200)}. 错误: ${err.message}`, requestId);
          }
        }
      }
    }

    // 最后的扫尾解析（若缓冲区还残留了没有换行符的数据）
    const remaining = buffer.trim();
    if (remaining.startsWith('data:')) {
      const dataContent = remaining.substring(5).trim();
      if (dataContent !== '[DONE]') {
        try {
          const parsedJson = JSON.parse(dataContent);
          yield parsedJson;
        } catch (err) {
          // 忽略扫尾解析异常
        }
      }
    }
  } catch (err: any) {
    logger.error(`[SSE_PARSER_CRITICAL] 流读取或解析过程中遭遇致命异常: ${err.message}`, requestId);
    throw err;
  } finally {
    reader.releaseLock();
  }
}
