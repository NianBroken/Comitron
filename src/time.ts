/**
 * 与时间换算相关的基础常量。
 * 这些值只表达时间单位之间的固定关系，不参与任何时区假设。
 */
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * 运行时本地时钟的快照。
 * 这里同时保留本地时间、UTC 时间、时区标识和 UTC 偏移，避免日志出现歧义。
 */
export interface RuntimeClockSnapshot {
  localTimestamp: string;
  utcTimestamp: string;
  timeZone?: string;
  utcOffset: string;
}

/**
 * 单调时钟时间戳。
 * 这里使用高精度单调计时，避免系统时间跳变影响耗时统计。
 */
export type MonotonicTimestamp = bigint;

/**
 * 获取当前单调时钟时间戳。
 */
export function captureMonotonicTimestamp(): MonotonicTimestamp {
  return process.hrtime.bigint();
}

/**
 * 计算两个单调时钟时间戳之间的耗时毫秒数。
 * 如果出现意外倒退，直接收敛到 0，避免产生负耗时。
 */
export function measureElapsedMilliseconds(
  startedAt: MonotonicTimestamp,
  finishedAt: MonotonicTimestamp = captureMonotonicTimestamp()
): number {
  if (finishedAt <= startedAt) {
    return 0;
  }

  return Number(finishedAt - startedAt) / Number(NANOSECONDS_PER_MILLISECOND);
}

/**
 * 把耗时毫秒数整理成适合日志展示的文本。
 * 短耗时保留毫秒，较长耗时自动切换为秒或分钟。
 */
export function formatElapsedDuration(durationMilliseconds: number): string {
  const safeDuration = Number.isFinite(durationMilliseconds) && durationMilliseconds > 0
    ? durationMilliseconds
    : 0;

  if (safeDuration < MILLISECONDS_PER_SECOND) {
    return `${formatFixedNumber(safeDuration, 3)}ms`;
  }

  const durationSeconds = safeDuration / MILLISECONDS_PER_SECOND;

  if (durationSeconds < SECONDS_PER_MINUTE) {
    return `${formatFixedNumber(durationSeconds, 3)}s`;
  }

  const minutes = Math.floor(durationSeconds / SECONDS_PER_MINUTE);
  const seconds = durationSeconds - minutes * SECONDS_PER_MINUTE;

  return `${minutes}m ${formatFixedNumber(seconds, 3)}s`;
}

/**
 * 生成当前本地时间环境快照。
 * 这里动态读取系统时间、UTC 偏移和时区名称，不缓存任何时区结果。
 */
export function getRuntimeClockSnapshot(date: Date = new Date()): RuntimeClockSnapshot {
  const safeDate = normalizeDate(date);

  return {
    localTimestamp: formatLocalTimestamp(safeDate),
    utcTimestamp: safeDate.toISOString(),
    timeZone: resolveSystemTimeZone(),
    utcOffset: formatUtcOffset(safeDate.getTimezoneOffset())
  };
}

/**
 * 生成日志用时间戳。
 * 本地时间、UTC 偏移和时区标识会同时写入，排查跨时区问题时不会混淆。
 */
export function formatLogTimestamp(date: Date = new Date()): string {
  const snapshot = getRuntimeClockSnapshot(date);

  return snapshot.timeZone
    ? `${snapshot.localTimestamp} ${snapshot.utcOffset} ${snapshot.timeZone}`
    : `${snapshot.localTimestamp} ${snapshot.utcOffset}`;
}

/**
 * 把本地时间按固定字段顺序拼成稳定文本。
 * 这里直接使用系统本地时间字段，避免受格式化区域顺序差异影响。
 */
function formatLocalTimestamp(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  const millisecond = String(date.getMilliseconds()).padStart(3, '0');

  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${millisecond}`;
}

/**
 * 把系统返回的分钟偏移转换成标准 UTC 偏移文本。
 * Date.getTimezoneOffset 返回的是本地时间相对 UTC 的反向偏移，这里统一转回常见表示法。
 */
function formatUtcOffset(timezoneOffsetMinutes: number): string {
  const totalMinutesEastOfUtc = -timezoneOffsetMinutes;
  const sign = totalMinutesEastOfUtc >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(totalMinutesEastOfUtc);
  const hours = Math.floor(absoluteMinutes / MINUTES_PER_HOUR);
  const minutes = absoluteMinutes % MINUTES_PER_HOUR;

  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * 读取系统当前时区标识。
 * 如果运行环境没有提供 IANA 时区名称，就退回为空，让上层只展示本地时间和偏移。
 */
function resolveSystemTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
    return timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把数字整理成紧凑文本。
 * 末尾无意义的 0 会被去掉，避免日志里出现冗长小数。
 */
function formatFixedNumber(value: number, fractionDigits: number): string {
  return value
    .toFixed(fractionDigits)
    .replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, '$1');
}

/**
 * 确保参与格式化的时间对象有效。
 * 一旦外部传入无效日期，这里会回退到当前系统时间。
 */
function normalizeDate(date: Date): Date {
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
