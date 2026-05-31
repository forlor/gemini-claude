/**
 * 针对不同 Provider 清洗并规范化 JSON Schema 结构，防止上游返回 400 参数校验错误
 */

const UNSUPPORTED_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', 'title',
  'example', 'examples', 'readOnly', 'writeOnly', 'default',
  'exclusiveMaximum', 'exclusiveMinimum', 'const', 'additionalItems',
  'contains', 'patternProperties', 'dependencies', 'propertyNames',
  'if', 'then', 'else', 'contentEncoding', 'contentMediaType',
  'additionalProperties'
]);

const VALIDATION_KEYS = [
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'format'
];

/**
 * 递归清洗 JSON Schema，移除不支持的字段，把验证约束隐式退级到 description 尾端，并自适应转换类型名大小写
 * 
 * @param schema 原始 JSON Schema 对象
 * @param typeCasing 目标类型名称大小写规范: 'uppercase' (如 STRING, OBJECT) | 'lowercase' (如 string, object)
 */
export function cleanAndCaseJsonSchema(schema: any, typeCasing: 'uppercase' | 'lowercase' = 'uppercase'): any {
  if (Array.isArray(schema)) {
    return schema.map(item => cleanAndCaseJsonSchema(item, typeCasing));
  }
  
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }

  const result: Record<string, any> = {};
  const validations: string[] = [];

  // 1. 提取并记录所有的验证性字段约束，用于后续提示词退级
  for (const key of VALIDATION_KEYS) {
    if (schema[key] !== undefined && schema[key] !== null && schema[key] !== '') {
      validations.push(`${key}: ${JSON.stringify(schema[key])}`);
    }
  }

  // 2. 转换 type 字段并处理 anyOf/oneOf 联合类型
  if ('type' in schema) {
    let typeValue = schema.type;

    // 如果 type 是数组，例如 ["string", "null"]，将其简化为单个非空类型，并记录为 nullable
    if (Array.isArray(typeValue)) {
      const nonNullTypes = typeValue.filter(t => typeof t === 'string' && t.toLowerCase() !== 'null');
      const hasNull = typeValue.some(t => typeof t === 'string' && t.toLowerCase() === 'null');

      typeValue = nonNullTypes[0] || 'string';
      if (hasNull) {
        result.nullable = true;
        validations.push('nullable: true');
      }
    }

    if (typeof typeValue === 'string') {
      const lowerType = typeValue.toLowerCase();
      // 映射类型名
      if (['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(lowerType)) {
        result.type = typeCasing === 'uppercase' ? lowerType.toUpperCase() : lowerType;
      } else if (lowerType === 'null') {
        result.type = typeCasing === 'uppercase' ? 'STRING' : 'string';
        result.nullable = true;
        validations.push('nullable: true');
      }
    }
  }

  // 3. 处理 anyOf / oneOf 单一退级
  if ('anyOf' in schema || 'oneOf' in schema) {
    const unionKey = 'anyOf' in schema ? 'anyOf' : 'oneOf';
    const unionItems = schema[unionKey];

    if (Array.isArray(unionItems) && unionItems.length > 0) {
      // 检查联合类型中是否包含 null 类型
      const hasNullInUnion = unionItems.some(item => item && (item.type === 'null' || (Array.isArray(item.type) && item.type.includes('null'))));
      if (hasNullInUnion) {
        result.nullable = true;
        validations.push('nullable: true');
      }

      // 查找并保留第一个带有 properties 或复杂类型的分支
      const preferred = unionItems.find(item => item && (item.type === 'object' || item.type === 'array' || item.properties || item.items))
        || unionItems.find(item => item && item.type);

      if (preferred) {
        // 递归清洗选中的分支
        const cleanedPreferred = cleanAndCaseJsonSchema(preferred, typeCasing);
        Object.assign(result, cleanedPreferred);
      } else {
        // 兜底降级为 string
        result.type = typeCasing === 'uppercase' ? 'STRING' : 'string';
      }
    }
  }

  // 4. 递归处理 properties、items 节点
  for (const [key, value] of Object.entries(schema)) {
    // 跳过不支持的字段、验证字段以及已经处理过的 type/anyOf/oneOf
    if (UNSUPPORTED_KEYS.has(key) || VALIDATION_KEYS.includes(key) || key === 'type' || key === 'anyOf' || key === 'oneOf') {
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const cleanedProperties: Record<string, any> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        cleanedProperties[propName] = cleanAndCaseJsonSchema(propSchema, typeCasing);
      }
      result.properties = cleanedProperties;
    } else if (key === 'items') {
      if (Array.isArray(value)) {
        result.items = value.length > 0 ? cleanAndCaseJsonSchema(value[0], typeCasing) : {};
        validations.push('tuple schema simplified');
      } else {
        result.items = cleanAndCaseJsonSchema(value, typeCasing);
      }
    } else {
      result[key] = value;
    }
  }

  // 5. 将验证约束注入到 description 属性末端
  if (validations.length > 0) {
    const originalDesc = schema.description || '';
    const validationStr = `(validation - ${validations.join(', ')})`;
    result.description = originalDesc ? `${originalDesc} ${validationStr}` : `Validation: ${validations.join(', ')}`;
  }

  // 6. 健壮性补全：如果包含 properties 但没有 type，强制声明为 object
  if (result.properties && !result.type) {
    result.type = typeCasing === 'uppercase' ? 'OBJECT' : 'object';
  }

  // 7. 清理 required 属性（防止 required 包含已被剥离的空属性或无效字段）
  if (Array.isArray(schema.required)) {
    const validProps = result.properties ? new Set(Object.keys(result.properties)) : new Set();
    const filteredRequired = schema.required.filter((item: any) => typeof item === 'string' && validProps.has(item));

    if (filteredRequired.length > 0) {
      result.required = filteredRequired;
    } else {
      delete result.required;
    }
  }

  return result;
}
