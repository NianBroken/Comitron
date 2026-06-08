import * as path from 'node:path';
import type { KnownAiToolName } from './config';

/**
 * 根据自定义路径文件名推断它属于哪一种已知工具。
 */
export function inferCustomToolKind(toolPath: string): KnownAiToolName | undefined {
  const lowerCaseName = path.basename(toolPath).toLowerCase();

  if (lowerCaseName.includes('codex')) {
    return 'codex';
  }

  if (lowerCaseName.includes('claude')) {
    return 'claudeCode';
  }

  if (lowerCaseName.includes('gemini')) {
    return 'geminiCli';
  }

  return undefined;
}
