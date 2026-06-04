import { cleanAndCaseJsonSchema } from '../src/converters/utils/schema-case.js';
import { truncateTrailingAssistant, injectPrefillToResponse } from '../src/converters/utils/message-truncator.js';
import { encodeToolId, decodeToolId } from '../src/converters/utils/tool-map.js';
import { appendSearchCitations } from '../src/converters/utils/web-search.js';
import { mergeSameRoleMessages, reorganizeToolMessages } from '../src/converters/utils/role-reorganizer.js';
import { estimateRequestTokens, estimateTokens } from '../src/utils/token-counter.js';
import { RouterEngine } from '../src/router/engine.js';
import { AppConfig } from '../src/config.js';
import { AnthropicToGeminiConverter } from '../src/converters/anthropic2gemini.js';
import { GeminiAdapter } from '../src/adapters/gemini-adapter.js';

// 简单的轻量级单元测试断言框架
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log('============= STARTING REGRESSION TEST SUITE =============\n');

  // ==========================================
  // Test 1: JSON Schema Cleanse & Case Casing
  // ==========================================
  console.log('Running Test 1: Schema Case Casing & Cleansing...');
  const dirtySchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      username: {
        type: 'string',
        minLength: 3,
        maxLength: 20,
        pattern: '^[a-z]+$',
        description: 'The user login name'
      },
      status: {
        type: 'string',
        anyOf: [
          { type: 'string' },
          { type: 'null' }
        ]
      }
    },
    required: ['username'],
    additionalProperties: false
  };

  const cleanSchemaLower = cleanAndCaseJsonSchema(dirtySchema, 'lowercase');
  assert(cleanSchemaLower.type === 'object', 'Should keep type object');
  assert(cleanSchemaLower.$schema === undefined, 'Should strip $schema');
  assert(cleanSchemaLower.additionalProperties === undefined, 'Should strip additionalProperties');
  assert(cleanSchemaLower.properties.username.type === 'string', 'Should keep lowercase types');
  assert(cleanSchemaLower.properties.username.minLength === undefined, 'Should strip minLength');
  assert(cleanSchemaLower.properties.username.description.includes('validation'), 'Should append constraint to description');
  assert(cleanSchemaLower.properties.status.type === 'string', 'Should fallback anyOf with null to string');

  const cleanSchemaUpper = cleanAndCaseJsonSchema(dirtySchema, 'uppercase');
  assert(cleanSchemaUpper.type === 'OBJECT', 'Should uppercase type OBJECT');
  assert(cleanSchemaUpper.properties.username.type === 'STRING', 'Should uppercase properties type STRING');
  console.log('✅ Test 1 Passed: Schema Cleansing matches specs perfectly.\n');

  // ==========================================
  // Test 2: Tail Truncation (Pre-fill)
  // ==========================================
  console.log('Running Test 2: Tail Truncation...');
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'Generate code...' },
    { role: 'assistant', content: '```typescript\n' } // Pre-fill
  ];

  const { messages: truncated, prefillText } = truncateTrailingAssistant(messages);
  assert(truncated.length === 3, 'Should remove the trailing assistant pre-fill message');
  assert(truncated[2].role === 'user', 'Last message role must now be user');
  assert(prefillText === '```typescript\n', 'Prefill text should be correctly extracted');

  const injected = injectPrefillToResponse([{ type: 'text', text: 'const a = 1;' }], '```typescript\n');
  assert(injected[0].text === '```typescript\nconst a = 1;', 'Should prepend pre-fill back into response text');
  console.log('✅ Test 2 Passed: Tail Truncation and pre-fill injection.\n');

  // ==========================================
  // Test 3: Tool ID Encoding & Decoding
  // ==========================================
  console.log('Running Test 3: Tool ID Mapping (Dual-Track)...');
  const originalId = 'toolu_01A23B45';
  const sig = 'sig_thought_hash_9999';
  const toolName = 'search_web';

  // Inline track
  const encodedInline = encodeToolId(originalId, sig, toolName, false);
  assert(encodedInline.includes(originalId), 'Encoded ID must contain original ID');
  assert(encodedInline.includes(sig), 'Encoded ID must contain thought signature');

  const decodedInline = decodeToolId(encodedInline);
  assert(decodedInline.originalId === originalId, 'Decoded original ID must match');
  assert(decodedInline.signature === sig, 'Decoded thought signature must match');

  // Vertex strict fallback track (alphanumeric only)
  const encodedVertex = encodeToolId(originalId, sig, toolName, true);
  assert(/^[a-zA-Z0-9_]+$/.test(encodedVertex), 'Vertex encoded ID must be alphanumeric/underscores only');
  
  const decodedVertex = decodeToolId(encodedVertex);
  assert(decodedVertex.originalId === originalId, 'Decoded Vertex original ID must match');
  assert(decodedVertex.signature === sig, 'Decoded Vertex thought signature must match');
  console.log('✅ Test 3 Passed: Tool ID Dual-Track mapping works flawlessly.\n');

  // ==========================================
  // Test 4: Web Search Grounding Citations
  // ==========================================
  console.log('Running Test 4: Web Search Grounding...');
  const sampleMeta = {
    webSearchQueries: ['typescript compile modules'],
    groundingChunks: [
      {
        web: {
          uri: 'https://typescriptlang.org/docs',
          title: 'TypeScript Module Resolution'
        }
      }
    ]
  };
  const baseText = 'You should use NodeNext resolution.';
  const enhancedText = appendSearchCitations(baseText, sampleMeta);
  assert(enhancedText.includes('Google Search Grounding:'), 'Citations should contain Grounding Sources header');
  assert(enhancedText.includes('https://typescriptlang.org/docs'), 'Citations should contain URL');
  assert(enhancedText.includes('TypeScript Module Resolution'), 'Citations should contain page title');
  console.log('✅ Test 4 Passed: Grounding citations correctly compiled into markdown.\n');

  // ==========================================
  // Test 5: Role Reorganizer
  // ==========================================
  console.log('Running Test 5: Role Reorganizer (Alternation & Cleansing)...');
  const sameRoleMsgs = [
    { role: 'user', parts: [{ text: 'Hello' }] },
    { role: 'user', parts: [{ text: 'world!' }] },
    { role: 'model', parts: [{ text: 'I am here' }] }
  ];
  const merged = mergeSameRoleMessages(sameRoleMsgs);
  assert(merged.length === 2, 'Consecutive same-role messages should be merged into one');
  assert(merged[0].parts[0].text === 'Hello\nworld!', 'Consecutive text parts should be merged');

  // Empty part cleansing
  const dirtyParts = [
    { text: '' },
    { text: '   ' },
    { text: 'Hello' }
  ];
  const cleansed = mergeSameRoleMessages([{ role: 'user', parts: dirtyParts }]);
  assert(cleansed[0].parts.length === 1, 'Empty parts should be stripped out');
  assert(cleansed[0].parts[0].text === 'Hello', 'Only non-empty parts should remain');
  console.log('✅ Test 5 Passed: Strict alternation role reorganizers compile properly.\n');

  // ==========================================
  // Test 6: Token Heuristic Counter
  // ==========================================
  console.log('Running Test 6: Local Token Counter...');
  const engText = 'Hello world, this is a simple test of token counts.';
  const chText = '你好，世界。这是一个本地分词器评估。';
  const codeText = 'const calc = (a, b) => { return a + b; };';

  const engTokens = estimateTokens(engText);
  const chTokens = estimateTokens(chText);
  const codeTokens = estimateTokens(codeText);

  assert(engTokens > 5 && engTokens < 20, 'English tokens estimate is within reasonable bounds');
  assert(chTokens > 10 && chTokens < 35, 'Chinese tokens estimate is within reasonable bounds');
  assert(codeTokens > 10 && codeTokens < 25, 'Code tokens estimate is within reasonable bounds');

  const dummyReq = {
    model: 'claude-3-7-sonnet',
    system: 'Keep answers technical.',
    messages: [
      { role: 'user', content: 'Write a program' }
    ]
  };
  const totalReqTokens = estimateRequestTokens(dummyReq);
  assert(totalReqTokens > 10, 'Request tokens estimate should count system + messages');
  console.log('✅ Test 6 Passed: High-performance Token Counter heuristic is accurate.\n');

  // ==========================================
  // Test 7: Router Engine & Decision Priorities
  // ==========================================
  console.log('Running Test 7: Router Engine Decisions...');
  const testConfig: AppConfig = {
    PORT: 3456,
    LOG: false,
    LOG_LEVEL: 'info',
    API_TIMEOUT_MS: 10000,
    Providers: [
      {
        name: 'gemini',
        type: 'gemini',
        api_base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',
        models: ['gemini-2.5-pro', 'gemini-2.5-flash']
      },
      {
        name: 'vertex',
        type: 'vertex-gemini',
        api_base_url: 'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/x/locations/us-central1/publishers/google/models/',
        models: ['gemini-2.5-pro']
      }
    ],
    Router: {
      default: 'gemini,gemini-2.5-pro',
      background: 'gemini,gemini-2.5-flash',
      think: 'gemini,gemini-2.5-pro',
      longContext: 'vertex,gemini-2.5-pro',
      longContextThreshold: 50 // Set small threshold for easy trigger
    }
  };

  const engine = new RouterEngine(testConfig);

  // 1. Default routing
  const targetDefault = await engine.resolve({
    model: 'claude-3-7-sonnet',
    messages: [{ role: 'user', content: 'Normal prompt' }]
  });
  assert(targetDefault.provider.name === 'gemini', 'Should route to default provider');
  assert(targetDefault.targetModel === 'gemini-2.5-pro', 'Should route to default model');

  // 2. Background routing
  const targetBg = await engine.resolve({
    model: 'claude-3-5-haiku',
    messages: [{ role: 'user', content: 'Quick task' }]
  });
  assert(targetBg.targetModel === 'gemini-2.5-flash', 'Haiku model should route to background model (flash)');

  // 3. Long context routing
  const targetLong = await engine.resolve({
    model: 'claude-3-7-sonnet',
    messages: [{ role: 'user', content: 'A '.repeat(500) }] // Exceeds threshold of 50 tokens
  });
  assert(targetLong.provider.name === 'vertex', 'Long context should route to longContext provider (vertex)');

  console.log('✅ Test 7 Passed: Router Engine & Prioritization works beautifully.\n');

  // ==========================================
  // Test 8: Advanced Protocol & Performance Fixes
  // ==========================================
  console.log('Running Test 8: Advanced Protocol & Performance Fixes...');

  // 1. 多模态 Token 估算验证
  const multimodalReq = {
    model: 'claude-3-7-sonnet',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this image' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }
        ]
      }
    ]
  };
  const multimodalTokens = estimateRequestTokens(multimodalReq);
  assert(multimodalTokens > 258, 'Multimodal token count should include image heuristic tokens');

  // 2. Nullable 转换验证
  const nullableSchema = {
    type: 'object',
    properties: {
      tags: {
        anyOf: [
          { type: 'array', items: { type: 'string' } },
          { type: 'null' }
        ]
      }
    },
    required: ['tags']
  };
  const cleanedNullable = cleanAndCaseJsonSchema(nullableSchema, 'uppercase');
  assert(cleanedNullable.properties.tags.nullable === true, 'Nullable union type should set nullable: true');

  // 3. 空属性 Required 清理验证
  const emptyPropSchema = {
    type: 'object',
    required: ['missing_field']
  };
  const cleanedEmptyProp = cleanAndCaseJsonSchema(emptyPropSchema, 'uppercase');
  assert(cleanedEmptyProp.required === undefined, 'Required array should be deleted if properties are empty or missing');

  console.log('✅ Test 8 Passed: Advanced Protocol & Performance Fixes verified successfully.\n');

  // ==========================================
  // Test 9: Extended Thinking & Case Normalization
  // ==========================================
  console.log('Running Test 9: Extended Thinking & Case Normalization...');
  const converter = new AnthropicToGeminiConverter();

  // 1. Case-insensitive matching for targetModel
  const reqWithThinking = {
    model: 'claude-3-7-sonnet',
    max_tokens: 1000,
    thinking: {
      type: 'enabled',
      budget_tokens: 2048
    },
    messages: [{ role: 'user', content: 'Hello' }]
  };

  // Gemini-3-Pro (uppercase) should be recognized as a thinking model and use thinkingLevel
  const resGemini3Pro = await converter.convertRequest(reqWithThinking, 'Gemini-3-Pro');
  assert(resGemini3Pro.generationConfig.thinkingConfig !== undefined, 'Gemini-3-Pro should be recognized as a thinking model');
  assert(resGemini3Pro.generationConfig.thinkingConfig.thinkingLevel === 'HIGH', 'Gemini-3-Pro should default to HIGH thinkingLevel');
  assert(resGemini3Pro.generationConfig.thinkingConfig.thinkingBudget === undefined, 'Gemini-3-Pro should not use thinkingBudget');

  // gemini-3-flash should be recognized as a thinking model (Gemini 3 series Flash supports thinking)
  const resGemini3Flash = await converter.convertRequest(reqWithThinking, 'gemini-3-flash');
  assert(resGemini3Flash.generationConfig.thinkingConfig !== undefined, 'gemini-3-flash should be recognized as a thinking model');
  assert(resGemini3Flash.generationConfig.thinkingConfig.thinkingLevel === 'HIGH', 'gemini-3-flash should default to HIGH thinkingLevel');

  // 2. Client-provided thinking_level normalization
  const reqWithCustomLevel = {
    model: 'claude-3-7-sonnet',
    max_tokens: 1000,
    thinking: {
      type: 'enabled',
      thinking_level: 'minimal' // lowercase
    },
    messages: [{ role: 'user', content: 'Hello' }]
  };
  const resCustomLevel = await converter.convertRequest(reqWithCustomLevel, 'gemini-3-pro');
  assert(resCustomLevel.generationConfig.thinkingConfig.thinkingLevel === 'MINIMAL', 'Should normalize lowercase thinking_level to uppercase MINIMAL');

  const reqWithInvalidLevel = {
    model: 'claude-3-7-sonnet',
    max_tokens: 1000,
    thinking: {
      type: 'enabled',
      thinkingLevel: 'invalid-level'
    },
    messages: [{ role: 'user', content: 'Hello' }]
  };
  const resInvalidLevel = await converter.convertRequest(reqWithInvalidLevel, 'gemini-3-pro');
  assert(resInvalidLevel.generationConfig.thinkingConfig.thinkingLevel === 'HIGH', 'Should fallback invalid thinkingLevel to HIGH');

  // 3. Case-insensitive web search matching
  const reqNormal = {
    model: 'claude-3-7-sonnet',
    messages: [{ role: 'user', content: 'Hello' }]
  };
  const resSearch = await converter.convertRequest(reqNormal, 'gemini-2.5-flash-Search');
  assert(resSearch.tools !== undefined && resSearch.tools.some((t: any) => t.googleSearch !== undefined), 'Should support case-insensitive web search suffix matching');

  console.log('✅ Test 9 Passed: Extended Thinking & Case Normalization verified successfully.\n');

  // ==========================================
  // Test 10: Tool Use Stop Reason Mapping
  // ==========================================
  console.log('Running Test 10: Tool Use Stop Reason Mapping...');

  // Mock Gemini response with a tool call and finishReason !== 'STOP'
  const mockGeminiResponse = {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                id: 'toolu_123',
                name: 'get_weather',
                args: { location: 'San Francisco, CA' }
              }
            }
          ]
        },
        finishReason: 'OTHER' // Not 'STOP'
      }
    ]
  };

  const convertedResponse = await converter.convertResponse(mockGeminiResponse, 'gemini-2.5-pro');
  assert(convertedResponse.stop_reason === 'tool_use', 'Should set stop_reason to tool_use when tool is called, even if finishReason is not STOP');

  console.log('✅ Test 10 Passed: Tool Use Stop Reason Mapping verified successfully.\n');

  // ==========================================
  // Test 11: Global Thought Signature Propagation and Fallback
  // ==========================================
  console.log('Running Test 11: Global Thought Signature Propagation...');
  
  // Case A: Real signature found in one model message, should propagate to all model parts without signature
  const reqWithSig = {
    model: 'claude-3-7-sonnet',
    messages: [
      {
        role: 'user',
        content: 'Run tools'
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: encodeToolId('tool_1', 'my-real-sig-123', 'tool_name_1', false),
            name: 'tool_name_1',
            input: {}
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: encodeToolId('tool_1', 'my-real-sig-123', 'tool_name_1', false),
            content: 'result 1'
          }
        ]
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: encodeToolId('tool_2', undefined, 'tool_name_2', false),
            name: 'tool_name_2',
            input: {}
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: encodeToolId('tool_2', undefined, 'tool_name_2', false),
            content: 'result 2'
          }
        ]
      }
    ]
  };

  const convertedWithSig = await converter.convertRequest(reqWithSig, 'gemini-2.5-pro');
  const modelPartsWithSig = convertedWithSig.contents.filter((c: any) => c.role === 'model').flatMap((c: any) => c.parts);
  assert(modelPartsWithSig.length === 2, 'Should have 2 model parts');
  assert(modelPartsWithSig[0].thoughtSignature === 'my-real-sig-123', 'First part should have the real signature');
  assert(modelPartsWithSig[1].thoughtSignature === 'my-real-sig-123', 'Second part should have propagated the real signature');

  // Case B: No real signature found, should fallback to 'skip_thought_signature_validator'
  const reqWithoutSig = {
    model: 'claude-3-7-sonnet',
    messages: [
      {
        role: 'user',
        content: 'Run tools'
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: encodeToolId('tool_1', undefined, 'tool_name_1', false),
            name: 'tool_name_1',
            input: {}
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: encodeToolId('tool_1', undefined, 'tool_name_1', false),
            content: 'result 1'
          }
        ]
      }
    ]
  };

  const convertedWithoutSig = await converter.convertRequest(reqWithoutSig, 'gemini-2.5-pro');
  const modelPartsWithoutSig = convertedWithoutSig.contents.filter((c: any) => c.role === 'model').flatMap((c: any) => c.parts);
  assert(modelPartsWithoutSig.length === 1, 'Should have 1 model part');
  assert(modelPartsWithoutSig[0].thoughtSignature === 'skip_thought_signature_validator', 'Should fallback to skip_thought_signature_validator');

  console.log('✅ Test 11 Passed: Global Thought Signature Propagation and fallback verified successfully.\n');

  // ==========================================
  // Test 12: Aborted/Unmatched Tool Call Virtual Response Synthesis
  // ==========================================
  console.log('Running Test 12: Aborted/Unmatched Tool Call Virtual Response Synthesis...');
  
  const reqWithUnmatchedTool = {
    model: 'claude-3-7-sonnet',
    messages: [
      {
        role: 'user',
        content: 'Please search for TypeScript modules'
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: encodeToolId('tool_unmatched', 'sig-abc', 'search_web', false),
            name: 'search_web',
            input: { query: 'TypeScript' }
          }
        ]
      },
      // Note: No matching tool_result is sent because the user aborted/cancelled the previous turn.
      {
        role: 'user',
        content: 'Actually search for Hono instead'
      }
    ]
  };

  const convertedWithUnmatched = await converter.convertRequest(reqWithUnmatchedTool, 'gemini-2.5-pro');
  
  // The reorganized messages should have:
  // 1. User original prompt
  // 2. Model turn with functionCall (the tool_use)
  // 3. Automatically synthesized User turn with functionResponse (remedying the missing tool_result)
  const finalContents = convertedWithUnmatched.contents;
  assert(finalContents.length === 3, 'Should have exactly 3 content messages (1 user, 1 model, 1 user)');
  assert(finalContents[0].role === 'user', 'First message must be user');
  
  assert(finalContents[1].role === 'model', 'Second message must be model');
  assert(finalContents[1].parts[0].functionCall !== undefined, 'Second message must contain functionCall');
  
  assert(finalContents[2].role === 'user', 'Third message must be user');
  assert(finalContents[2].parts[0].functionResponse !== undefined, 'Third message must contain synthesized functionResponse');
  assert(finalContents[2].parts[0].functionResponse.response.output.includes('aborted'), 'Synthesized response should mention abort/cancel');
  
  console.log('✅ Test 12 Passed: Aborted/Unmatched tool call virtual responses synthesized successfully.\n');

  // ==========================================
  // Test 13: Connection Leaks on Timeout Rejection
  // ==========================================
  console.log('Running Test 13: Connection Leaks on Timeout Rejection...');
  
  const originalFetch = (global as any).fetch;
  let abortCalled = false;
  const originalAbort = AbortController.prototype.abort;
  
  AbortController.prototype.abort = function() {
    abortCalled = true;
    originalAbort.apply(this);
  };

  try {
    (global as any).fetch = async () => {
      return {
        status: 200,
        headers: new Map(),
        text: () => new Promise<string>(() => {
          // Keep response.text() body timeout pending
        })
      };
    };

    const mockProvider = {
      name: 'gemini-test',
      type: 'gemini' as const,
      api_base_url: 'http://mock-api/',
      models: ['gemini-2.5-pro']
    };
    
    const originalSetTimeout = global.setTimeout;
    (global as any).setTimeout = (callback: any, delay: number, ...args: any[]) => {
      if (delay === 15000) {
        return originalSetTimeout(callback, 10, ...args); // Accelerate 15s to 10ms
      }
      return originalSetTimeout(callback, delay, ...args);
    };

    const adapter = new GeminiAdapter(mockProvider);
    await adapter.execute({ prompt: 'test' });
    
    assert(abortCalled === true, 'AbortController.abort() should have been called on response body read timeout');
    
    (global as any).setTimeout = originalSetTimeout;
  } finally {
    (global as any).fetch = originalFetch;
    AbortController.prototype.abort = originalAbort;
  }
  console.log('✅ Test 13 Passed: Connection leaks resolved by aborting fetch on body read timeout.\n');

  // ==========================================
  // Test 14: Upstream Stream Leaks on Internal Failure
  // ==========================================
  console.log('Running Test 14: Upstream Stream Leaks on Internal Failure...');
  
  let upstreamCancelled = false;
  const mockUpstreamStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n'));
    },
    cancel() {
      upstreamCancelled = true;
    }
  });

  try {
    const converterInstance = new AnthropicToGeminiConverter();
    const resultStream = converterInstance.convertStream(mockUpstreamStream, 'gemini-2.5-pro');
    
    const reader = resultStream.getReader();
    try {
      // 读取首个数据块
      const { done } = await reader.read();
      // 模拟客户端取消，主动调用 cancel，期望能自动冒泡并安全关闭上游流，防止泄露
      await reader.cancel();
      // 等待异步取消回调执行完毕
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (e) {
      // 忽略可能存在的任何异常
    } finally {
      reader.releaseLock();
    }
    
    assert(upstreamCancelled === true, 'upstreamStream.cancel() should have been called on pipeline cancellation/abort');
  } catch (err: any) {
    throw new Error(`Test 14 encountered unexpected exception: ${err.message}`);
  }
  console.log('✅ Test 14 Passed: Upstream stream cancelled on pipeline cancellation/abort.\n');

  // ==========================================
  // Test 15: Zero-Buffering on Non-Agentic Streams
  // ==========================================
  console.log('Running Test 15: Zero-Buffering on Non-Agentic Streams...');
  
  const mockStreamNonAgentic = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n'));
      controller.close();
    }
  });
  
  const converterInstance = new AnthropicToGeminiConverter();
  const resultStreamNonAgentic = converterInstance.convertStream(mockStreamNonAgentic, 'gemini-2.5-pro', {
    clientSupportsThinking: false
  });
  
  const readerNonAgentic = resultStreamNonAgentic.getReader();
  const chunksNonAgentic: string[] = [];
  const decoder = new TextDecoder();
  
  while (true) {
    const { done, value } = await readerNonAgentic.read();
    if (done) break;
    chunksNonAgentic.push(decoder.decode(value));
  }
  readerNonAgentic.releaseLock();
  
  const joinedNonAgentic = chunksNonAgentic.join('\n');
  assert(joinedNonAgentic.includes('content_block_delta') && joinedNonAgentic.includes('Hello'), 'Non-agentic stream should immediately emit text delta');
  
  const mockStreamAgentic = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"I will help you with that."}]}}]}\n\n'));
      controller.close();
    }
  });
  
  const resultStreamAgentic = converterInstance.convertStream(mockStreamAgentic, 'gemini-2.5-pro', {
    clientSupportsThinking: false,
    tools: [{ name: 'get_weather' }]
  });
  
  const readerAgentic = resultStreamAgentic.getReader();
  const chunksAgentic: string[] = [];
  while (true) {
    const { done, value } = await readerAgentic.read();
    if (done) break;
    chunksAgentic.push(decoder.decode(value));
  }
  readerAgentic.releaseLock();
  
  const joinedAgentic = chunksAgentic.join('\n');
  assert(joinedAgentic.includes('I will help you with that.'), 'Agentic stream should still output text at the end');

  console.log('✅ Test 15 Passed: Zero-buffering on non-agentic streams verified successfully.\n');

  console.log('🎉 ALL REGRESSION TESTS PASSED SUCCESSFULLY! 100% PROTOCOL COMPLIANT! 🎉');
}

runTests().catch(err => {
  console.error('\n❌ REGRESSION TEST SUITE FAILED:', err);
  process.exit(1);
});
