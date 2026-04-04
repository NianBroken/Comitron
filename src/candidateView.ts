import * as vscode from 'vscode';
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
 * 候选面板当前显示状态。
 * 这里保存候选数据、Commit 描述开关和当前已选中的候选索引。
 */
interface CandidateViewState {
  candidates: CommitMessageCandidate[];
  includeExtendedDescription: boolean;
  selectedIndex: number | undefined;
}

/**
 * SCM 面板中的候选项视图提供者。
 * 负责生成 Webview 内容，并把按钮点击事件转回扩展命令侧。
 */
export class CandidateViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'comitron.candidatesView';

  private view: vscode.WebviewView | undefined;
  private state: CandidateViewState = {
    candidates: [],
    includeExtendedDescription: false,
    selectedIndex: undefined
  };

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
      if (message.type !== 'applyCandidate' || typeof message.candidateIndex !== 'number') {
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
   * 每次重新生成候选项时，已选中状态会被清空。
   */
  async showCandidates(
    candidates: CommitMessageCandidate[],
    includeExtendedDescription: boolean
  ): Promise<void> {
    this.state = {
      candidates,
      includeExtendedDescription,
      selectedIndex: undefined
    };

    await vscode.commands.executeCommand('workbench.view.scm');
    this.render();
  }

  /**
   * 标记当前已被用户应用的候选项。
   * 这个状态只用于面板内的视觉高亮。
   */
  setSelectedCandidate(index: number): void {
    this.state = {
      ...this.state,
      selectedIndex: index
    };

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
  const script = getInlineScript(state);
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
  ${script.body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-candidate-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const rawIndex = button.getAttribute('data-candidate-index');
        const candidateIndex = Number(rawIndex);

        if (Number.isNaN(candidateIndex)) {
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
 * 根据当前状态拼装候选面板主体内容。
 * 无候选项时显示空状态，有候选项时按卡片形式逐条渲染。
 */
function getInlineScript(state: CandidateViewState): { body: string } {
  if (state.candidates.length === 0) {
    return {
      body: `<div class="empty-state">${t('当前没有候选 Commit Message。点击源代码管理面板右上角的 AI生成 按钮开始生成。')}</div>`
    };
  }

  const candidateCards = state.candidates.map((candidate, index) => {
    const descriptionBlock = state.includeExtendedDescription && candidate.description
      ? `
        <div class="section-label">${t('Commit 描述')}</div>
        <div class="candidate-content">${escapeHtml(candidate.description)}</div>
      `
      : '';

    const selectedClass = state.selectedIndex === index ? ' selected' : '';

    return `
      <section class="candidate-card${selectedClass}">
        <div class="section-header">
          <div class="section-label">${t('Commit 标题')}</div>
          <button class="apply-button" data-candidate-index="${index}">${t('使用这条')}</button>
        </div>
        <div class="candidate-content">${escapeHtml(candidate.title)}</div>
        ${descriptionBlock}
      </section>
    `;
  }).join('');

  return {
    body: `<main class="candidate-list">${candidateCards}</main>`
  };
}

/**
 * 转义 HTML 特殊字符，并把换行转换成 <br />。
 * 这样标题和描述既能安全显示，也能保留原本的换行结构。
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
    .replaceAll('\n', '<br />');
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
