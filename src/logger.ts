import * as vscode from 'vscode';
import { formatLogTimestamp, getRuntimeClockSnapshot } from './time';

/**
 * 插件统一使用的输出通道名称。
 * 这个名称会出现在 VSCode 的“输出”面板下拉列表中。
 */
const OUTPUT_CHANNEL_NAME = 'Comitron';

let outputChannel: vscode.OutputChannel | undefined;

/**
 * 数据日志的展示选项。
 * compact 为 true 时使用单行格式，适合短对象和短数组。
 */
interface LogObjectOptions {
  compact?: boolean;
}

/**
 * 初始化输出通道。
 * 这个方法只会创建一次，后续重复调用会直接复用已有通道。
 */
export function initializeLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    info('输出通道已初始化。');
    infoObject('当前时间环境', getRuntimeClockSnapshot(), { compact: true });
  }

  return outputChannel;
}

/**
 * 获取当前输出通道。
 * 如果尚未初始化，会自动先创建。
 */
export function getLogger(): vscode.OutputChannel {
  return outputChannel ?? initializeLogger();
}

/**
 * 释放输出通道并清空内部引用。
 * 这样扩展再次激活时可以重新创建一条可用通道，不会复用已释放实例。
 */
export function disposeLogger(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}

/**
 * 在输出面板中显示当前通道。
 */
export function showLogger(preserveFocus = true): void {
  getLogger().show(preserveFocus);
}

/**
 * 记录普通信息日志。
 */
export function info(message: string): void {
  append('INFO', message);
}

/**
 * 记录警告日志。
 */
export function warn(message: string): void {
  append('WARN', message);
}

/**
 * 记录错误日志。
 * 如果传入 Error，会同时写入错误堆栈。
 */
export function error(message: string, reason?: unknown): void {
  append('ERROR', message);

  if (reason instanceof Error) {
    append('ERROR', `错误类型：${reason.name}`);
    append('ERROR', `错误消息：${reason.message}`);
    logErrorMetadata(reason);
    logErrorCause(reason.cause, 1);

    if (reason.stack) {
      append('ERROR', `错误堆栈：\n${reason.stack}`);
    }

    return;
  }

  if (reason !== undefined) {
    append('ERROR', `错误详情：${String(reason)}`);
  }
}

/**
 * 记录带标题的数据日志。
 * 这里会自动把对象序列化成易读文本，方便在失败时快速定位问题。
 */
export function infoObject(title: string, value: unknown, options: LogObjectOptions = {}): void {
  append('INFO', `${title}：${serialize(value, options)}`);
}

/**
 * 统一写入输出通道。
 * 每条日志都带有时间和级别，便于按时间顺序排查问题。
 */
function append(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const timestamp = formatLogTimestamp();
  getLogger().appendLine(`[${timestamp}] [${level}] ${message}`);
}

/**
 * 把对象安全地转成字符串。
 * 序列化失败时，至少保证输出一个可读占位文本。
 */
function serialize(value: unknown, options: LogObjectOptions): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    const serialized = options.compact
      ? JSON.stringify(value)
      : JSON.stringify(value, null, 2);

    return serialized ?? '[无法序列化的值]';
  } catch {
    return '[无法序列化的值]';
  }
}

/**
 * 记录 Error 实例自身携带的额外字段。
 * 这里会排除 name、message、stack 和 cause，只保留真正有定位价值的业务属性。
 */
function logErrorMetadata(error: Error): void {
  const metadata = extractErrorMetadata(error);

  if (!metadata) {
    return;
  }

  append('ERROR', `错误附加信息：${serialize(metadata, {})}`);
}

/**
 * 递归记录错误原因链。
 * 这样像网络异常这类真正根因挂在 cause 上的错误不会再丢失。
 */
function logErrorCause(cause: unknown, depth: number): void {
  if (cause === undefined) {
    return;
  }

  const prefix = `错误原因 ${depth}`;

  if (cause instanceof Error) {
    append('ERROR', `${prefix} 类型：${cause.name}`);
    append('ERROR', `${prefix} 消息：${cause.message}`);

    const metadata = extractErrorMetadata(cause);

    if (metadata) {
      append('ERROR', `${prefix} 附加信息：${serialize(metadata, {})}`);
    }

    if (cause.stack) {
      append('ERROR', `${prefix} 堆栈：\n${cause.stack}`);
    }

    logErrorCause(cause.cause, depth + 1);
    return;
  }

  append('ERROR', `${prefix} 详情：${serialize(cause, {})}`);
}

/**
 * 从 Error 实例中提取自有字段。
 * 只要没有额外字段，就返回 undefined，避免日志里出现空对象。
 */
function extractErrorMetadata(error: Error): Record<string, unknown> | undefined {
  const ignoredKeys = new Set(['name', 'message', 'stack', 'cause']);
  const entries = Object.entries(error).filter(([key]) => !ignoredKeys.has(key));

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}
