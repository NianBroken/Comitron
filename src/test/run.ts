import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  CONTEXT_BUDGET_DEFAULT,
  CONTEXT_BUDGET_MAX,
  CONTEXT_BUDGET_MIN,
  normalizeContextBudget
} from '../contextBudget';
import { createNonApiToolInvocationOptions } from '../nonApiThinking';
import { parseApiServiceConfig } from '../apiServiceConfig';
import { inferCustomToolKind } from '../customToolKind';

async function main(): Promise<void> {
  await testContextBudgetNormalization();
  await testCodexThinkingOverride();
  await testClaudeThinkingOverride();
  await testGeminiThinkingOverride();
  await testApiServiceConfigUnaffected();
  await testApiServiceValidation();
  await testCustomToolKindInference();
  await testPackageApiDefaults();
  process.stdout.write('All tests passed.\n');
}

async function testContextBudgetNormalization(): Promise<void> {
  assert.equal(CONTEXT_BUDGET_DEFAULT, 65_536);
  assert.equal(CONTEXT_BUDGET_MIN, 32_768);
  assert.equal(CONTEXT_BUDGET_MAX, 131_072);
  assert.equal(normalizeContextBudget(CONTEXT_BUDGET_DEFAULT), 65_536);
  assert.equal(normalizeContextBudget(CONTEXT_BUDGET_MIN - 1), 32_768);
  assert.equal(normalizeContextBudget(CONTEXT_BUDGET_MAX + 1), 131_072);
  assert.equal(normalizeContextBudget(Number.NaN), 65_536);
  assert.equal(normalizeContextBudget(65_536.9), 65_536);
}

async function testCodexThinkingOverride(): Promise<void> {
  const options = await createNonApiToolInvocationOptions('codex');
  assert.deepEqual(options.args, [
    '-c',
    'model_reasoning_effort="none"',
    '-c',
    'model_reasoning_summary="none"'
  ]);
  assert.equal(options.env.MAX_THINKING_TOKENS, undefined);
  assert.equal(options.cleanup, undefined);
}

async function testClaudeThinkingOverride(): Promise<void> {
  const options = await createNonApiToolInvocationOptions('claudeCode');
  assert.deepEqual(options.args, []);
  assert.equal(options.env.MAX_THINKING_TOKENS, '0');
  assert.equal(options.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  assert.equal(options.cleanup, undefined);
}

async function testGeminiThinkingOverride(): Promise<void> {
  const options = await createNonApiToolInvocationOptions('geminiCli');
  const settingsPath = options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;

  assert.deepEqual(options.args, []);
  assert.ok(settingsPath);
  assert.equal(path.basename(settingsPath), 'settings.json');
  assert.ok(typeof options.cleanup === 'function');

  const content = await fs.readFile(settingsPath, 'utf8');
  const parsed = JSON.parse(content) as {
    model?: {
      name?: string;
    };
    modelConfigs?: {
      overrides?: Array<{
        match?: { model?: string };
        modelConfig?: {
          generateContentConfig?: {
            thinkingConfig?: {
              thinkingBudget?: number;
              includeThoughts?: boolean;
            };
          };
        };
      }>;
    };
  };

  assert.ok(Array.isArray(parsed.modelConfigs?.overrides));
  assert.equal(parsed.model?.name, '${GEMINI_MODEL:-${GEMINI_MODEL_NAME:-}}');
  assert.equal(parsed.modelConfigs?.overrides?.length, 1);
  for (const override of parsed.modelConfigs?.overrides ?? []) {
    assert.equal(override.match?.model, '${GEMINI_MODEL:-${GEMINI_MODEL_NAME:-}}');
    assert.equal(override.modelConfig?.generateContentConfig?.thinkingConfig?.thinkingBudget, 0);
    assert.equal(override.modelConfig?.generateContentConfig?.thinkingConfig?.includeThoughts, false);
  }

  await options.cleanup?.();
  await assert.rejects(async () => fs.access(settingsPath));
}

async function testApiServiceConfigUnaffected(): Promise<void> {
  const config = parseApiServiceConfig(JSON.stringify({
    API地址: 'https://api.openai.com/v1/chat/completions',
    API密钥: 'sk-real-key',
    模型ID: 'gpt-5-mini',
    自定义参数: {
      temperature: 0.2,
      top_p: 0.9
    }
  }), (message, ...args) => formatMessage(message, ...args));

  assert.equal(config.apiUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(config.modelId, 'gpt-5-mini');
  assert.deepEqual(config.customParameters, {
    temperature: 0.2,
    top_p: 0.9
  });
}

async function testApiServiceValidation(): Promise<void> {
  assert.throws(
    () => parseApiServiceConfig('', (message, ...args) => formatMessage(message, ...args)),
    /API 服务配置不能为空/
  );

  assert.throws(
    () => parseApiServiceConfig(JSON.stringify({
      API地址: 'https://api.openai.com/v1/chat/completions',
      API密钥: 'sk-real-key',
      模型ID: 'gpt-5-mini',
      自定义参数: {
        model: 'bad'
      }
    }), (message, ...args) => formatMessage(message, ...args)),
    /不能覆盖 model 字段/
  );
}

async function testCustomToolKindInference(): Promise<void> {
  assert.equal(inferCustomToolKind('C:/tools/codex.exe'), 'codex');
  assert.equal(inferCustomToolKind('C:/tools/claude.cmd'), 'claudeCode');
  assert.equal(inferCustomToolKind('C:/tools/gemini.bat'), 'geminiCli');
  assert.equal(inferCustomToolKind('C:/tools/unknown.exe'), undefined);
}

async function testPackageApiDefaults(): Promise<void> {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
    contributes?: {
      configuration?: {
        properties?: {
          'comitron.apiServiceJson'?: {
            default?: string;
          };
        };
      };
    };
  };
  const rawDefault = packageJson.contributes?.configuration?.properties?.['comitron.apiServiceJson']?.default;

  assert.ok(rawDefault);
  const parsedDefault = JSON.parse(rawDefault ?? '{}') as Record<string, unknown>;
  assert.equal(parsedDefault['API地址'], '');
  assert.equal(parsedDefault['API密钥'], '');
  assert.equal(parsedDefault['模型ID'], '');
  assert.deepEqual(parsedDefault['自定义参数'], {});
}

function formatMessage(message: string, ...args: string[]): string {
  return message.replace(/\{(\d+)\}/g, (_, indexText: string) => args[Number(indexText)] ?? `{${indexText}}`);
}

void main().catch((error: unknown) => {
  const finalError = error instanceof Error ? error : new Error(String(error));
  process.stderr.write(`${finalError.stack ?? finalError.message}\n`);
  process.exitCode = 1;
});
