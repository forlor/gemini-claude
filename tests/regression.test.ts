import { cleanAndCaseJsonSchema } from '../src/converters/utils/schema-case.js';
import { truncateTrailingAssistant, injectPrefillToResponse } from '../src/converters/utils/message-truncator.js';
import { encodeToolId, decodeToolId } from '../src/converters/utils/tool-map.js';
import { appendSearchCitations } from '../src/converters/utils/web-search.js';
import { mergeSameRoleMessages, reorganizeToolMessages } from '../src/converters/utils/role-reorganizer.js';
import { estimateRequestTokens, estimateTokens } from '../src/utils/token-counter.js';
import { RouterEngine } from '../src/router/engine.js';
import { AppConfig } from '../src/config.js';

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
  
  // 4. Fallback candidates verification
  const fallbacks = engine.getFallbackCandidates(targetDefault);
  assert(fallbacks.length === 3, 'Should find 3 fallback targets: primary, other provider supporting same model, and flash fallback');
  assert(fallbacks[1].provider.name === 'vertex', 'Second candidate should be vertex with same model');
  assert(fallbacks[2].targetModel === 'gemini-2.5-flash', 'Third candidate should cascade to flash model');

  console.log('✅ Test 7 Passed: Router Engine & Prioritization works beautifully.\n');

  console.log('🎉 ALL REGRESSION TESTS PASSED SUCCESSFULLY! 100% PROTOCOL COMPLIANT! 🎉');
}

runTests().catch(err => {
  console.error('\n❌ REGRESSION TEST SUITE FAILED:', err);
  process.exit(1);
});
