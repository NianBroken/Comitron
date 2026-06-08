/**
 * Context Budget 的统一默认值与取值范围。
 * 配置定义、读取回退和运行时校验都复用这里，避免多处漂移。
 */
export const CONTEXT_BUDGET_DEFAULT = 65_536;
export const CONTEXT_BUDGET_MIN = 32_768;
export const CONTEXT_BUDGET_MAX = 131_072;

/**
 * 规范化上下文预算。
 * 这里保证预算值始终落在允许区间内，并且一定是整数。
 */
export function normalizeContextBudget(value: number): number {
  const safeValue = Number.isFinite(value) ? Math.floor(value) : CONTEXT_BUDGET_DEFAULT;
  return Math.min(CONTEXT_BUDGET_MAX, Math.max(CONTEXT_BUDGET_MIN, safeValue));
}
