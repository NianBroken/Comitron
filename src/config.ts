import * as vscode from 'vscode';

/**
 * 已知本地命令行工具的内部标识。
 * 这些值只在扩展内部流转，不直接暴露给设置页面。
 */
export type KnownAiToolName = 'codex' | 'claudeCode' | 'geminiCli';

/**
 * 扩展内部统一使用的 AI 工具标识。
 * 除了本地命令行工具，还包含 API 服务和自定义路径两种模式。
 */
export type AiToolName = KnownAiToolName | 'apiService' | 'custom';

/**
 * 设置页实际保存过的工具选项值。
 * 这里同时兼容新显示值和旧内部值，目的是让旧设置可以被自动迁移。
 */
export type SelectedToolSettingValue =
  | 'Codex'
  | 'ClaudeCode'
  | 'Gemini CLI'
  | 'API服务'
  | '自定义'
  | 'codex'
  | 'claudeCode'
  | 'geminiCli'
  | 'apiService'
  | 'custom';

/**
 * 扩展运行时使用的完整配置对象。
 * 这里的 selectedTool 始终是内部标识，便于后续逻辑统一处理。
 */
export interface ComitronConfig {
  selectedTool: AiToolName;
  detectedTools: string[];
  toolPath: string;
  apiServiceJson: string;
  promptTemplate: string;
  extendedDescriptionEnabledPrompt: string;
  extendedDescriptionDisabledPrompt: string;
  toolResponsePromptTemplate: string;
  commitLanguage: string;
  contextBudget: number;
  includeExtendedDescription: boolean;
  uiLanguage: string;
}

/**
 * 本地工具的静态定义。
 * key 用于扩展内部逻辑，label 用于设置页和说明文案，commandName 用于系统 PATH 检测。
 */
export interface ToolDefinition {
  key: KnownAiToolName;
  label: string;
  commandName: string;
}

/**
 * 已读取到的本地工具信息。
 * path 是最终可以直接执行的绝对路径。
 */
export interface DetectedTool {
  key: KnownAiToolName;
  label: string;
  path: string;
}

/**
 * 当前扩展支持的 UI 语言定义。
 * code 用于配置存储，label 用于设置页显示。
 */
export interface UiLanguageDefinition {
  code: string;
  label: string;
}

/**
 * 扩展配置根节点。
 * 所有设置项都挂在 comitron 下。
 */
export const CONFIG_SECTION = 'comitron';

/**
 * 设置页中展示给用户看的工具选项值。
 * 这些值用于消除下拉项“标题和副标题重复”的问题。
 */
export const SELECTED_TOOL_SETTING_VALUES = {
  codex: 'Codex',
  claudeCode: 'ClaudeCode',
  geminiCli: 'Gemini CLI',
  apiService: 'API服务',
  custom: '自定义'
} as const;

/**
 * 主 Prompt 的默认模板。
 * 模板中保留的变量会在运行时被实际值替换。
 */
export const DEFAULT_PROMPT_TEMPLATE =
  '你是一个专门生成 Git Commit Message 的助手。你的任务是基于下面提供的全部已更改文件内容与差异，生成 3 条可以直接提交的候选 Commit Message。\n\n输出语言：{{commitLanguage}}\n{{extendedDescriptionInstruction}}\n\n执行规则：\n1. 必须综合全部已更改文件，不得只描述单个文件。\n2. 必须先判断本次提交的主要目的，再生成候选项。\n3. 3 条候选项都要准确描述同一组改动，但写法要有区分，不得重复。\n4. title 必须使用最合适的 Conventional Commits 前缀，例如 feat:、fix:、docs:、refactor:、test:、chore:。\n5. title 必须单行、明确、简洁，避免空话、避免模糊词、避免句号。\n6. 如果改动点很多，title 只概括最核心的提交目的，不要堆砌细节。\n7. description 只写补充说明，必须使用列表格式，每行一条，以 - 开头，不得重复 title。\n8. 当不需要 Extended description 时，description 必须返回空字符串。\n9. 只输出合法 JSON，不要输出解释、代码块、标题或任何额外文字。\n\n返回格式：\n{\n  "messages": [\n    {\n      "title": "type: summary",\n      "description": "extended description"\n    },\n    {\n      "title": "type: summary",\n      "description": "extended description"\n    },\n    {\n      "title": "type: summary",\n      "description": "extended description"\n    }\n  ]\n}\n\n以下是当前仓库内所有已更改文件的内容与差异：\n{{changedFiles}}';

/**
 * 提供给所有 AI 执行路径的补充 Prompt。
 * 这个 Prompt 会和统一输出约束一起发送给本地工具与 API 服务，
 * 作用是要求结果只返回合法 JSON，不附带额外解释。
 */
export const DEFAULT_TOOL_RESPONSE_PROMPT_TEMPLATE =
  '请根据标准输入中的内容生成结果，只输出合法 JSON，不要输出解释、标题、代码块或其他内容。';

/**
 * 打开 Commit 描述时注入到主 Prompt 中的指令片段。
 */
export const DEFAULT_EXTENDED_DESCRIPTION_ENABLED_PROMPT =
  '需要生成 Commit 描述。description 字段必须返回简洁、清晰、允许换行的补充说明。';

/**
 * 关闭 Commit 描述时注入到主 Prompt 中的指令片段。
 */
export const DEFAULT_EXTENDED_DESCRIPTION_DISABLED_PROMPT =
  '不需要生成 Commit 描述。description 字段必须返回空字符串。';

/**
 * Commit Message 默认语言。
 */
export const DEFAULT_COMMIT_LANGUAGE = '简体中文';

/**
 * 扩展 UI 默认语言。
 */
export const DEFAULT_UI_LANGUAGE = 'zh-CN';

/**
 * 当前已经接入的 UI 语言列表。
 * 这里定义了设置页可选的全部 UI 语言。
 */
export const SUPPORTED_UI_LANGUAGES: readonly UiLanguageDefinition[] = [
  {
    code: 'zh-CN',
    label: '简体中文'
  },
  {
    code: 'en',
    label: 'English'
  }
];

/**
 * 支持自动检测的本地工具定义。
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    key: 'claudeCode',
    label: 'ClaudeCode',
    commandName: 'claude'
  },
  {
    key: 'codex',
    label: 'Codex',
    commandName: 'codex'
  },
  {
    key: 'geminiCli',
    label: 'Gemini CLI',
    commandName: 'gemini'
  }
];

/**
 * 读取当前工作区配置，并把设置页中的原始值规范化成扩展内部统一格式。
 */
export function getComitronConfig(): ComitronConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rawSelectedTool = config.get<SelectedToolSettingValue>('selectedTool', SELECTED_TOOL_SETTING_VALUES.custom);

  return {
    selectedTool: normalizeSelectedToolValue(rawSelectedTool),
    detectedTools: config.get<string[]>('detectedTools', []),
    toolPath: config.get<string>('toolPath', '').trim(),
    apiServiceJson: config.get<string>('apiServiceJson', '').trim(),
    promptTemplate: config.get<string>('promptTemplate', DEFAULT_PROMPT_TEMPLATE).trim() || DEFAULT_PROMPT_TEMPLATE,
    extendedDescriptionEnabledPrompt: config.get<string>('extendedDescriptionEnabledPrompt', DEFAULT_EXTENDED_DESCRIPTION_ENABLED_PROMPT).trim()
      || DEFAULT_EXTENDED_DESCRIPTION_ENABLED_PROMPT,
    extendedDescriptionDisabledPrompt: config.get<string>('extendedDescriptionDisabledPrompt', DEFAULT_EXTENDED_DESCRIPTION_DISABLED_PROMPT).trim()
      || DEFAULT_EXTENDED_DESCRIPTION_DISABLED_PROMPT,
    toolResponsePromptTemplate: config.get<string>('toolResponsePromptTemplate', DEFAULT_TOOL_RESPONSE_PROMPT_TEMPLATE).trim()
      || DEFAULT_TOOL_RESPONSE_PROMPT_TEMPLATE,
    commitLanguage: config.get<string>('commitLanguage', DEFAULT_COMMIT_LANGUAGE).trim() || DEFAULT_COMMIT_LANGUAGE,
    contextBudget: normalizeContextBudget(config.get<number>('contextBudget', 8192)),
    includeExtendedDescription: config.get<boolean>('includeExtendedDescription', false),
    uiLanguage: config.get<string>('uiLanguage', DEFAULT_UI_LANGUAGE).trim() || DEFAULT_UI_LANGUAGE
  };
}

/**
 * 返回 comitron 这一组原始配置对象。
 */
export function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/**
 * 生成完整设置键名。
 * 例如 toolPath 会被转换成 comitron.toolPath。
 */
export function getSettingKey<K extends keyof ComitronConfig>(key: K): `${typeof CONFIG_SECTION}.${K}` {
  return `${CONFIG_SECTION}.${key}`;
}

/**
 * 判断某个工具是否属于自动检测范围内的本地命令行工具。
 */
export function isKnownTool(toolName: AiToolName): toolName is KnownAiToolName {
  return toolName === 'codex' || toolName === 'claudeCode' || toolName === 'geminiCli';
}

/**
 * 把设置页保存的原始值转换成扩展内部统一使用的工具标识。
 * 这里同时兼容旧值和新值，保证升级后旧配置仍然可用。
 */
export function normalizeSelectedToolValue(value: string | undefined): AiToolName {
  switch (value) {
    case SELECTED_TOOL_SETTING_VALUES.codex:
    case 'codex':
      return 'codex';
    case SELECTED_TOOL_SETTING_VALUES.claudeCode:
    case 'claudeCode':
      return 'claudeCode';
    case SELECTED_TOOL_SETTING_VALUES.geminiCli:
    case 'geminiCli':
      return 'geminiCli';
    case SELECTED_TOOL_SETTING_VALUES.apiService:
    case 'apiService':
      return 'apiService';
    case SELECTED_TOOL_SETTING_VALUES.custom:
    case 'custom':
    default:
      return 'custom';
  }
}

/**
 * 把扩展内部工具标识转换成设置页需要保存的用户可见值。
 * 设置页只保存展示值，从而让下拉列表只显示一行文本。
 */
export function toSelectedToolSettingValue(toolName: AiToolName): SelectedToolSettingValue {
  return SELECTED_TOOL_SETTING_VALUES[toolName];
}

/**
 * 判断某个设置值是否属于旧版本遗留的内部值。
 * 只要命中这里，就应该迁移成新的显示值。
 */
export function isLegacySelectedToolSettingValue(value: unknown): value is AiToolName {
  return value === 'codex'
    || value === 'claudeCode'
    || value === 'geminiCli'
    || value === 'apiService'
    || value === 'custom';
}

/**
 * 规范化上下文预算。
 * 这里保证预算值始终落在允许区间内，并且一定是整数。
 */
function normalizeContextBudget(value: number): number {
  const safeValue = Number.isFinite(value) ? Math.floor(value) : 8192;
  return Math.min(65536, Math.max(512, safeValue));
}
