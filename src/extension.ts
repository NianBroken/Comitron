import * as vscode from 'vscode';
import { CandidateViewProvider } from './candidateView';
import { buildPromptContext, collectChangedFiles } from './changeCollector';
import { getComitronConfig } from './config';
import { getGitApi, type Repository } from './git';
import { initializeI18n, t } from './i18n';
import { disposeLogger, error as logError, info, infoObject, initializeLogger, showLogger, warn } from './logger';
import { SettingsManager } from './settingsManager';
import { captureMonotonicTimestamp, formatElapsedDuration, measureElapsedMilliseconds } from './time';
import {
  generateCommitMessageCandidates,
  type CommitMessageCandidate,
  ToolPathInvalidError,
  ToolPathMissingError
} from './toolRunner';

/**
 * 当前这一次生成出的候选结果会话。
 * 这里保存候选内容、所属仓库和 Commit 描述开关状态，供面板点击时直接回填。
 */
interface CandidateSession {
  repository: Repository;
  candidates: CommitMessageCandidate[];
  includeExtendedDescription: boolean;
}

let settingsManager: SettingsManager | undefined;
let candidateViewProvider: CandidateViewProvider | undefined;
let candidateSession: CandidateSession | undefined;

/**
 * 扩展入口。
 * 这里完成三件事：
 * 1. 初始化设置联动；
 * 2. 注册 SCM 面板候选视图；
 * 3. 注册“AI生成”命令。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initializeLogger();
  context.subscriptions.push({ dispose: disposeLogger });
  await initializeI18n(context.extensionPath);
  info('扩展开始激活。');

  settingsManager = new SettingsManager(context);
  await settingsManager.initialize();
  info('设置联动初始化完成。');

  candidateViewProvider = new CandidateViewProvider(
    context.extensionUri,
    async ({ candidateIndex }) => {
      await applyCandidate(candidateIndex);
    }
  );

  context.subscriptions.push(settingsManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CandidateViewProvider.viewType, candidateViewProvider)
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration('comitron.uiLanguage')) {
        return;
      }

      info('检测到 Ui Language 已变化，准备立即刷新运行时界面文本。');

      if (candidateSession) {
        await candidateViewProvider?.showCandidates(
          candidateSession.candidates,
          candidateSession.includeExtendedDescription
        );
      } else {
        candidateViewProvider?.refresh();
      }
    })
  );

  const disposable = vscode.commands.registerCommand(
    'comitron.generateCommitMessages',
    async () => {
      info('收到 AI生成 命令。');
      await handleGenerateCommitMessages();
    }
  );

  context.subscriptions.push(disposable);
  info('扩展激活完成。');
}

/**
 * 更新生成流程通知。
 * 这里始终复用同一个进度通知，避免短时间内连续弹出多条提示互相覆盖。
 */
async function reportGenerationProgress(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  message: string
): Promise<void> {
  progress.report({
    message: t(message)
  });

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * 执行完整的 Commit Message 生成流程。
 * 这里按顺序完成仓库选择、文件收集、Prompt 组装、AI 调用和候选面板刷新。
 */
async function handleGenerateCommitMessages(): Promise<void> {
  const startedAt = captureMonotonicTimestamp();
  let generationCompleted = false;

  try {
    info('开始执行 Commit Message 生成流程。');
    generationCompleted = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false
      },
      async (progress): Promise<boolean> => {
        await reportGenerationProgress(progress, '已收到生成请求，正在检查仓库状态...');

        const gitApi = await getGitApi();

        if (!gitApi) {
          warn('未找到 VSCode 内置 Git 扩展。');
          void vscode.window.showErrorMessage(t('找不到 Git 扩展，请确认 VSCode 已启用内置 Git 功能。'));
          showLogger(false);
          return false;
        }

        const repository = selectRepository(gitApi.repositories);

        if (!repository) {
          warn('当前工作区没有可用 Git 仓库。');
          void vscode.window.showErrorMessage(t('当前工作区没有可用的 Git 仓库。'));
          showLogger(false);
          return false;
        }

        info(`当前操作仓库：${repository.rootUri.fsPath}`);

        await reportGenerationProgress(progress, '正在收集 Git 差异...');
        const changes = await collectChangedFiles(repository);
        info(`检测到已更改文件数量：${changes.length}`);
        infoObject('已更改文件列表', changes.map((change) => ({
          文件: change.relativePath,
          状态: change.scopes
        })), { compact: true });

        if (changes.length === 0) {
          warn('仓库中没有已更改文件，生成流程结束。');
          void vscode.window.showInformationMessage(t('当前仓库没有检测到已更改的文件。'));
          return false;
        }

        const config = getComitronConfig();
        infoObject('当前生成配置', {
          selectedTool: config.selectedTool,
          toolPath: config.toolPath || '[空]',
          commitLanguage: config.commitLanguage,
          includeExtendedDescription: config.includeExtendedDescription,
          uiLanguage: config.uiLanguage,
          promptLength: config.promptTemplate.length,
          toolResponsePromptLength: config.toolResponsePromptTemplate.length,
          responseJsonSchemaLength: config.responseJsonSchema.length
        });

        await reportGenerationProgress(progress, '正在整理主 Prompt 上下文...');
        const promptHeader = buildPromptTemplate(
          config.promptTemplate,
          config.commitLanguage,
          config.includeExtendedDescription,
          config.extendedDescriptionEnabledPrompt,
          config.extendedDescriptionDisabledPrompt,
          ''
        );
        const promptBudget = Math.max(0, config.contextBudget - promptHeader.length);
        info(`本次主 Prompt 可用于差异上下文的预算：${promptBudget}`);

        const promptContext = buildPromptContext(changes, promptBudget);
        const prompt = buildPromptTemplate(
          config.promptTemplate,
          config.commitLanguage,
          config.includeExtendedDescription,
          config.extendedDescriptionEnabledPrompt,
          config.extendedDescriptionDisabledPrompt,
          promptContext.text
        );

        info(`首轮主 Prompt 长度：${prompt.length}`);

        await reportGenerationProgress(progress, '正在调用 AI 生成候选 Commit Message...');

        info(`准备向 AI 发送消息。前置准备耗时：${formatElapsedDuration(measureElapsedMilliseconds(startedAt))}`);
        info('开始调用 AI 工具。');
        const candidates = await generateCommitMessageCandidates(prompt, repository.rootUri.fsPath, config);
        infoObject('AI 返回候选项', candidates);

        candidateSession = {
          repository,
          candidates,
          includeExtendedDescription: config.includeExtendedDescription
        };

        await reportGenerationProgress(progress, '正在更新候选列表...');
        await candidateViewProvider?.showCandidates(candidates, config.includeExtendedDescription);
        info('候选项已写入 SCM 面板视图。');
        return true;
      }
    );

    if (generationCompleted) {
      void vscode.window.showInformationMessage(t('候选 Commit Message 已更新，请在源代码管理面板中选择。'));
    }
  } catch (error) {
    logError('生成流程失败。', error);
    showLogger(false);
    await handleError(error);
  } finally {
    info(`Commit Message 生成流程结束。结果：${generationCompleted ? '成功' : '未完成'}。总耗时：${formatElapsedDuration(measureElapsedMilliseconds(startedAt))}`);
  }
}

/**
 * 把用户在候选面板中点击的候选项写入当前仓库的 Commit 输入框。
 */
async function applyCandidate(candidateIndex: number): Promise<void> {
  if (!candidateSession) {
    warn('候选点击事件到达时，没有可用候选会话。');
    return;
  }

  const candidate = candidateSession.candidates[candidateIndex];

  if (!candidate) {
    warn(`用户点击了不存在的候选索引：${candidateIndex}`);
    return;
  }

  const fullMessage = formatCommitMessage(candidate, candidateSession.includeExtendedDescription);
  infoObject('用户选择的候选项', {
    index: candidateIndex,
    title: candidate.title,
    description: candidate.description,
    finalMessage: fullMessage
  });
  candidateSession.repository.inputBox.value = fullMessage;
  candidateViewProvider?.setSelectedCandidate(candidateIndex);
  await vscode.commands.executeCommand('workbench.view.scm');
  void vscode.window.showInformationMessage(t('已写入 Commit Message 输入框。'));
}

/**
 * 选择当前应该操作的 Git 仓库。
 * 如果存在当前已选仓库，则优先使用；否则退回到列表中的第一个仓库。
 */
function selectRepository(repositories: readonly Repository[]): Repository | undefined {
  if (repositories.length === 0) {
    return undefined;
  }

  return repositories.find((repository) => repository.ui.selected) ?? repositories[0];
}

/**
 * 把主 Prompt 模板中的变量替换成运行时实际内容。
 */
function buildPromptTemplate(
  promptTemplate: string,
  commitLanguage: string,
  includeExtendedDescription: boolean,
  extendedDescriptionEnabledPrompt: string,
  extendedDescriptionDisabledPrompt: string,
  changedFilesText: string
): string {
  const extendedDescriptionInstruction = includeExtendedDescription
    ? extendedDescriptionEnabledPrompt
    : extendedDescriptionDisabledPrompt;

  return promptTemplate
    .replaceAll('{{commitLanguage}}', commitLanguage)
    .replaceAll('{{extendedDescriptionInstruction}}', extendedDescriptionInstruction)
    .replaceAll('{{changedFiles}}', changedFilesText);
}

/**
 * 根据 Commit 描述开关决定最终写入输入框的文本结构。
 */
function formatCommitMessage(candidate: CommitMessageCandidate, includeExtendedDescription: boolean): string {
  if (!includeExtendedDescription || !candidate.description) {
    return candidate.title;
  }

  return `${candidate.title}\n\n${candidate.description}`;
}

/**
 * 统一处理运行过程中的错误信息，并把用户引导到正确的设置项。
 */
async function handleError(error: unknown): Promise<void> {
  if (error instanceof ToolPathMissingError) {
    warn(`工具路径缺失：${error.toolName}`);
    const action = await vscode.window.showErrorMessage(
      error.message,
      t('打开设置')
    );

    if (action) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'comitron.toolPath');
    }

    return;
  }

  if (error instanceof ToolPathInvalidError) {
    warn(`工具路径无效：${error.configuredPath}`);
    const action = await vscode.window.showErrorMessage(
      error.message,
      t('打开设置')
    );

    if (action) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'comitron.toolPath');
    }

    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  error instanceof Error
    ? logError('发生未分类错误。', error)
    : logError('发生未分类错误。', message);
  await vscode.window.showErrorMessage(message);
}

/**
 * 扩展停用时清空会话缓存并释放日志通道。
 */
export function deactivate(): void {
  info('扩展停用，清理候选会话。');
  candidateSession = undefined;
  disposeLogger();
}
