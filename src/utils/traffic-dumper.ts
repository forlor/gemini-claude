import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * 流量转储辅助类：在 DUMP_RAW_TRAFFIC=true 模式下将微观传输细节写入离线本地文件
 */
export function dumpRawTraffic(requestId: string, filename: string, content: any): void {
  // 只在明确指定开启流量转储时工作
  if (process.env.DUMP_RAW_TRAFFIC !== 'true') {
    return;
  }

  try {
    const dumpDir = path.join(process.cwd(), '.gemini-gateway', 'dumps', `req_${requestId}`);
    
    if (!fs.existsSync(dumpDir)) {
      fs.mkdirSync(dumpDir, { recursive: true });
    }

    const filePath = path.join(dumpDir, filename);
    let finalContent = '';

    if (typeof content === 'string') {
      finalContent = content;
    } else if (content instanceof Uint8Array || Buffer.isBuffer(content)) {
      finalContent = new TextDecoder().decode(content);
    } else {
      finalContent = JSON.stringify(content, null, 2);
    }

    // 异步写入以防止阻塞事件循环
    fs.promises.writeFile(filePath, finalContent, 'utf8')
      .then(() => {
        logger.debug(`[DUMP_TRAFFIC] 成功转储流量至: .gemini-gateway/dumps/req_${requestId}/${filename}`, requestId);
      })
      .catch((err) => {
        logger.error(`[DUMP_TRAFFIC_ERROR] 无法写入流量转储文件: ${err.message}`, requestId);
      });
  } catch (err: any) {
    logger.error(`[DUMP_TRAFFIC_ERROR] 创建流量转储目录或准备内容时异常: ${err.message}`, requestId);
  }
}
