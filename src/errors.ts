import { t } from './i18n';

/**
 * 用户在错误提示里可以直接触发的操作。
 * 这里统一描述动作类型和可选的设置键，供界面层执行。
 */
export interface UserFacingErrorAction {
  label: string;
  type: 'openSettings' | 'showLogger';
  settingKey?: string;
}

/**
 * 面向用户展示的错误结果。
 * message 是最终会直接显示给用户的完整文本。
 */
export interface UserFacingError {
  kind: string;
  message: string;
  actions: UserFacingErrorAction[];
}

/**
 * 扩展内部统一使用的错误基类。
 * kind 用于日志和界面层分类，message 保留技术层真实失败原因。
 */
class ComitronError extends Error {
  constructor(
    public readonly kind: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * 与工具路径相关的错误基类。
 * settingKey 固定指向 toolPath，界面层可直接据此打开设置。
 */
export class ToolPathError extends ComitronError {
  public readonly settingKey = 'comitron.toolPath';

  constructor(
    kind: 'toolPathMissing' | 'toolPathInvalid',
    public readonly toolName: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(kind, message, options);
  }
}

/**
 * 工具路径缺失时抛出的错误。
 */
export class ToolPathMissingError extends ToolPathError {
  constructor(toolName: string, message: string, options?: ErrorOptions) {
    super('toolPathMissing', toolName, message, options);
  }
}

/**
 * 工具路径无效时抛出的错误。
 * configuredPath 会原样带回给界面层，用于错误提示。
 */
export class ToolPathInvalidError extends ToolPathError {
  constructor(
    toolName: string,
    public readonly configuredPath: string,
    message: string,
    options?: ErrorOptions
  ) {
    super('toolPathInvalid', toolName, message, options);
  }
}

/**
 * API 服务配置错误。
 * 这里统一指向 apiServiceJson 设置项。
 */
export class ApiServiceConfigError extends ComitronError {
  public readonly settingKey = 'comitron.apiServiceJson';

  constructor(message: string, options?: ErrorOptions) {
    super('apiServiceConfig', message, options);
  }
}

/**
 * 响应 JSON Schema 配置错误。
 * 这里统一指向 responseJsonSchema 设置项。
 */
export class ResponseJsonSchemaConfigError extends ComitronError {
  public readonly settingKey = 'comitron.responseJsonSchema';

  constructor(message: string, options?: ErrorOptions) {
    super('responseJsonSchemaConfig', message, options);
  }
}

/**
 * 本地 AI 工具执行失败。
 * 这类错误通常来自命令行工具本身、登录态、权限或命令参数。
 */
export class AiToolExecutionError extends ComitronError {
  public readonly settingKey = 'comitron.toolPath';

  constructor(
    public readonly toolName: string,
    public readonly executablePath: string,
    message: string,
    options?: ErrorOptions
  ) {
    super('aiToolExecution', message, options);
  }
}

/**
 * AI 已返回内容，但结果格式不满足插件要求。
 */
export class AiOutputValidationError extends ComitronError {
  public readonly settingKey = 'comitron.responseJsonSchema';

  constructor(message: string, options?: ErrorOptions) {
    super('aiOutputValidation', message, options);
  }
}

/**
 * API 服务请求相关错误的公共基类。
 * 这里保留接口地址和模型信息，便于日志定位。
 */
export class ApiServiceRequestError extends ComitronError {
  public readonly settingKey = 'comitron.apiServiceJson';

  constructor(
    kind: 'apiNetwork' | 'apiHttp' | 'apiResponseParse' | 'apiEmptyResponse',
    public readonly apiUrl: string,
    public readonly modelId: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(kind, message, options);
  }
}

/**
 * API 请求在拿到 HTTP 响应之前就失败。
 * 这里保存原始网络错误代码和简短细节，供日志和提示共用。
 */
export class ApiServiceNetworkError extends ApiServiceRequestError {
  constructor(
    apiUrl: string,
    modelId: string,
    public readonly errorCode: string | undefined,
    public readonly errorDetail: string,
    options?: ErrorOptions
  ) {
    super('apiNetwork', apiUrl, modelId, errorDetail, options);
  }
}

/**
 * API 服务已返回 HTTP 响应，但状态码表示请求失败。
 */
export class ApiServiceHttpError extends ApiServiceRequestError {
  constructor(
    apiUrl: string,
    modelId: string,
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly serviceMessage: string,
    public readonly responseBodyPreview: string,
    options?: ErrorOptions
  ) {
    super('apiHttp', apiUrl, modelId, serviceMessage || `${statusCode} ${statusText}`, options);
  }
}

/**
 * API 服务返回了数据，但格式不是插件可解析的 JSON。
 */
export class ApiServiceResponseParseError extends ApiServiceRequestError {
  constructor(
    apiUrl: string,
    modelId: string,
    public readonly responseBodyPreview: string,
    message: string,
    options?: ErrorOptions
  ) {
    super('apiResponseParse', apiUrl, modelId, message, options);
  }
}

/**
 * API 服务返回成功，但没有给出可用文本。
 */
export class ApiServiceEmptyResponseError extends ApiServiceRequestError {
  constructor(
    apiUrl: string,
    modelId: string,
    public readonly responseBodyPreview: string,
    message: string,
    options?: ErrorOptions
  ) {
    super('apiEmptyResponse', apiUrl, modelId, message, options);
  }
}

/**
 * 把任意错误转换成真实 Error 实例。
 * 非 Error 的值会被包装，避免后续日志和分类缺信息。
 */
export function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

/**
 * 把内部错误转换成面向用户的完整提示。
 * 所有返回文本都带上下文和可执行建议，不把用户留在纯技术异常里。
 */
export function toUserFacingError(error: unknown): UserFacingError {
  if (error instanceof ToolPathMissingError) {
    return {
      kind: error.kind,
      message: joinMessageLines(
        t('当前所选 AI 工具没有可用的可执行文件路径。'),
        buildFailureReasonLine(error.message),
        t('请打开设置，填写正确的工具路径后重试。')
      ),
      actions: buildActions(error.settingKey)
    };
  }

  if (error instanceof ToolPathInvalidError) {
    return {
      kind: error.kind,
      message: joinMessageLines(
        t('当前所选 AI 工具路径无效，插件无法启动它。'),
        buildFailureReasonLine(error.message),
        t('请打开设置，修正工具路径后重试。')
      ),
      actions: buildActions(error.settingKey)
    };
  }

  if (error instanceof ApiServiceConfigError) {
    return {
      kind: error.kind,
      message: joinMessageLines(
        t('AI 服务配置无效，当前请求没有发出。'),
        buildFailureReasonLine(error.message),
        t('请打开设置，修正 API地址、API密钥、模型ID 或自定义参数后重试。')
      ),
      actions: buildActions(error.settingKey)
    };
  }

  if (error instanceof ResponseJsonSchemaConfigError) {
    return {
      kind: error.kind,
      message: joinMessageLines(
        t('响应 JSON Schema 配置无效，当前生成流程无法继续。'),
        buildFailureReasonLine(error.message),
        t('请打开设置，修正响应 JSON Schema 后重试。')
      ),
      actions: buildActions(error.settingKey)
    };
  }

  if (error instanceof AiToolExecutionError) {
    return {
      kind: error.kind,
      message: joinMessageLines(
        t('本地 AI 工具执行失败。'),
        buildFailureReasonLine(error.message),
        t('请检查工具是否已经完成登录、能否在终端中独立运行，以及路径配置是否正确。')
      ),
      actions: buildActions(error.settingKey)
    };
  }

  if (error instanceof ApiServiceNetworkError) {
    return {
      kind: error.kind,
      message: joinMessageLines(
        resolveNetworkSummary(error.errorCode),
        buildFailureReasonLine(error.errorDetail),
        resolveNetworkHint(error.errorCode),
        t('请检查 API 地址、网络、代理和证书环境后重试。')
      ),
      actions: buildActions(error.settingKey)
    };
  }

  if (error instanceof ApiServiceHttpError) {
    return {
      kind: error.kind,
      message: joinMessageLines(
        resolveHttpSummary(error.statusCode),
        t('接口状态码：{0}', String(error.statusCode)),
        buildServerMessageLine(error.serviceMessage || error.statusText),
        resolveHttpHint(error.statusCode)
      ),
      actions: buildActions(error.settingKey)
    };
  }

  if (error instanceof ApiServiceResponseParseError) {
    return {
      kind: error.kind,
      message: joinMessageLines(
        t('AI 服务已经返回数据，但返回内容不是插件可解析的 JSON。'),
        buildFailureReasonLine(error.message),
        t('这通常表示当前接口返回了不兼容的格式，或自定义参数启用了插件不支持的流式输出。'),
        t('请检查 API 地址、自定义参数和返回格式后重试。')
      ),
      actions: buildActions(error.settingKey)
    };
  }

  if (error instanceof ApiServiceEmptyResponseError) {
    return {
      kind: error.kind,
      message: joinMessageLines(
        t('AI 服务返回成功，但没有给出可用内容。'),
        buildFailureReasonLine(error.message),
        t('请检查当前模型是否能稳定返回文本内容，并确认接口没有被自定义参数改成空响应模式。')
      ),
      actions: buildActions(error.settingKey)
    };
  }

  if (error instanceof AiOutputValidationError) {
    return {
      kind: error.kind,
      message: joinMessageLines(
        t('AI 已返回内容，但结果不符合插件要求的 JSON 结构。'),
        buildFailureReasonLine(error.message),
        t('请检查 Tool Response Prompt、响应 JSON Schema，以及当前模型是否稳定支持 JSON 输出。')
      ),
      actions: buildActions(error.settingKey)
    };
  }

  const normalizedError = ensureError(error);

  return {
    kind: 'unknown',
    message: joinMessageLines(
      t('生成 Commit Message 时发生了未预期错误。'),
      buildFailureReasonLine(normalizedError.message),
      t('详细技术信息已写入日志，请先查看日志再处理。')
    ),
    actions: buildActions()
  };
}

/**
 * 构造标准的用户动作列表。
 * 所有错误都允许查看日志，已知配置类错误会额外提供打开设置。
 */
function buildActions(settingKey?: string): UserFacingErrorAction[] {
  const actions: UserFacingErrorAction[] = [
    {
      label: t('查看日志'),
      type: 'showLogger'
    }
  ];

  if (settingKey) {
    actions.unshift({
      label: t('打开设置'),
      type: 'openSettings',
      settingKey
    });
  }

  return actions;
}

/**
 * 把多行提示整理成最终文本。
 * 空行和空白文本会被自动过滤，避免提示里出现噪声。
 */
function joinMessageLines(...lines: Array<string | undefined>): string {
  return lines
    .map((line) => line?.trim())
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

/**
 * 为用户补出统一的失败原因行。
 * 原始技术消息会先被裁剪，避免直接把大段响应正文灌进提示框。
 */
function buildFailureReasonLine(message: string): string {
  return t('失败原因：{0}', truncateText(message));
}

/**
 * 为用户补出统一的服务端消息行。
 */
function buildServerMessageLine(message: string): string {
  return t('服务端消息：{0}', truncateText(message));
}

/**
 * 按网络错误代码生成摘要。
 */
function resolveNetworkSummary(errorCode: string | undefined): string {
  switch (errorCode) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return t('AI 服务域名无法解析。');
    case 'ECONNREFUSED':
      return t('AI 服务拒绝了连接。');
    case 'ECONNRESET':
    case 'EPIPE':
      return t('与 AI 服务的连接被中断。');
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return t('连接 AI 服务超时。');
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return t('AI 服务的 TLS 证书校验失败。');
    default:
      return t('未能连接到 AI 服务。');
  }
}

/**
 * 按网络错误代码补出更贴近人的处理提示。
 */
function resolveNetworkHint(errorCode: string | undefined): string {
  switch (errorCode) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return t('当前接口域名无法在本机解析，通常与地址填写错误、DNS 异常或网络限制有关。');
    case 'ECONNREFUSED':
      return t('目标地址存在，但当前端口没有接受连接，通常与服务未启动、地址错误或本机被拦截有关。');
    case 'ECONNRESET':
    case 'EPIPE':
      return t('连接已经建立，但在传输阶段被对端或中间网络设备中断。');
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return t('请求长时间没有建立连接或收到响应，通常与网络阻塞、代理异常或服务端负载有关。');
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return t('当前 TLS 证书无法通过校验，通常与自签名证书、过期证书或中间证书链不完整有关。');
    default:
      return t('这类问题通常来自网络连通性、代理配置、TLS 证书或目标服务本身。');
  }
}

/**
 * 按 HTTP 状态码生成摘要。
 */
function resolveHttpSummary(statusCode: number): string {
  if (statusCode === 400) {
    return t('AI 服务拒绝了当前请求参数。');
  }

  if (statusCode === 401) {
    return t('AI 服务拒绝了当前 API 密钥。');
  }

  if (statusCode === 403) {
    return t('当前 API 密钥没有访问这个接口或模型的权限。');
  }

  if (statusCode === 404) {
    return t('AI 服务地址或模型不存在。');
  }

  if (statusCode === 408) {
    return t('AI 服务请求超时。');
  }

  if (statusCode === 429) {
    return t('AI 服务拒绝了当前请求频率或额度。');
  }

  if (statusCode >= 500) {
    return t('AI 服务在处理请求时失败。');
  }

  return t('AI 服务返回了失败响应。');
}

/**
 * 按 HTTP 状态码补出处理建议。
 */
function resolveHttpHint(statusCode: number): string {
  if (statusCode === 400) {
    return t('请检查 API 地址、模型ID、自定义参数和 Prompt 内容是否符合当前服务要求。');
  }

  if (statusCode === 401) {
    return t('请检查 API 密钥是否填写正确，是否已经过期，是否匹配当前服务域名。');
  }

  if (statusCode === 403) {
    return t('请检查当前账号是否具备对应模型权限，或是否被服务端策略拒绝。');
  }

  if (statusCode === 404) {
    return t('请检查 API 地址路径和模型 ID 是否填写正确。');
  }

  if (statusCode === 408) {
    return t('请稍后重试，并检查当前网络和目标服务状态。');
  }

  if (statusCode === 429) {
    return t('请检查当前额度、速率限制和并发限制，稍后再试。');
  }

  if (statusCode >= 500) {
    return t('这通常表示服务端异常、模型当前不可用，或当前请求触发了服务端内部错误。');
  }

  return t('请结合服务端消息检查当前配置和请求内容。');
}

/**
 * 裁剪展示文本。
 * 只保留最前面的有效内容，避免把大段 HTML 或 JSON 直接塞进提示框。
 */
function truncateText(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}
