import type { CommitMessageCandidate } from './toolRunner';

/**
 * 首次打开候选面板时显示的固定引导文案。
 * 这个状态只会在当前扩展激活会话中尚未生成过候选时使用。
 */
export const INITIAL_EMPTY_STATE_MESSAGE = '当前没有候选 Commit Message。点击源代码管理面板右上角的 AI生成 按钮开始生成。';

/**
 * 候选面板在没有候选项时可展示的状态类型。
 */
export type CandidateViewStatusKind = 'initial' | 'generating' | 'notice' | 'error';

/**
 * 候选面板当前的非候选状态。
 * message 保存翻译键，渲染时按当前 UI 语言转换成可见文案。
 */
export interface CandidateViewStatus {
  kind: CandidateViewStatusKind;
  message: string;
}

/**
 * 候选面板的完整运行时状态。
 * batchUsed 表示当前这一批候选中至少有一条已经写入 Commit 输入框。
 * lastUsedCandidateIndex 保存当前批次最后一次成功写入输入框的候选索引。
 */
export interface CandidateViewState {
  candidates: readonly CommitMessageCandidate[];
  includeExtendedDescription: boolean;
  batchUsed: boolean;
  lastUsedCandidateIndex: number | undefined;
  status: CandidateViewStatus | undefined;
}

/**
 * 创建当前扩展激活会话的初始空状态。
 */
export function createInitialCandidateViewState(): CandidateViewState {
  return createStatusCandidateViewState('initial', INITIAL_EMPTY_STATE_MESSAGE);
}

/**
 * 创建生成过程中的候选面板状态。
 */
export function createGeneratingCandidateViewState(message: string): CandidateViewState {
  return createStatusCandidateViewState('generating', message);
}

/**
 * 创建没有候选项时的一般提示状态。
 */
export function createNoticeCandidateViewState(message: string): CandidateViewState {
  return createStatusCandidateViewState('notice', message);
}

/**
 * 创建生成失败后的候选面板状态。
 */
export function createErrorCandidateViewState(message: string): CandidateViewState {
  return createStatusCandidateViewState('error', message);
}

/**
 * 创建一批新的候选项。
 * 每个新批次都从未使用状态开始，不能继承上一个批次的视觉状态。
 */
export function createCandidateBatchViewState(
  candidates: readonly CommitMessageCandidate[],
  includeExtendedDescription: boolean
): CandidateViewState {
  return {
    candidates,
    includeExtendedDescription,
    batchUsed: false,
    lastUsedCandidateIndex: undefined,
    status: undefined
  };
}

/**
 * 标记当前候选批次已经被使用。
 * 这个标记只影响整批候选的视觉样式，不会阻止再次写入候选内容。
 * 每次成功选择都会覆盖最后使用索引，确保视觉标识始终指向最近一次写入。
 */
export function markCandidateBatchUsed(
  state: CandidateViewState,
  candidateIndex: number
): CandidateViewState {
  if (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= state.candidates.length) {
    return state;
  }

  return {
    ...state,
    batchUsed: true,
    lastUsedCandidateIndex: candidateIndex
  };
}

/**
 * 创建共用的非候选状态。
 */
function createStatusCandidateViewState(
  kind: CandidateViewStatusKind,
  message: string
): CandidateViewState {
  return {
    candidates: [],
    includeExtendedDescription: false,
    batchUsed: false,
    lastUsedCandidateIndex: undefined,
    status: {
      kind,
      message
    }
  };
}
