import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { t } from './i18n';
import { info, infoObject, warn } from './logger';
import type { Repository } from './git';

/**
 * 单个已更改文件在 Prompt 选择阶段使用的完整数据结构。
 * 这里保留完整差异、差异行数和差异字符长度，用于后续按预算挑选文件。
 */
export interface CollectedChange {
  absolutePath: string;
  relativePath: string;
  scopes: string[];
  diff: string;
  diffLineCount: number;
  diffLength: number;
}

/**
 * 最终发送给 AI 的差异上下文构建结果。
 * 这里会明确给出纳入上下文的文件、丢弃的文件以及实际使用的字符数。
 */
export interface PromptContextResult {
  text: string;
  includedFiles: string[];
  omittedFiles: string[];
  usedLength: number;
  budget: number;
}

/**
 * 收集当前仓库里所有已更改文件的完整差异。
 * 为了控制等待时间，这里只执行两次 Git CLI：
 * 1. 一次读取暂存区差异；
 * 2. 一次读取工作区差异。
 * 若整仓库差异拆分后仍未命中某个文件，再单独对该文件做一次兜底读取。
 */
export async function collectChangedFiles(repository: Repository): Promise<CollectedChange[]> {
  const rootPath = repository.rootUri.fsPath;
  const changeMap = new Map<string, Set<string>>();

  addChanges(changeMap, repository.state.indexChanges, t('已暂存'));
  addChanges(changeMap, repository.state.workingTreeChanges, t('工作区'));
  addChanges(changeMap, repository.state.untrackedChanges, t('未跟踪'));
  addChanges(changeMap, repository.state.mergeChanges, t('合并冲突'));

  const entries = Array.from(changeMap.entries())
    .map(([absolutePath, scopes]) => ({ absolutePath, scopes: Array.from(scopes).sort() }))
    .sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));

  info(`开始快速收集差异。文件数量：${entries.length}`);

  const [stagedDiffText, workingTreeDiffText] = await Promise.all([
    runGitDiff(rootPath, buildGitDiffArgs({ staged: true })),
    runGitDiff(rootPath, buildGitDiffArgs({ staged: false }))
  ]);

  const stagedDiffMap = parseCombinedDiff(stagedDiffText);
  const workingTreeDiffMap = parseCombinedDiff(workingTreeDiffText);

  return Promise.all(entries.map(async (entry) => {
    const relativePath = normalizePath(path.relative(rootPath, entry.absolutePath));
    const diffParts: string[] = [];

    if (entry.scopes.includes(t('已暂存'))) {
      const stagedDiff = stagedDiffMap.get(relativePath);

      if (stagedDiff) {
        diffParts.push(stagedDiff);
      }
    }

    if (entry.scopes.includes(t('工作区')) || entry.scopes.includes(t('合并冲突'))) {
      const workingTreeDiff = workingTreeDiffMap.get(relativePath);

      if (workingTreeDiff) {
        diffParts.push(workingTreeDiff);
      }
    }

    if (entry.scopes.includes(t('未跟踪'))) {
      const untrackedDiff = await buildUntrackedDiff(relativePath, entry.absolutePath);

      if (untrackedDiff) {
        diffParts.push(untrackedDiff);
      }
    }

    const mergedDiff = diffParts
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');

    const fallbackDiff = mergedDiff
      ? ''
      : await buildTrackedDiffFallback(rootPath, relativePath, entry.scopes);
    const finalDiff = mergedDiff || fallbackDiff || t('无法读取文本内容。');
    const diffLineCount = countChangedLines(finalDiff);

    return {
      absolutePath: entry.absolutePath,
      relativePath,
      scopes: entry.scopes,
      diff: finalDiff,
      diffLineCount,
      diffLength: finalDiff.length
    };
  }));
}

/**
 * 根据预算从全部差异中挑选一组文件。
 * 规则非常明确：
 * 1. 先按差异行数从多到少排序；
 * 2. 再按差异文本长度从大到小排序；
 * 3. 在不超过预算的前提下尽量往里放；
 * 4. 只保留完整文件差异，不做半截裁剪；
 * 5. 如果预算装不下一整个文件，也至少保留一份完整差异，避免空上下文。
 */
export function buildPromptContext(changes: CollectedChange[], budget: number): PromptContextResult {
  const sortedChanges = changes
    .slice()
    .sort((left, right) => {
      if (right.diffLineCount !== left.diffLineCount) {
        return right.diffLineCount - left.diffLineCount;
      }

      if (right.diffLength !== left.diffLength) {
        return right.diffLength - left.diffLength;
      }

      return left.relativePath.localeCompare(right.relativePath);
    });

  const includedBlocks: string[] = [];
  const includedFiles: string[] = [];
  const omittedFiles: string[] = [];
  let usedLength = 0;

  for (const change of sortedChanges) {
    const block = formatChangeBlock(change);
    const separatorLength = includedBlocks.length === 0 ? 0 : '\n\n------------------------------\n\n'.length;
    const nextLength = usedLength + separatorLength + block.length;

    if (nextLength <= budget) {
      includedBlocks.push(block);
      includedFiles.push(change.relativePath);
      usedLength = nextLength;
      continue;
    }

    omittedFiles.push(change.relativePath);
  }

  if (includedBlocks.length === 0 && sortedChanges.length > 0) {
    const fallbackChange = pickSmallestChange(sortedChanges);
    const fallbackBlock = formatChangeBlock(fallbackChange);

    includedBlocks.push(fallbackBlock);
    includedFiles.push(fallbackChange.relativePath);
    usedLength = fallbackBlock.length;

    const remainingOmittedFiles = sortedChanges
      .filter((change) => change.relativePath !== fallbackChange.relativePath)
      .map((change) => change.relativePath);

    omittedFiles.length = 0;
    omittedFiles.push(...remainingOmittedFiles);

    warn(`差异预算不足，已保留单个完整文件：${fallbackChange.relativePath}。budget=${budget}，usedLength=${usedLength}`);
  }

  const text = includedBlocks.join('\n\n------------------------------\n\n');

  infoObject('最终上下文筛选结果', {
    budget,
    usedLength,
    includedFiles,
    omittedFiles
  });

  return {
    text,
    includedFiles,
    omittedFiles,
    usedLength,
    budget
  };
}

/**
 * 从一组差异里挑出最短的一份完整文本。
 * 当预算无法容纳任何文件时，这里用最小超出量保留最基本的上下文。
 */
function pickSmallestChange(changes: readonly CollectedChange[]): CollectedChange {
  return changes
    .slice()
    .sort((left, right) => {
      if (left.diffLength !== right.diffLength) {
        return left.diffLength - right.diffLength;
      }

      if (left.diffLineCount !== right.diffLineCount) {
        return left.diffLineCount - right.diffLineCount;
      }

      return left.relativePath.localeCompare(right.relativePath);
    })[0];
}

/**
 * 把一组差异项加入去重映射中。
 * 同一个文件如果同时存在于多个区域，会把多个状态标签都记录下来。
 */
function addChanges(changeMap: Map<string, Set<string>>, changes: readonly { uri: { fsPath: string } }[], scopeLabel: string): void {
  for (const change of changes) {
    const absolutePath = change.uri.fsPath;
    const scopes = changeMap.get(absolutePath) ?? new Set<string>();
    scopes.add(scopeLabel);
    changeMap.set(absolutePath, scopes);
  }
}

/**
 * 用单次 Git CLI 命令读取整仓库差异。
 * 这里的结果后面会再拆成逐文件块。
 */
async function runGitDiff(rootPath: string, args: string[]): Promise<string> {
  try {
    infoObject('开始执行整仓库 Git 差异命令', {
      rootPath,
      args
    });

    const result = await runCommand('git', args, rootPath);
    info(`整仓库 Git 差异命令完成。输出长度：${result.stdout.length}`);
    return result.stdout;
  } catch (error) {
    warn(`整仓库 Git 差异命令失败：${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

/**
 * 把一大段 unified diff 拆成以文件为单位的差异块。
 * 这样后面可以按文件筛选，而不是只能整体截断。
 */
function parseCombinedDiff(diffText: string): Map<string, string> {
  const diffMap = new Map<string, string>();

  const normalizedDiff = diffText.replace(/\r\n/g, '\n').trim();

  if (!normalizedDiff) {
    return diffMap;
  }

  const startMatches = Array.from(normalizedDiff.matchAll(/^diff --git /gm));

  for (let index = 0; index < startMatches.length; index += 1) {
    const start = startMatches[index].index ?? 0;
    const end = index + 1 < startMatches.length
      ? startMatches[index + 1].index ?? normalizedDiff.length
      : normalizedDiff.length;
    const block = normalizedDiff.slice(start, end).trim();
    const relativePath = extractRelativePathFromDiffBlock(block);

    if (!relativePath) {
      continue;
    }

    diffMap.set(relativePath, block);
  }

  return diffMap;
}

/**
 * 为已跟踪文件执行按路径兜底读取。
 * 当整仓库差异已经拿到结果，但拆分后没有命中具体文件时，这里直接向 Git 读取该文件相对 HEAD 的差异。
 */
async function buildTrackedDiffFallback(rootPath: string, relativePath: string, scopes: readonly string[]): Promise<string> {
  if (scopes.includes(t('未跟踪'))) {
    return '';
  }

  info(`开始按文件兜底读取差异：${relativePath}`);
  const diffText = await runGitDiff(rootPath, buildGitDiffArgs({
    againstHead: true,
    relativePath
  }));

  if (diffText.trim()) {
    info(`按文件兜底读取成功：${relativePath}`);
    return diffText.trim();
  }

  warn(`按文件兜底读取仍未拿到差异：${relativePath}`);
  return '';
}

/**
 * 从单个 diff 块里提取相对路径。
 * 优先取 +++ / --- 行，再退回到 diff --git 头部。
 */
function extractRelativePathFromDiffBlock(block: string): string | undefined {
  const lines = block.split('\n');

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      return normalizePath(stripQuotes(line.slice(6)));
    }

    if (line.startsWith('--- a/')) {
      return normalizePath(stripQuotes(line.slice(6)));
    }
  }

  const header = lines[0];
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);

  if (!match) {
    return undefined;
  }

  return normalizePath(stripQuotes(match[2]));
}

/**
 * 为未跟踪文件构造完整的新增文件 diff。
 * 因为 Git 普通 diff 不会带出未跟踪文件，所以这里手动生成。
 */
async function buildUntrackedDiff(relativePath: string, absolutePath: string): Promise<string> {
  try {
    const buffer = await fs.readFile(absolutePath);

    if (looksBinary(buffer)) {
      return [
        `diff --git a/${relativePath} b/${relativePath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${relativePath}`,
        `+${t('二进制文件，已跳过内容读取。')}`
      ].join('\n');
    }

    const content = buffer.toString('utf8').replace(/\r\n/g, '\n');
    const body = content
      .split('\n')
      .map((line) => `+${line}`)
      .join('\n');

    return [
      `diff --git a/${relativePath} b/${relativePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${relativePath}`,
      body
    ].join('\n');
  } catch (error) {
    warn(`未跟踪文件 diff 生成失败：${relativePath}，原因：${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

/**
 * 统计单个差异块的变化行数。
 * 这里只统计真正的新增行和删除行，不统计 diff 头信息。
 */
function countChangedLines(diffText: string): number {
  return diffText
    .split(/\r?\n/)
    .filter((line) => (
      (line.startsWith('+') && !line.startsWith('+++'))
      || (line.startsWith('-') && !line.startsWith('---'))
    ))
    .length;
}

/**
 * 把单个文件差异块格式化成最终放进 Prompt 的文本。
 * 这里不再附带文件当前完整内容，只保留真正有价值的差异信息。
 */
function formatChangeBlock(change: CollectedChange): string {
  return [
    `${t('文件')}: ${change.relativePath}`,
    `${t('状态')}: ${change.scopes.join('、')}`,
    `${t('差异')}:\n${change.diff}`
  ].join('\n');
}

/**
 * 判断文件是否像二进制文件。
 */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2000));

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }

  return false;
}

/**
 * 把带引号的 Git 路径恢复成普通路径文本。
 */
function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * 把 Windows 路径统一转换成斜杠格式，便于展示和 Prompt 阅读。
 */
function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

/**
 * 构建 Git diff 命令参数。
 * 这里统一关闭 quotePath，确保包含中文等非 ASCII 字符的路径可以按原样参与匹配。
 */
function buildGitDiffArgs(options: {
  staged?: boolean;
  againstHead?: boolean;
  relativePath?: string;
}): string[] {
  const args = ['-c', 'core.quotepath=false', 'diff'];

  if (options.againstHead) {
    args.push('HEAD');
  }

  if (options.staged) {
    args.push('--cached');
  }

  args.push('--no-ext-diff', '--unified=3', '--no-color');

  if (options.relativePath) {
    args.push('--', options.relativePath);
  }

  return args;
}

/**
 * 启动命令行进程并收集完整输出。
 */
async function runCommand(
  executablePath: string,
  args: string[],
  workingDirectory: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      cwd: workingDirectory,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code}`));
    });
  });
}
