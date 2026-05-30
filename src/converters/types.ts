/**
 * 协议转换器统一接口声明
 */
export interface IConverter {
  /**
   * 转换请求体：将标准的 Anthropic 请求转换为目标协议的请求
   * 
   * @param request 客户端原始 Anthropic 请求
   * @param targetModel 转换的目标模型
   * @param options 转换附加参数（如 apiKey、apiBaseUrl、Thinking 深度与预算、特定接口微调等）
   */
  convertRequest(
    request: any,
    targetModel: string,
    options?: Record<string, any>
  ): Promise<any>;

  /**
   * 转换非流式响应
   * 
   * @param response 目标 upstream 返回的响应体
   * @param targetModel 转换的目标模型
   * @param options 额外控制参数
   */
  convertResponse(
    response: any,
    targetModel: string,
    options?: Record<string, any>
  ): Promise<any>;

  /**
   * 转换流式响应：将上游的 Stream 变换为标准的 Anthropic SSE 事件流
   * 
   * @param upstreamStream 上游返回的原始 SSE 流或 Byte 流
   * @param targetModel 转换的目标模型
   * @param options 额外控制参数
   */
  convertStream(
    upstreamStream: ReadableStream<Uint8Array>,
    targetModel: string,
    options?: Record<string, any>
  ): ReadableStream<Uint8Array>;

  /**
   * 转换错误信息：将上游的异常统一映射为标准的 Anthropic Error 结构
   */
  convertError(error: any): any;
}
