import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ProviderConfig {
  name: string;
  type: 'gemini' | 'vertex-gemini' | 'openai-compat' | 'anthropic';
  api_base_url: string;
  api_key?: string;
  models: string[];
}

export interface RouterConfig {
  default: string;
  background?: string;
  think?: string;
  longContext?: string;
  longContextThreshold?: number;
}

export interface AppConfig {
  PORT: number;
  APIKEY?: string;
  LOG: boolean;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  API_TIMEOUT_MS: number;
  PROXY_URL?: string;
  Providers: ProviderConfig[];
  Router: RouterConfig;
  CUSTOM_ROUTER_PATH?: string;
  disable_context_cache?: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
  PORT: 3456,
  LOG: true,
  LOG_LEVEL: 'info',
  API_TIMEOUT_MS: 600000,
  Providers: [
    {
      name: 'gemini',
      type: 'gemini',
      api_base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',
      api_key: '$GEMINI_API_KEY',
      models: ['gemini-2.5-pro', 'gemini-2.5-flash']
    }
  ],
  Router: {
    default: 'gemini,gemini-2.5-pro',
    background: 'gemini,gemini-2.5-flash',
    think: 'gemini,gemini-2.5-pro',
    longContext: 'gemini,gemini-2.5-pro',
    longContextThreshold: 60000
  }
};

let loadedConfig: AppConfig | null = null;

/**
 * 递归解析字符串中的环境变量。例如将 "$GEMINI_API_KEY" 替换为 process.env.GEMINI_API_KEY
 */
function interpolateEnv(value: any): any {
  if (typeof value === 'string') {
    if (value.startsWith('$')) {
      const envName = value.substring(1);
      return process.env[envName] || '';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => interpolateEnv(item));
  }
  if (value !== null && typeof value === 'object') {
    const resolved: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = interpolateEnv(v);
    }
    return resolved;
  }
  return value;
}

/**
 * 探测并获取配置文件的物理绝对路径
 */
function getConfigFilePaths(): string[] {
  const currentDir = process.cwd();
  const homeDir = os.homedir();
  
  return [
    path.join(currentDir, 'config.json'),
    path.join(currentDir, '.gemini-gateway', 'config.json'),
    path.join(homeDir, '.gemini-gateway', 'config.json')
  ];
}

/**
 * 加载配置，若不存在则创建默认配置并写入本地
 */
export function loadConfig(forceReload = false): AppConfig {
  if (loadedConfig && !forceReload) {
    return loadedConfig;
  }

  const paths = getConfigFilePaths();
  let foundPath: string | null = null;
  let rawContent = '';

  for (const configPath of paths) {
    if (fs.existsSync(configPath)) {
      try {
        rawContent = fs.readFileSync(configPath, 'utf8');
        foundPath = configPath;
        break;
      } catch (err) {
        // 忽略单个读取错误，继续寻找
      }
    }
  }

  let finalConfig: AppConfig;

  if (foundPath && rawContent.trim()) {
    try {
      const parsed = JSON.parse(rawContent);
      finalConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        Router: {
          ...DEFAULT_CONFIG.Router,
          ...(parsed.Router || {})
        }
      };
    } catch (err: any) {
      console.error(`[CONFIG_ERROR] 无法解析配置文件: ${foundPath}. 错误: ${err.message}. 回退到默认配置。`);
      finalConfig = { ...DEFAULT_CONFIG };
    }
  } else {
    // 未找到配置，默认在工作目录创建
    const writePath = paths[0];
    try {
      const parentDir = path.dirname(writePath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(writePath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      console.log(`[CONFIG] 未找到配置文件，已在当前工作区生成默认配置: ${writePath}`);
    } catch (err: any) {
      console.warn(`[CONFIG_WARN] 无法在本地写入默认配置文件: ${err.message}`);
    }
    finalConfig = { ...DEFAULT_CONFIG };
  }

  // 递归解析变量
  const interpolated = interpolateEnv(finalConfig) as AppConfig;

  // 额外支持直接通过最上级环境变量覆写部分核心配置 (以防 docker 部署等)
  if (process.env.PORT) {
    const parsedPort = parseInt(process.env.PORT, 10);
    if (!isNaN(parsedPort)) {
      interpolated.PORT = parsedPort;
    }
  }
  if (process.env.APIKEY) {
    interpolated.APIKEY = process.env.APIKEY;
  }
  if (process.env.DISABLE_CONTEXT_CACHE) {
    interpolated.disable_context_cache = process.env.DISABLE_CONTEXT_CACHE === 'true';
  }
  if (process.env.LOG_LEVEL) {
    const lvl = process.env.LOG_LEVEL.toLowerCase();
    if (['debug', 'info', 'warn', 'error'].includes(lvl)) {
      interpolated.LOG_LEVEL = lvl as any;
    }
  }

  loadedConfig = interpolated;
  return loadedConfig;
}

/**
 * 辅助：直接获取当前持有的配置
 */
export function getConfig(): AppConfig {
  return loadConfig();
}
