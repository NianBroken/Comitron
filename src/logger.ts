import * as vscode from 'vscode';

/**
 * 插件统一使用的输出通道名称。
 * 这个名称会出现在 VSCode 的“输出”面板下拉列表中。
 */
const OUTPUT_CHANNEL_NAME = 'Comitron';

let outputChannel: vscode.OutputChannel | undefined;

/**
 * 初始化输出通道。
 * 这个方法只会创建一次，后续重复调用会直接复用已有通道。
 */
export function initializeLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    info('输出通道已初始化。');
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
    append('ERROR', `错误消息：${reason.message}`);

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
export function infoObject(title: string, value: unknown): void {
  append('INFO', `${title}：${serialize(value)}`);
}

/**
 * 统一写入输出通道。
 * 每条日志都带有时间和级别，便于按时间顺序排查问题。
 */
function append(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const timestamp = new Date().toISOString();
  getLogger().appendLine(`[${timestamp}] [${level}] ${message}`);
}

/**
 * 把对象安全地转成字符串。
 * 序列化失败时，至少保证输出一个可读占位文本。
 */
function serialize(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[无法序列化的值]';
  }
}
