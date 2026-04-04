import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * 运行时语言包缓存。
 * key 为语言代码，value 为该语言下的翻译键值表。
 */
const bundles = new Map<string, Record<string, string>>();

/**
 * 支持的运行时语言代码。
 */
const SUPPORTED_LANGUAGES = new Set(['zh-CN', 'en']);

/**
 * 初始化运行时本地化资源。
 * 这里单独读取 l10n 目录下的 JSON 文件，让插件运行时文案可以跟随扩展自己的设置项切换。
 */
export async function initializeI18n(extensionPath: string): Promise<void> {
  const zhBundlePath = path.join(extensionPath, 'l10n', 'bundle.l10n.json');
  const enBundlePath = path.join(extensionPath, 'l10n', 'bundle.l10n.en.json');

  bundles.set('zh-CN', await readBundle(zhBundlePath));
  bundles.set('en', await readBundle(enBundlePath));
}

/**
 * 按当前扩展设置返回翻译文本。
 * 如果未找到翻译，回退到原始文本。
 */
export function t(message: string, ...args: Array<string | number>): string {
  const language = getCurrentLanguage();
  const bundle = bundles.get(language) ?? {};
  const template = bundle[message] ?? message;

  return template.replace(/\{(\d+)\}/g, (_, indexText: string) => {
    const index = Number(indexText);
    const replacement = args[index];
    return replacement === undefined ? `{${index}}` : String(replacement);
  });
}

/**
 * 读取当前扩展设置中的 UI 语言。
 */
export function getCurrentLanguage(): 'zh-CN' | 'en' {
  const configuredLanguage = vscode.workspace
    .getConfiguration('comitron')
    .get<string>('uiLanguage', 'zh-CN');

  return SUPPORTED_LANGUAGES.has(configuredLanguage) ? configuredLanguage as 'zh-CN' | 'en' : 'zh-CN';
}

/**
 * 读取单个语言包文件。
 * 如果读取失败，则返回空对象，后续自动回退到原始文本。
 */
async function readBundle(filePath: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as Record<string, string>;
  } catch {
    return {};
  }
}
