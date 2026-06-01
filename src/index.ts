import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { loadConfig, getConfig } from './config.js';
import {
  requestIdMiddleware,
  auditLoggerMiddleware,
  errorHandlerMiddleware,
  HonoEnv
} from './utils/middleware.js';
import { RouterEngine } from './router/engine.js';
import { estimateRequestTokens } from './utils/token-counter.js';
import { logger } from './utils/logger.js';

// 1. 初始化并加载全局配置
const config = loadConfig();
logger.info(`[SYSTEM] 配置初始化完成. 服务运行端口: ${config.PORT}, 日志级别: ${config.LOG_LEVEL}`);

// 2. 实例化智能路由引擎
const routerEngine = new RouterEngine(config);

// 3. 构建 Hono 服务实例
const app = new Hono<HonoEnv>();

// 4. 全局中间件链注册
app.use('*', cors());
app.use('*', requestIdMiddleware());
app.use('*', errorHandlerMiddleware());
app.use('*', auditLoggerMiddleware());

/**
 * 身份鉴权拦截器 (如果配置了全局 APIKEY)
 */
const authMiddleware = async (c: any, next: any) => {
  const cfg = getConfig();
  if (cfg.APIKEY) {
    const clientKey = c.req.header('x-api-key') || c.req.header('Authorization')?.replace('Bearer ', '');
    if (clientKey !== cfg.APIKEY) {
      logger.warn(`[AUTH_ERROR] 客户端鉴权失败. 头部未匹配或 key 不正确.`);
      return c.json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Invalid Gateway API Key'
        }
      }, 401);
    }
  }
  await next();
};

/**
 * 路由：基础运行健康探测
 */
app.get('/', (c) => c.text('Gemini-to-Claude-Code Gateway is running beautifully!'));
app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

/**
 * 路由：Anthropic 协议聊天对话主体端点 (Task 5.3 & Task 6)
 */
app.post('/v1/messages', authMiddleware, async (c) => {
  const requestId = c.get('requestId') || 'unknown';
  const body = await c.req.json();

  // 1. 抓取与格式化客户端所有的 Headers
  const rawHeaders: Record<string, string> = {};
  c.req.raw.headers.forEach((v: string, k: string) => {
    rawHeaders[k] = v;
  });

  const isStream = !!body.stream;
  logger.info(`[SERVER] 收到对话请求. 模式: ${isStream ? 'STREAM' : 'NON-STREAM'}. 目标模型: ${body.model}`, requestId);

  if (isStream) {
    // 2. 执行流式调用与故障转移
    const convertedStream = await routerEngine.executeRequestWithFallback(body, rawHeaders, true, requestId);
    
    // 设置流式响应头，绕过 Hono 默认缓冲，直接字节传输
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no'); // 优化 Nginx 代理下的流传输

    return c.body(convertedStream);
  } else {
    // 3. 执行非流式调用与故障转移
    const convertedResponse = await routerEngine.executeRequestWithFallback(body, rawHeaders, false, requestId);
    return c.json(convertedResponse);
  }
});

/**
 * 路由：高性能本地 Token 计数与估算端点 (Task 5.4)
 */
app.post('/v1/messages/count_tokens', authMiddleware, async (c) => {
  const body = await c.req.json();
  const estimatedCount = estimateRequestTokens(body);
  
  return c.json({
    input_tokens: estimatedCount
  });
});

// 5. 启动 Node HTTP 服务器监听
const host = process.env.HOST || '0.0.0.0';
serve({
  fetch: app.fetch,
  port: config.PORT,
  hostname: host
}, (info) => {
  const displayHost = info.address === '0.0.0.0' || info.address === '::' ? 'localhost' : info.address;
  logger.info(`[SYSTEM] Gateway 成功启动并开始监听: http://${displayHost}:${info.port}`);
});
export default app;
