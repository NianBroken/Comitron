import { createInitialCandidateViewState, type CandidateViewState } from './candidateViewState';

/**
 * 候选视图所需的翻译函数。
 * 渲染模块只依赖这个最小接口，避免直接依赖 VS Code 运行时。
 */
export type CandidateViewTranslator = (key: string) => string;

/**
 * 根据当前状态拼装候选面板主体内容。
 * 无候选项时按状态显示提示，有候选项时按卡片形式逐条渲染。
 */
export function renderCandidateViewBody(
  state: CandidateViewState,
  translate: CandidateViewTranslator
): string {
  if (state.candidates.length === 0) {
    const status = state.status ?? createInitialCandidateViewState().status;

    if (!status) {
      return '';
    }

    return `<div class="status-message status-${status.kind}" role="status" aria-live="polite">${escapeHtml(translate(status.message))}</div>`;
  }

  const candidateCards = state.candidates.map((candidate, index) => {
    const descriptionBlock = state.includeExtendedDescription && candidate.description
      ? `
        <div class="section-label">${translate('Commit 描述')}</div>
        <div class="candidate-content">${escapeHtml(candidate.description)}</div>
      `
      : '';
    const isLastUsedCandidate = state.batchUsed && state.lastUsedCandidateIndex === index;
    const cardClassName = `candidate-card${isLastUsedCandidate ? ' candidate-last-used' : ''}`;

    return `
      <section class="${cardClassName}">
        <div class="section-header">
          <div class="section-label">${translate('Commit 标题')}</div>
          <button class="apply-button" data-candidate-index="${index}">${translate('使用这条')}</button>
        </div>
        <div class="candidate-content">${escapeHtml(candidate.title)}</div>
        ${descriptionBlock}
      </section>
    `;
  }).join('');

  return `<main class="candidate-list${state.batchUsed ? ' batch-used' : ''}">${candidateCards}</main>`;
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
