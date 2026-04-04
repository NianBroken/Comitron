import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { t } from './i18n';
import { type ComitronConfig, type KnownAiToolName } from './config';
import { error as logError, info, infoObject, warn } from './logger';

/**
 * 单条候选 Commit Message 的标准结构。
 * title 用于提交标题，description 用于 Commit 描述。
 */
export interface CommitMessageCandidate {
  title: string;
  description: string;
}

/**
 * 与路径相关的错误基类。
 * toolName 用于告诉用户当前是哪一个工具出了问题。
 */
class ToolPathError extends Error {
  constructor(
    public readonly toolName: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * 工具路径缺失时抛出的错误。
 */
export class ToolPathMissingError extends ToolPathError {}

/**
 * 工具路径无效时抛出的错误。
 * configuredPath 会原样带回给界面层，用于错误提示。
 */
export class ToolPathInvalidError extends ToolPathError {
  constructor(toolName: string, public readonly configuredPath: string) {
    super(toolName, t('设置中的路径无效：{0}', configuredPath));
  }
}

/**
 * API 服务配置错误。
 * 这里单独定义一个类型，方便和普通执行错误区分。
 */
class ApiServiceConfigError extends Error {}

/**
 * API 服务模式最终解析出的配置对象。
 */
interface ApiServiceConfig {
  apiUrl: string;
  apiKey: string;
  modelId: string;
  customParameters: Record<string, unknown>;
}

/**
 * 单次工具调用后的校验结果。
 * valid 为 true 时 candidates 一定可用；否则 error 中会带上失败原因。
 */
interface ValidationResult {
  valid: boolean;
  candidates?: CommitMessageCandidate[];
  error?: Error;
}

/**
 * 约束 AI 返回结果的 JSON Schema。
 * 无论底层是本地工具还是 API 服务，最终都必须遵守这个结构。
 */
const COMMIT_MESSAGE_SCHEMA = {
  type: 'object',
  required: ['messages'],
  additionalProperties: false,
  properties: {
    messages: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        required: ['title', 'description'],
        additionalProperties: false,
        properties: {
          title: {
            type: 'string',
            minLength: 1
          },
          description: {
            type: 'string'
          }
        }
      }
    }
  }
} as const;

/**
 * 已知本地工具的静态元数据。
 * label 用于错误提示，commandName 用于系统 PATH 检测。
 */
const KNOWN_TOOL_METADATA: Record<KnownAiToolName, { label: string; commandName: string }> = {
  codex: {
    label: 'Codex',
    commandName: 'codex'
  },
  claudeCode: {
    label: 'ClaudeCode',
    commandName: 'claude'
  },
  geminiCli: {
    label: 'Gemini CLI',
    commandName: 'gemini'
  }
};

/**
 * 当工具第一次输出不符合 Schema 时，最多再执行两次修正请求。
 * 这样所有 AI 都具备“Schema 或类似 Schema”的能力。
 */
const MAX_GENERATION_ATTEMPTS = 3;

/**
 * 统一的候选生成入口。
 * 这里先为所有工具构建同一套输出约束，再执行、校验，并在失败时自动发起修正重试。
 */
export async function generateCommitMessageCandidates(
  prompt: string,
  workingDirectory: string,
  config: ComitronConfig
): Promise<CommitMessageCandidate[]> {
  const toolConstraintPrompt = buildToolConstraintPrompt(config.toolResponsePromptTemplate);
  let latestRawOutput = '';
  let latestError: Error | undefined;

  infoObject('生成入口参数', {
    tool: config.selectedTool,
    workingDirectory,
    promptLength: prompt.length,
    toolConstraintPromptLength: toolConstraintPrompt.length
  });
  info(`工具响应 Prompt：\n${toolConstraintPrompt}`);

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
    info(`开始第 ${attempt} 次生成尝试。`);

    const currentPrompt = attempt === 1
      ? prompt
      : buildRepairPrompt(prompt, latestRawOutput, latestError);

    info(`第 ${attempt} 次尝试使用的主输入长度：${currentPrompt.length}`);
    info(`第 ${attempt} 次尝试主输入：\n${currentPrompt}`);

    const rawOutput = await runSelectedTool(currentPrompt, toolConstraintPrompt, workingDirectory, config);
    latestRawOutput = rawOutput;

    info(`第 ${attempt} 次尝试的原始输出长度：${rawOutput.length}`);
    info(`第 ${attempt} 次尝试的原始输出：\n${rawOutput}`);

    const validation = validateCandidates(rawOutput);

    if (validation.valid && validation.candidates) {
      info(`第 ${attempt} 次尝试校验通过。`);
      return validation.candidates;
    }

    latestError = validation.error;
    warn(`第 ${attempt} 次尝试校验失败：${latestError?.message ?? '未知错误'}`);
  }

  logError('多次生成尝试后仍未得到合法结果。', latestError);
  throw latestError ?? new Error(t('AI 工具没有返回 3 条候选 Commit Message。'));
}

/**
 * 通过 Windows 的 where.exe 在 PATH 中查找命令真实路径。
 */
export async function findCommandInPath(commandName: string): Promise<string | undefined> {
  try {
    info(`开始在 PATH 中查找命令：${commandName}`);

    const result = await runProcess(
      'where.exe',
      [commandName],
      process.cwd(),
      ''
    );

    const detectedPath = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    info(`PATH 查找结果：${commandName} -> ${detectedPath ?? '[未找到]'}`);
    return detectedPath;
  } catch {
    warn(`PATH 查找失败：${commandName}`);
    return undefined;
  }
}

/**
 * 根据设置中当前选择的工具分发到具体执行器。
 * 这里所有工具都会收到同一条 Tool Response Prompt。
 */
async function runSelectedTool(
  prompt: string,
  toolConstraintPrompt: string,
  workingDirectory: string,
  config: ComitronConfig
): Promise<string> {
  info(`开始分发到工具执行器。tool=${config.selectedTool}`);

  switch (config.selectedTool) {
    case 'codex':
    case 'claudeCode':
    case 'geminiCli': {
      const executablePath = await resolveKnownToolPath(config.selectedTool, config.toolPath);
      return runKnownTool(config.selectedTool, executablePath, prompt, toolConstraintPrompt, workingDirectory);
    }
    case 'custom': {
      if (!config.toolPath) {
        throw new ToolPathMissingError('自定义工具', t('未找到 {0}。请在设置中填写路径。', '自定义工具'));
      }

      if (!(await pathExists(config.toolPath))) {
        throw new ToolPathInvalidError('自定义工具', config.toolPath);
      }

      const customToolKind = inferCustomToolKind(config.toolPath);

      if (!customToolKind) {
        throw new Error(t('自定义路径必须指向 Codex、ClaudeCode 或 Gemini CLI 的可执行文件。'));
      }

      return runKnownTool(customToolKind, config.toolPath, prompt, toolConstraintPrompt, workingDirectory);
    }
    case 'apiService':
      return runApiService(prompt, toolConstraintPrompt, config.apiServiceJson);
  }
}

/**
 * 解析已知本地工具最终要执行的路径。
 * 用户手动填了路径时优先使用手动路径，否则退回到系统自动检测结果。
 */
async function resolveKnownToolPath(toolName: KnownAiToolName, configuredPath: string): Promise<string> {
  const metadata = KNOWN_TOOL_METADATA[toolName];
  info(`开始解析工具路径。tool=${metadata.label}，configuredPath=${configuredPath || '[空]'}`);

  if (configuredPath) {
    if (await pathExists(configuredPath)) {
      info(`使用设置中的工具路径：${configuredPath}`);
      return configuredPath;
    }

    throw new ToolPathInvalidError(metadata.label, configuredPath);
  }

  const detectedPath = await findCommandInPath(metadata.commandName);

  if (detectedPath) {
    info(`使用自动检测到的工具路径：${detectedPath}`);
    return detectedPath;
  }

  throw new ToolPathMissingError(metadata.label, t('未找到 {0}。请在设置中填写路径。', metadata.label));
}

/**
 * 根据工具类型调用对应执行实现。
 * 不同工具的能力不同，但现在都会吃到同一条 Tool Response Prompt。
 */
async function runKnownTool(
  toolName: KnownAiToolName,
  executablePath: string,
  prompt: string,
  toolConstraintPrompt: string,
  workingDirectory: string
): Promise<string> {
  info(`开始调用已知工具。tool=${toolName}，executablePath=${executablePath}`);

  if (toolName === 'codex') {
    return runCodex(executablePath, prompt, toolConstraintPrompt, workingDirectory);
  }

  if (toolName === 'claudeCode') {
    return runClaudeCode(executablePath, prompt, toolConstraintPrompt, workingDirectory);
  }

  return runGeminiCli(executablePath, prompt, toolConstraintPrompt, workingDirectory);
}

/**
 * 以非交互模式调用 Codex，并通过 --output-schema 提供原生 Schema 约束。
 * 同时，把 Tool Response Prompt 拼进标准输入，让 Codex 也与其他工具保持一致。
 */
async function runCodex(
  executablePath: string,
  prompt: string,
  toolConstraintPrompt: string,
  workingDirectory: string
): Promise<string> {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'comitron-codex-'));
  const schemaPath = path.join(tempDirectory, 'schema.json');
  const outputPath = path.join(tempDirectory, 'result.json');
  const finalPrompt = `${toolConstraintPrompt}\n\n${prompt}`;

  try {
    infoObject('Codex 执行参数', {
      executablePath,
      workingDirectory,
      schemaPath,
      outputPath
    });

    await fs.writeFile(schemaPath, JSON.stringify(COMMIT_MESSAGE_SCHEMA), 'utf8');

    await runProcess(
      executablePath,
      [
        'exec',
        '-',
        '--skip-git-repo-check',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--color',
        'never',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath
      ],
      workingDirectory,
      finalPrompt
    );

    info('Codex 执行完成，开始读取结果文件。');
    return await fs.readFile(outputPath, 'utf8');
  } finally {
    info('清理 Codex 临时目录。');
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * 调用 ClaudeCode。
 * 这里不再依赖当前 CLI 是否存在原生 Schema 参数，而是统一通过 Tool Response Prompt + 结果校验重试实现类似 Schema 的能力。
 */
async function runClaudeCode(
  executablePath: string,
  prompt: string,
  toolConstraintPrompt: string,
  workingDirectory: string
): Promise<string> {
  infoObject('ClaudeCode 执行参数', {
    executablePath,
    workingDirectory
  });

  const result = await runProcess(
    executablePath,
    [
      '-p',
      toolConstraintPrompt
    ],
    workingDirectory,
    prompt
  );

  return result.stdout;
}

/**
 * 调用 Gemini CLI。
 * Gemini 继续使用 JSON 输出模式，但模型真正需要遵守的结构约束由 Tool Response Prompt 提供。
 */
async function runGeminiCli(
  executablePath: string,
  prompt: string,
  toolConstraintPrompt: string,
  workingDirectory: string
): Promise<string> {
  infoObject('Gemini CLI 执行参数', {
    executablePath,
    workingDirectory
  });

  const result = await runProcess(
    executablePath,
    [
      '-p',
      toolConstraintPrompt,
      '--output-format',
      'json'
    ],
    workingDirectory,
    prompt
  );

  const payload = JSON.parse(result.stdout) as { response?: string };
  return payload.response ?? '';
}

/**
 * 调用用户配置的 API 服务。
 * Tool Response Prompt 会作为 system 消息传入，主 Prompt 会作为 user 消息传入。
 * 这样 API 服务现在也能使用同一套输出约束和 Schema 风格约束。
 */
async function runApiService(prompt: string, toolConstraintPrompt: string, rawConfig: string): Promise<string> {
  const apiConfig = parseApiServiceConfig(rawConfig);

  infoObject('API 服务执行参数', {
    apiUrl: apiConfig.apiUrl,
    modelId: apiConfig.modelId,
    customParameters: apiConfig.customParameters
  });

  const response = await fetch(apiConfig.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey}`
    },
    body: JSON.stringify({
      model: apiConfig.modelId,
      messages: [
        {
          role: 'system',
          content: toolConstraintPrompt
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      ...apiConfig.customParameters
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = await response.json() as Record<string, unknown>;
  const content = extractApiResponseText(payload);

  if (!content) {
    throw new Error(t('API 服务返回了空结果。'));
  }

  return content;
}

/**
 * 构建所有 AI 统一使用的补充约束 Prompt。
 * 它同时包含：
 * 1. 用户可配置的 Tool Response Prompt；
 * 2. 明确的 Schema 风格结构要求；
 * 3. 实际的 JSON Schema 文本。
 */
function buildToolConstraintPrompt(toolResponsePromptTemplate: string): string {
  return [
    toolResponsePromptTemplate,
    '',
    '你必须严格返回符合以下 JSON Schema 的 JSON。',
    '禁止输出解释、禁止输出 Markdown 代码块、禁止输出额外字段。',
    JSON.stringify(COMMIT_MESSAGE_SCHEMA, null, 2)
  ].join('\n');
}

/**
 * 当工具第一次输出不符合要求时，构建修正 Prompt。
 * 这一步相当于给所有没有原生 Schema 能力的工具增加一层“自动修正”的类似能力。
 */
function buildRepairPrompt(originalPrompt: string, invalidOutput: string, latestError: Error | undefined): string {
  const errorMessage = latestError?.message ?? '结果不符合要求。';

  return [
    originalPrompt,
    '',
    '你刚才返回的结果不符合要求，请直接修正。',
    `错误原因：${errorMessage}`,
    '下面是你刚才返回的原始结果，请基于它重新输出合法 JSON：',
    invalidOutput
  ].join('\n');
}

/**
 * 把工具输出校验成候选数组。
 * 只要校验失败，就返回明确错误，供重试逻辑继续使用。
 */
function validateCandidates(rawOutput: string): ValidationResult {
  try {
    info('开始校验 AI 输出。');

    return {
      valid: true,
      candidates: parseCandidates(rawOutput)
    };
  } catch (error) {
    warn(`AI 输出校验失败：${error instanceof Error ? error.message : String(error)}`);

    return {
      valid: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}

/**
 * 把设置页中的 API 服务 JSON 解析成结构化对象。
 * 这里固定要求 4 个键：API地址、API密钥、模型ID、自定义参数。
 */
function parseApiServiceConfig(rawConfig: string): ApiServiceConfig {
  if (!rawConfig.trim()) {
    throw new ApiServiceConfigError(t('API 服务配置不能为空。'));
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(rawConfig) as Record<string, unknown>;
  } catch {
    throw new ApiServiceConfigError(t('API 服务配置不是合法 JSON。'));
  }

  const apiUrl = readStringField(parsed, ['API地址', 'apiUrl']);
  const apiKey = readStringField(parsed, ['API密钥', 'apiKey']);
  const modelId = readStringField(parsed, ['模型ID', 'modelId']);
  const customParametersValue = parsed['自定义参数'] ?? parsed.customParameters ?? {};

  if (!apiUrl) {
    throw new ApiServiceConfigError(t('API 服务配置缺少 {0}。', 'API地址'));
  }

  if (!apiKey) {
    throw new ApiServiceConfigError(t('API 服务配置缺少 {0}。', 'API密钥'));
  }

  if (!modelId) {
    throw new ApiServiceConfigError(t('API 服务配置缺少 {0}。', '模型ID'));
  }

  return {
    apiUrl,
    apiKey,
    modelId,
    customParameters: isPlainObject(customParametersValue) ? customParametersValue : {}
  };
}

/**
 * 从不同风格的 API 响应对象中提取文本内容。
 * 这里只做最常见格式兼容，不扩展额外协议。
 */
function extractApiResponseText(payload: Record<string, unknown>): string {
  const choices = payload.choices;

  if (Array.isArray(choices) && choices.length > 0) {
    const firstChoice = choices[0] as Record<string, unknown>;
    const message = firstChoice.message as Record<string, unknown> | undefined;
    const content = message?.content;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }

          if (isPlainObject(item) && typeof item.text === 'string') {
            return item.text;
          }

          return '';
        })
        .join('\n')
        .trim();
    }
  }

  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }

  if (typeof payload.text === 'string') {
    return payload.text;
  }

  return '';
}

/**
 * 按给定字段名顺序读取字符串字段。
 * 只返回非空字符串，空值和空白字符串都会被忽略。
 */
function readStringField(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

/**
 * 根据自定义路径文件名推断它属于哪一种已知工具。
 */
function inferCustomToolKind(toolPath: string): KnownAiToolName | undefined {
  const lowerCaseName = path.basename(toolPath).toLowerCase();

  if (lowerCaseName.includes('codex')) {
    return 'codex';
  }

  if (lowerCaseName.includes('claude')) {
    return 'claudeCode';
  }

  if (lowerCaseName.includes('gemini')) {
    return 'geminiCli';
  }

  return undefined;
}

/**
 * 判断某个路径在文件系统中是否真实存在。
 */
async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    info(`路径存在：${targetPath}`);
    return true;
  } catch {
    warn(`路径不存在：${targetPath}`);
    return false;
  }
}

/**
 * 启动子进程并收集完整的标准输出和标准错误。
 * 这里只负责执行，不解释命令含义。
 */
async function runProcess(
  executablePath: string,
  args: string[],
  workingDirectory: string,
  stdinText: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    infoObject('启动子进程', {
      executablePath,
      args,
      workingDirectory,
      stdinLength: stdinText.length
    });

    const child = spawn(executablePath, args, {
      cwd: workingDirectory,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: Error) => {
      logError(`子进程启动失败：${executablePath}`, error);
      reject(error);
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        infoObject('子进程执行成功', {
          executablePath,
          code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length
        });
        resolve({ stdout, stderr });
        return;
      }

      const finalError = new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code}`);
      logError(`子进程执行失败：${executablePath}`, finalError);
      reject(finalError);
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }

    child.stdin.end();
  });
}

/**
 * 解析工具返回的 JSON 文本，并校验候选条数是否正好为 3。
 */
function parseCandidates(rawOutput: string): CommitMessageCandidate[] {
  const jsonText = extractJsonText(rawOutput);
  info(`提取到的 JSON 文本长度：${jsonText.length}`);

  try {
    const parsed = JSON.parse(jsonText) as { messages?: CommitMessageCandidate[] };
    const messages = parsed.messages ?? [];

    if (messages.length !== 3) {
      throw new Error(t('AI 工具没有返回 3 条候选 Commit Message。'));
    }

    return messages.map((message) => ({
      title: normalizeLine(message.title),
      description: normalizeMultilineText(message.description)
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(t('无法从 AI 输出中解析结果：{0}', reason));
  }
}

/**
 * 从可能带有代码块包裹的返回文本中截取 JSON 主体。
 */
function extractJsonText(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');

  if (start === -1 || end === -1 || end < start) {
    return withoutFence;
  }

  return withoutFence.slice(start, end + 1);
}

/**
 * 规范化单行标题文本。
 * 这里会压缩多余空白，避免标题中混入换行或重复空格。
 */
function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * 规范化多行描述文本。
 * 每一行都会先去掉首尾空白，再重新按换行拼接。
 */
function normalizeMultilineText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * 判断某个值是否为普通对象。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
