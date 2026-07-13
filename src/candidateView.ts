import * as vscode from 'vscode';
import {
  createCandidateBatchViewState,
  createErrorCandidateViewState,
  createGeneratingCandidateViewState,
  createInitialCandidateViewState,
  createNoticeCandidateViewState,
  markCandidateBatchUsed,
  type CandidateViewState
} from './candidateViewState';
import { renderCandidateViewBody } from './candidateViewMarkup';
import { getCurrentLanguage, t } from './i18n';
import type { CommitMessageCandidate } from './toolRunner';

/**
 * 候选面板回传给扩展入口的点击上下文。
 * 当前只需要传回候选索引。
 */
export interface CandidateSelectionContext {
  candidateIndex: number;
}

/**
 * SCM 面板中的候选项视图提供者。
 * 负责生成 Webview 内容，并把按钮点击事件转回扩展命令侧。
 */
export class CandidateViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'comitron.candidatesView';

  private view: vscode.WebviewView | undefined;
  private state: CandidateViewState = createInitialCandidateViewState();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onSelectCandidate: (context: CandidateSelectionContext) => Promise<void>
  ) {}

  /**
   * 当 VSCode 首次创建这个视图时，初始化 Webview 配置并绑定消息监听。
   */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.onDidReceiveMessage(async (message: { type?: string; candidateIndex?: number }) => {
      if (message.type !== 'applyCandidate'
        || typeof message.candidateIndex !== 'number'
        || !Number.isInteger(message.candidateIndex)
        || message.candidateIndex < 0) {
        return;
      }

      await this.onSelectCandidate({
        candidateIndex: message.candidateIndex
      });
    });

    this.render();
  }

  /**
   * 用最新候选数据刷新面板。
   * 每次重新生成候选项时，新批次都会恢复为未使用状态。
   */
  async showCandidates(
    candidates: readonly CommitMessageCandidate[],
    includeExtendedDescription: boolean
  ): Promise<void> {
    this.state = createCandidateBatchViewState(candidates, includeExtendedDescription);

    await vscode.commands.executeCommand('workbench.view.scm');
    this.render();
  }

  /**
   * 显示当前生成阶段，并清空上一批候选内容。
   */
  showGenerationStatus(message: string): void {
    this.state = createGeneratingCandidateViewState(message);

    this.render();
  }

  /**
   * 显示生成流程未提供候选时的普通提示。
   */
  showNotice(message: string): void {
    this.state = createNoticeCandidateViewState(message);

    this.render();
  }

  /**
   * 显示生成失败后的状态。
   */
  showError(message: string): void {
    this.state = createErrorCandidateViewState(message);

    this.render();
  }

  /**
   * 标记当前候选批次已经被使用。
   * 整批候选会统一弱化，最后使用的候选会保留独立的视觉标识。
   */
  markCurrentBatchUsed(candidateIndex: number): void {
    this.state = markCandidateBatchUsed(this.state, candidateIndex);

    this.render();
  }

  /**
   * 按当前状态强制刷新视图。
   * 这个方法主要用于语言切换后立刻重绘可见文本。
   */
  refresh(): void {
    this.render();
  }

  /**
   * 把当前状态渲染成完整 HTML。
   */
  private render(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.html = getHtml(this.view.webview, this.extensionUri, this.state);
  }
}

/**
 * 生成 Webview 的完整 HTML。
 * 这里同时注入样式、静态内容和按钮点击脚本。
 */
function getHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  state: CandidateViewState
): string {
  const nonce = getNonce();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'view.css'));
  const body = renderCandidateViewBody(state, t);
  const title = t('Commit 候选项');
  const language = getCurrentLanguage();

  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>${title}</title>
</head>
<body>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-candidate-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const rawIndex = button.getAttribute('data-candidate-index');
        const candidateIndex = Number(rawIndex);

        if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
          return;
        }

        vscode.postMessage({
          type: 'applyCandidate',
          candidateIndex
        });
      });
    });
  </script>
</body>
</html>`;
}

/**
 * 生成 Webview 使用的随机 nonce。
 * nonce 用于限制脚本来源，满足 Webview 的内容安全策略要求。
 */
function getNonce(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let value = '';

  for (let index = 0; index < 16; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return value;
}
