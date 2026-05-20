import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { t } from './i18n';

/**
 * 当前仓库的提交历史状态。
 * hasCommits 表示已经存在至少一条提交记录。
 * initialCommit 表示仓库还没有任何提交记录。
 */
export type RepositoryHistoryState = 'hasCommits' | 'initialCommit';

/**
 * Git 仓库输入框的最小接口。
 * 当前扩展只需要读取和写入 Commit Message 文本。
 */
export interface InputBox {
  value: string;
}

/**
 * Git 变更项的最小接口。
 * 这里只需要文件 URI。
 */
export interface Change {
  readonly uri: vscode.Uri;
}

/**
 * Git 仓库状态接口。
 * 这里覆盖了扩展当前需要关心的四类变更集合。
 */
export interface RepositoryState {
  readonly mergeChanges: Change[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly untrackedChanges: Change[];
}

/**
 * Git 仓库 UI 状态接口。
 * selected 用于判断当前面板正在操作哪个仓库。
 */
export interface RepositoryUIState {
  readonly selected: boolean;
}

/**
 * 当前扩展实际依赖的仓库接口。
 * 包含根路径、输入框和状态。
 */
export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: InputBox;
  readonly state: RepositoryState;
  readonly ui: RepositoryUIState;
}

/**
 * VSCode 内置 Git 扩展导出的 API。
 */
export interface GitApi {
  readonly repositories: Repository[];
}

/**
 * VSCode 内置 Git 扩展的最小导出接口。
 */
export interface GitExtension {
  getAPI(version: 1): GitApi;
}

/**
 * 读取并激活 VSCode 内置 Git 扩展，然后返回版本 1 的 API。
 */
export async function getGitApi(): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');

  if (!extension) {
    return undefined;
  }

  if (!extension.isActive) {
    await extension.activate();
  }

  return extension.exports.getAPI(1);
}

/**
 * 读取当前仓库是否已经存在提交记录。
 * 这里使用 Git 原生命令判断 branch.oid，避免把首次提交场景误判成普通异常。
 */
export async function getRepositoryHistoryState(rootPath: string): Promise<RepositoryHistoryState> {
  const result = await runGitCommand(
    rootPath,
    ['status', '--porcelain=2', '--branch', '--untracked-files=no']
  );
  const branchOidLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('# branch.oid '));

  if (!branchOidLine) {
    throw new Error(t('无法识别当前仓库的提交历史状态。'));
  }

  return branchOidLine === '# branch.oid (initial)' ? 'initialCommit' : 'hasCommits';
}

/**
 * 执行 Git 命令并返回完整输出。
 * 这里只负责读取仓库状态，不在这里解释业务含义。
 */
async function runGitCommand(
  workingDirectory: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
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
