import * as vscode from 'vscode';

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
