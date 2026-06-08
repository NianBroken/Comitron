export interface ParsedApiServiceConfig {
  apiUrl: string;
  apiKey: string;
  modelId: string;
  customParameters: Record<string, unknown>;
  requestUrl: URL;
}

type TranslateFunction = (message: string, ...args: string[]) => string;

const RESERVED_API_PARAMETER_KEYS = new Set(['model', 'messages']);

/**
 * 把设置页中的 API 服务 JSON 解析成结构化对象。
 * 这里固定要求 4 个键，调用方通过传入翻译函数决定最终报错文案。
 */
export function parseApiServiceConfig(
  rawConfig: string,
  translate: TranslateFunction
): ParsedApiServiceConfig {
  if (!rawConfig.trim()) {
    throw new Error(translate('API 服务配置不能为空。'));
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(rawConfig) as Record<string, unknown>;
  } catch {
    throw new Error(translate('API 服务配置不是合法 JSON。'));
  }

  const apiUrl = readStringField(parsed, ['API地址', 'apiUrl']);
  const apiKey = readStringField(parsed, ['API密钥', 'apiKey']);
  const modelId = readStringField(parsed, ['模型ID', 'modelId']);
  const customParametersValue = parsed['自定义参数'] ?? parsed.customParameters ?? {};

  if (!apiUrl) {
    throw new Error(translate('API 服务配置缺少 {0}。', 'API地址'));
  }

  if (!apiKey) {
    throw new Error(translate('API 服务配置缺少 {0}。', 'API密钥'));
  }

  if (!modelId) {
    throw new Error(translate('API 服务配置缺少 {0}。', '模型ID'));
  }

  if (apiKey === 'sk-your-key') {
    throw new Error(translate('API 密钥仍然是默认占位值，请先替换成真实密钥。'));
  }

  if (!isPlainObject(customParametersValue)) {
    throw new Error(translate('API 服务配置中的 {0} 必须是 JSON 对象。', '自定义参数'));
  }

  const requestUrl = parseApiServiceUrl(apiUrl, translate);
  validateApiCustomParameters(customParametersValue, translate);

  return {
    apiUrl,
    apiKey,
    modelId,
    customParameters: customParametersValue,
    requestUrl
  };
}

function parseApiServiceUrl(apiUrl: string, translate: TranslateFunction): URL {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new Error(translate('API 地址必须是合法的 http 或 https 地址。'));
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(translate('API 地址必须是合法的 http 或 https 地址。'));
  }

  return parsedUrl;
}

function validateApiCustomParameters(
  customParameters: Record<string, unknown>,
  translate: TranslateFunction
): void {
  for (const key of RESERVED_API_PARAMETER_KEYS) {
    if (key in customParameters) {
      throw new Error(translate('API 服务配置中的 {0} 不能覆盖 {1} 字段。', '自定义参数', key));
    }
  }

  if (customParameters.stream === true) {
    throw new Error(translate('API 服务模式不支持 stream=true。请关闭流式输出后重试。'));
  }
}

function readStringField(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
