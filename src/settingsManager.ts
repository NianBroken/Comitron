import * as vscode from 'vscode';
import {
  CONFIG_SECTION,
  DEFAULT_UI_LANGUAGE,
  type AiToolName,
  type DetectedTool,
  getComitronConfig,
  getConfiguration,
  getSettingKey,
  isKnownTool,
  isLegacySelectedToolSettingValue,
  normalizeSelectedToolValue,
  SUPPORTED_UI_LANGUAGES,
  TOOL_DEFINITIONS,
  toSelectedToolSettingValue,
  type SelectedToolSettingValue
} from './config';
import { t } from './i18n';
import { info, infoObject, warn } from './logger';
import { findCommandInPath } from './toolRunner';

/**
 * 记录每个本地工具的手动路径。
 * 当自动检测不到某个工具时，扩展会从这里恢复用户手动填写过的路径。
 */
const MANUAL_TOOL_PATHS_STATE_KEY = 'comitron.manualToolPaths';

/**
 * 负责维护设置页联动行为。
 * 这里集中处理工具自动检测、默认工具选择、旧设置迁移和路径自动回填。
 */
export class SettingsManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly detectedToolMap = new Map<AiToolName, string>();
  private isApplying = false;

  constructor(
    private readonly context: vscode.ExtensionContext
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (!event.affectsConfiguration(CONFIG_SECTION) || this.isApplying) {
          return;
        }

        await this.handleConfigurationChange(event);
      })
    );
  }

  /**
   * 扩展启动时执行一次完整同步。
   * 这一步会先检测工具，再迁移旧配置，最后同步路径。
   */
  async initialize(): Promise<void> {
    info('开始同步设置页运行时状态。');
    await this.syncRuntimeState(true);
    info('设置页运行时状态同步完成。');
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  /**
   * 处理设置变化事件。
   * 当用户修改路径输入框时，会先记录手动路径，再重新计算其余联动状态。
   */
  private async handleConfigurationChange(event: vscode.ConfigurationChangeEvent): Promise<void> {
    const config = getComitronConfig();
    infoObject('检测到配置变化', {
      selectedTool: config.selectedTool,
      toolPath: config.toolPath || '[空]',
      uiLanguage: config.uiLanguage
    });

    if (event.affectsConfiguration(getSettingKey('uiLanguage'))) {
      await this.handleUiLanguageChange(config.uiLanguage);
    }

    if (event.affectsConfiguration(getSettingKey('toolPath'))) {
      info('检测到 Tool Path 变化，准备保存手动路径。');
      await this.persistManualToolPath(config.selectedTool, config.toolPath);
    }

    await this.syncRuntimeState(false, event);
  }

  /**
   * 同步扩展运行时状态。
   * 包含四件事：
   * 1. 读取本机工具；
   * 2. 写入工具列表；
   * 3. 迁移旧版 selectedTool 值；
   * 4. 根据当前工具选择自动回填路径。
   */
  private async syncRuntimeState(isInitial: boolean, event?: vscode.ConfigurationChangeEvent): Promise<void> {
    const detectedTools = await detectInstalledTools();
    infoObject('自动检测到的本地工具', detectedTools);

    this.detectedToolMap.clear();
    for (const tool of detectedTools) {
      this.detectedToolMap.set(tool.key, tool.path);
    }

    const configuration = getConfiguration();
    const config = getComitronConfig();
    const detectedToolList = detectedTools.map((tool) => `${tool.label} - ${tool.path}`);

    if (!sameStringArray(config.detectedTools, detectedToolList)) {
      await this.updateSetting('detectedTools', detectedToolList, vscode.ConfigurationTarget.Global);
    }

    await this.migrateLegacySelectedToolValue(configuration);

    const selectedToolInspection = configuration.inspect<SelectedToolSettingValue>('selectedTool');
    const hasExplicitSelectedTool = selectedToolInspection?.workspaceValue !== undefined
      || selectedToolInspection?.globalValue !== undefined
      || selectedToolInspection?.workspaceFolderValue !== undefined;

    const defaultTool = getDefaultSelectedTool(detectedTools);
    const defaultSettingValue = toSelectedToolSettingValue(defaultTool);
    info(`默认工具计算结果：${defaultTool}`);
    const nextConfig = getComitronConfig();

    if (!hasExplicitSelectedTool && toSelectedToolSettingValue(nextConfig.selectedTool) !== defaultSettingValue) {
      await this.updateRawSetting('selectedTool', defaultSettingValue, vscode.ConfigurationTarget.Global);
    }

    const supportedLanguageCodes = new Set(SUPPORTED_UI_LANGUAGES.map((language) => language.code));
    if (!supportedLanguageCodes.has(nextConfig.uiLanguage)) {
      await this.updateSetting('uiLanguage', DEFAULT_UI_LANGUAGE, vscode.ConfigurationTarget.Global);
    }

    const latestConfig = getComitronConfig();
    const selectedToolChanged = event?.affectsConfiguration('comitron.selectedTool') ?? isInitial;

    if (selectedToolChanged || isInitial) {
      info(`准备同步 Tool Path，当前工具：${latestConfig.selectedTool}`);
      await this.syncToolPath(latestConfig.selectedTool);
    }
  }

  /**
   * 把旧版 selectedTool 值迁移成设置页当前使用的显示值。
   * 这样下拉框只显示一行文本，不再出现主标题和副标题重复的问题。
   */
  private async migrateLegacySelectedToolValue(configuration: vscode.WorkspaceConfiguration): Promise<void> {
    const inspection = configuration.inspect<SelectedToolSettingValue>('selectedTool');

    if (isLegacySelectedToolSettingValue(inspection?.workspaceValue)) {
      info(`迁移工作区级旧工具值：${inspection.workspaceValue}`);
      await this.updateRawSetting(
        'selectedTool',
        toSelectedToolSettingValue(normalizeSelectedToolValue(inspection.workspaceValue)),
        vscode.ConfigurationTarget.Workspace
      );
    }

    if (isLegacySelectedToolSettingValue(inspection?.globalValue)) {
      info(`迁移全局级旧工具值：${inspection.globalValue}`);
      await this.updateRawSetting(
        'selectedTool',
        toSelectedToolSettingValue(normalizeSelectedToolValue(inspection.globalValue)),
        vscode.ConfigurationTarget.Global
      );
    }

    if (isLegacySelectedToolSettingValue(inspection?.workspaceFolderValue)) {
      info(`迁移工作区文件夹级旧工具值：${inspection.workspaceFolderValue}`);
      await this.updateRawSetting(
        'selectedTool',
        toSelectedToolSettingValue(normalizeSelectedToolValue(inspection.workspaceFolderValue)),
        vscode.ConfigurationTarget.WorkspaceFolder
      );
    }
  }

  /**
   * 根据当前工具选择同步路径输入框内容。
   * 已检测到的工具直接回填系统路径；未检测到的工具回填手动保存路径；自定义和 API 服务清空路径框。
   */
  private async syncToolPath(selectedTool: AiToolName): Promise<void> {
    const config = getComitronConfig();
    const currentPath = config.toolPath;
    info(`开始同步 Tool Path。selectedTool=${selectedTool}，currentPath=${currentPath || '[空]'}`);

    if (selectedTool === 'custom' || selectedTool === 'apiService') {
      if (currentPath !== '') {
        info('当前工具是自定义或 API 服务，清空 Tool Path。');
        await this.updateSetting('toolPath', '', vscode.ConfigurationTarget.Global);
      }
      return;
    }

    const detectedPath = this.detectedToolMap.get(selectedTool);

    if (detectedPath) {
      if (currentPath !== detectedPath) {
        info(`使用自动检测路径回填 Tool Path：${detectedPath}`);
        await this.updateSetting('toolPath', detectedPath, vscode.ConfigurationTarget.Global);
      }
      return;
    }

    const manualPaths = this.context.globalState.get<Record<string, string>>(MANUAL_TOOL_PATHS_STATE_KEY, {});
    const manualPath = manualPaths[selectedTool] ?? '';

    if (currentPath !== manualPath) {
      info(`使用缓存的手动路径回填 Tool Path：${manualPath || '[空]'}`);
      await this.updateSetting('toolPath', manualPath, vscode.ConfigurationTarget.Global);
    }
  }

  /**
   * 保存用户对本地工具手动填写的路径。
   * 只有在路径不是自动检测结果时，才会写入缓存。
   */
  private async persistManualToolPath(selectedTool: AiToolName, toolPath: string): Promise<void> {
    if (!isKnownTool(selectedTool) || !toolPath) {
      warn(`跳过手动路径保存。selectedTool=${selectedTool}，toolPath=${toolPath || '[空]'}`);
      return;
    }

    const detectedPath = this.detectedToolMap.get(selectedTool);

    if (detectedPath && detectedPath === toolPath) {
      info('当前路径与自动检测路径一致，不记录为手动路径。');
      return;
    }

    const manualPaths = this.context.globalState.get<Record<string, string>>(MANUAL_TOOL_PATHS_STATE_KEY, {});
    manualPaths[selectedTool] = toolPath;
    info(`记录手动路径。tool=${selectedTool}，path=${toolPath}`);
    await this.context.globalState.update(MANUAL_TOOL_PATHS_STATE_KEY, manualPaths);
  }

  /**
   * 更新运行时配置对象中已声明的标准设置项。
   */
  private async updateSetting<K extends keyof ReturnType<typeof getComitronConfig>>(
    key: K,
    value: ReturnType<typeof getComitronConfig>[K],
    target: vscode.ConfigurationTarget
  ): Promise<void> {
    this.isApplying = true;

    try {
      await getConfiguration().update(key, value, target);
    } finally {
      this.isApplying = false;
    }
  }

  /**
   * 更新设置页中的原始值。
   * 这个方法专门用于 selectedTool 这类“显示值”和“内部值”不同的配置。
   */
  private async updateRawSetting(
    key: 'selectedTool',
    value: SelectedToolSettingValue,
    target: vscode.ConfigurationTarget
  ): Promise<void> {
    this.isApplying = true;

    try {
      await getConfiguration().update(key, value, target);
    } finally {
      this.isApplying = false;
    }
  }

  /**
   * 处理扩展自身的 UI 语言变化。
   * 运行时文本会立即跟随这个设置；设置页文本则仍然跟随 VS Code 显示语言。
   */
  private async handleUiLanguageChange(uiLanguage: string): Promise<void> {
    info(`检测到 Ui Language 变化：${uiLanguage}`);

    const expectedDisplayLanguage = uiLanguage === 'en' ? 'en' : 'zh';

    if (!vscode.env.language.toLowerCase().startsWith(expectedDisplayLanguage.toLowerCase())) {
      const action = await vscode.window.showInformationMessage(
        t('运行时语言已更新。若要让设置页语言也切换，请修改 VS Code 显示语言。'),
        t('配置显示语言')
      );

      if (action) {
        await vscode.commands.executeCommand('workbench.action.configureLocale');
      }
    }
  }
}

/**
 * 扫描系统 PATH，读取当前机器上已安装的三个目标工具。
 */
export async function detectInstalledTools(): Promise<DetectedTool[]> {
  const results: DetectedTool[] = [];

  for (const definition of TOOL_DEFINITIONS) {
    const detectedPath = await findCommandInPath(definition.commandName);

    if (!detectedPath) {
      warn(`未在 PATH 中检测到工具：${definition.label}`);
      continue;
    }

    results.push({
      key: definition.key,
      label: definition.label,
      path: detectedPath
    });
  }

  return results.sort((left, right) => left.label.localeCompare(right.label, 'en'));
}

/**
 * 按需求规则计算默认工具。
 * 规则是：
 * 1. 优先 Codex；
 * 2. 没有 Codex 时按名称字母顺序取最靠前的工具；
 * 3. 一个都没有时选择自定义。
 */
function getDefaultSelectedTool(detectedTools: readonly DetectedTool[]): AiToolName {
  const codex = detectedTools.find((tool) => tool.key === 'codex');

  if (codex) {
    return 'codex';
  }

  if (detectedTools.length === 0) {
    return 'custom';
  }

  return detectedTools
    .slice()
    .sort((left, right) => left.label.localeCompare(right.label, 'en'))[0]
    .key;
}

/**
 * 比较两个字符串数组是否完全一致。
 * 只有当内容真的变化时，才写回设置，避免无意义触发设置刷新。
 */
function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}
