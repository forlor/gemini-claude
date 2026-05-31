/**
 * 高性能本地启发式 Token 估算器
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;

  // 1. 匹配 CJK 字符 (中日韩文字)
  const cjkReg = /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff]/g;
  const cjkMatches = text.match(cjkReg);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // 2. 移除 CJK 字符后，对剩余的英文、数字、空格和符号进行分词估算
  const nonCjkText = text.replace(cjkReg, ' ');
  const words = nonCjkText.trim().split(/\s+/).filter(Boolean);

  // 每个中文字符通常占用 1.5 - 2 个 Token (以 LLM 分词器为准)
  tokens += cjkCount * 1.6;

  for (const word of words) {
    if (word.length > 12) {
      // 极长的代码标识符或 URL，通常会被切分成较小的 token
      tokens += Math.ceil(word.length / 3.5);
    } else {
      // 普通英文单词平均 1.3 个 Token
      tokens += 1.3;
    }
  }

  // 3. 对特殊代码符号（大括号、小括号、逻辑运算符等）进行微调
  const symbols = text.match(/[{}[\]()<>|&+=*%/\\~^#@$-;:,._?]/g);
  const symbolCount = symbols ? symbols.length : 0;
  tokens += symbolCount * 0.7;

  return Math.ceil(tokens);
}

/**
 * 估算整个 Anthropic 请求消息体的 Token 数量
 */
export function estimateRequestTokens(request: any): number {
  if (!request) return 0;
  let totalText = '';
  let multimodalTokens = 0;

  // 1. 累加 System Prompt
  if (request.system) {
    if (typeof request.system === 'string') {
      totalText += request.system;
    } else if (Array.isArray(request.system)) {
      for (const block of request.system) {
        if (typeof block === 'string') {
          totalText += block;
        } else if (block?.text) {
          totalText += block.text;
        }
      }
    }
  }

  // 2. 累加 Messages 内容
  if (Array.isArray(request.messages)) {
    for (const msg of request.messages) {
      if (typeof msg.content === 'string') {
        totalText += msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.type === 'text') {
            totalText += part.text || '';
          } else if (part?.type === 'image') {
            multimodalTokens += 258; // 每一张图片估算为 258 个 Token
          } else if (part?.type === 'document') {
            multimodalTokens += 500; // 每一个文档块估算为 500 个 Token
          } else if (part?.type === 'tool_result' && typeof part.content === 'string') {
            totalText += part.content;
          } else if (part?.type === 'tool_result' && Array.isArray(part.content)) {
            for (const sub of part.content) {
              if (sub?.type === 'text') {
                totalText += sub.text || '';
              } else if (sub?.type === 'image') {
                multimodalTokens += 258;
              } else if (sub?.type === 'document') {
                multimodalTokens += 500;
              }
            }
          }
        }
      }
    }
  }

  // 3. 累加 Tools 定义的字符，以增加精确度
  if (Array.isArray(request.tools)) {
    totalText += JSON.stringify(request.tools);
  }

  return estimateTokens(totalText) + multimodalTokens;
}
