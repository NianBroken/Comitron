import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KnownAiToolName } from './config';

/**
 * 单次本地工具调用时附带的临时覆盖。
 * 这里只允许影响当前插件子进程，不回写任何全局配置。
 */
export interface NonApiToolInvocationOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup?: () => Promise<void>;
}

const GEMINI_SETTINGS_FILE_NAME = 'settings.json';

/**
 * 为非 API 服务构造本次调用专用的临时思考关闭参数。
 * 这些参数和环境变量只注入当前子进程，不触碰用户全局配置。
 */
export async function createNonApiToolInvocationOptions(
  toolName: KnownAiToolName
): Promise<NonApiToolInvocationOptions> {
  if (toolName === 'codex') {
    return {
      args: [
        '-c',
        'model_reasoning_effort="none"',
        '-c',
        'model_reasoning_summary="none"'
      ],
      env: { ...process.env }
    };
  }

  if (toolName === 'claudeCode') {
    return {
      args: [],
      env: {
        ...process.env,
        MAX_THINKING_TOKENS: '0'
      }
    };
  }

  const geminiSettings = await createGeminiSettingsFile();
  return {
    args: [],
    env: {
      ...process.env,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: geminiSettings.settingsPath
    },
    cleanup: geminiSettings.cleanup
  };
}

/**
 * 为 Gemini CLI 生成一次性设置文件。
 * 这里只写入关闭思考所需的最小配置，文件由系统临时目录承载。
 */
export async function createGeminiSettingsFile(): Promise<{
  settingsPath: string;
  cleanup: () => Promise<void>;
}> {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'comitron-gemini-'));
  const settingsPath = path.join(tempDirectory, GEMINI_SETTINGS_FILE_NAME);
  const settings = {
    $schema: 'https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json',
    model: {
      name: '${GEMINI_MODEL:-${GEMINI_MODEL_NAME:-}}'
    },
    modelConfigs: {
      overrides: [
        {
          match: {
            model: '${GEMINI_MODEL:-${GEMINI_MODEL_NAME:-}}'
          },
          modelConfig: {
            generateContentConfig: {
              thinkingConfig: {
                thinkingBudget: 0,
                includeThoughts: false
              }
            }
          }
        }
      ]
    }
  };

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return {
    settingsPath,
    cleanup: async () => {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  };
}
