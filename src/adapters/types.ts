export interface AdapterResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

export interface IAdapter {
  name: string;
  type: 'gemini' | 'vertex-gemini' | 'openai' | 'anthropic';

  /**
   * 执行非流式调用
   * @param payload 转换后的请求体
   * @param headers 额外请求头
   */
  execute(
    payload: any,
    headers?: Record<string, string>
  ): Promise<AdapterResponse>;

  /**
   * 执行流式调用
   * @param payload 转换后的请求体
   * @param headers 额外请求头
   */
  executeStream(
    payload: any,
    headers?: Record<string, string>
  ): Promise<ReadableStream<Uint8Array>>;
}
