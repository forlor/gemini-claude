import { MiddlewareHandler } from 'hono';
import { logger } from './logger.js';

export interface HonoEnv {
  Variables: {
    requestId: string;
  };
}

/**
 * 自动注入唯一且高辨识度的 Request ID 中间件
 */
export function requestIdMiddleware(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const randomPart = Math.random().toString(36).substring(2, 10);
    const timePart = Date.now().toString().substring(8);
    const requestId = `req_${randomPart}_${timePart}`;
    
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    
    await next();
  };
}

/**
 * 链路请求生命周期审计日志中间件 (包含耗时审计)
 */
export function auditLoggerMiddleware(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const requestId = c.get('requestId') || 'unknown';
    const method = c.req.method;
    const path = c.req.path;
    
    logger.info(`--> ${method} ${path}`, requestId);
    const startTime = Date.now();
    
    await next();
    
    const duration = Date.now() - startTime;
    const status = c.res.status;
    
    logger.info(`<-- ${status} ${method} ${path} - ${duration}ms`, requestId);
  };
}

/**
 * 全局错误转译与安全防护中间件 (保障对 Claude Code 始终输出标准的 Anthropic Error 结构)
 */
export function errorHandlerMiddleware(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const requestId = c.get('requestId') || 'unknown';
    try {
      await next();
      
      // 如果 Hono 内部在没有抛异常的情况下产生了非 2xx/3xx 的错误 (如内置 404)
      if (c.res.status >= 400 && c.res.status < 600) {
        const contentType = c.res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          // 将非 JSON 的错误重置为标准的 Anthropic 异常 JSON 结构
          const status = c.res.status;
          let errType = 'api_error';
          if (status === 404) errType = 'not_found_error';
          else if (status === 401 || status === 403) errType = 'authentication_error';
          else if (status === 429) errType = 'rate_limit_error';
          else if (status === 503 || status === 529) errType = 'overloaded_error';
          else if (status === 400) errType = 'invalid_request_error';

          c.res = c.json({
            type: 'error',
            error: {
              type: errType,
              message: `Gateway HTTP Error: ${status}`
            }
          }, status as any);
        }
      }
    } catch (err: any) {
      logger.error(`[CRITICAL_UNCAUGHT] 未捕获异常: ${err.message}. 堆栈:\n${err.stack}`, requestId);

      let status = 500;
      let errType = 'api_error';
      const message = err.message || '';

      // 尝试从错误消息中提取状态码，例如 "Upstream request error (503)" 或 "status 503"
      const statusMatch = message.match(/\((\d{3})\)/) || message.match(/status\s+(\d{3})/i);
      if (statusMatch) {
        const parsedStatus = parseInt(statusMatch[1], 10);
        const validStatuses = [400, 401, 402, 403, 404, 405, 406, 408, 409, 410, 412, 413, 415, 416, 422, 429, 500, 501, 502, 503, 504, 507, 529];
        if (validStatuses.includes(parsedStatus)) {
          status = parsedStatus;
        }
      }

      if (status === 429) {
        errType = 'rate_limit_error';
      } else if (status === 503 || status === 529) {
        errType = 'overloaded_error';
      } else if (status === 401 || status === 403) {
        errType = 'authentication_error';
      } else if (status === 400) {
        errType = 'invalid_request_error';
      } else if (status === 404) {
        errType = 'not_found_error';
      }

      // 捕获所有运行时崩溃并将其转译为符合 Anthropic 协议规范的错误返回，确保 Claude 不崩溃
      c.res = c.json({
        type: 'error',
        error: {
          type: errType,
          message: `Internal Gateway Exception: ${err.message}`
        }
      }, status as any);
    }
  };
}
