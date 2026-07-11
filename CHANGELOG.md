# 更改日志

## [1.0.8] - 2026-07-11

- 新增 activeGenerationRequestId 全局变量，用于追踪当前活跃的生成请求
- 在生成流程各关键阶段检查请求是否过期，避免旧请求覆盖结果
- 新增 beginGenerationRequest、isActiveGenerationRequest、shouldContinueGenerationRequest 辅助函数

## [1.0.7] - 2026-06-10

### Changed

- 将生成逻辑抽取为独立的 runGenerationFlow 函数，避免进度通知被用户交互弹窗阻塞
- 新增 PostProgressNotification 接口，统一管理进度结束后需展示的提示信息
- 删除 src/test/run.ts 自动化测试脚本及对应的 npm test 命令

## [1.0.6] - 2026-06-08

### Changed

- 新增 `nonApiThinking.ts`，为 Codex、Claude Code、Gemini CLI 分别构造临时关闭思考的参数与环境变量
- 重构 `toolRunner.ts`，将思考覆盖参数注入到各已知工具的子进程调用中
- 新增 `customToolKind.ts`，根据文件名推断自定义工具所属类型
- 新增 `apiServiceConfig.ts`，将 API 服务配置解析逻辑抽取为独立模块并支持翻译函数注入
- 新增 `contextBudget.ts`，统一管理 Context Budget 的默认值与取值范围
- 更新 `config.ts` 引用新的 Context Budget 常量
- 调整 `package.json` 中 `contextBudget` 默认值、最小值和最大值
- 更新 `package.json` 中 `apiServiceJson` 默认值为空配置
- 新增 `src/test/run.ts` 验证脚本，覆盖关键配置与调用参数

## [1.0.5] - 2026-05-20

### Changed

- 新增统一错误类体系，将内部异常转换为面向用户的友好提示
- 实现 API 服务原生 HTTP 请求，增强网络错误细节捕获与分类
- 自动检测仓库首次提交状态并填入 Initial commit
- 优化日志记录逻辑，完整保留错误原因链与元数据

## [1.0.4] - 2026-04-17

### Changed

- 支持自定义响应 JSON Schema 并优化生成流程日志
- 新增 responseJsonSchema 配置项，允许用户自定义 AI 返回结构约束
- 重构校验逻辑以支持动态 Schema 解析与严格字段验证
- 引入单调时钟统计耗时，细化生成各阶段的进度提示
- 优化日志输出格式，支持紧凑模式并增加时区信息

## [1.0.3] - 2026-04-10

### Changed

- 修复依赖安全漏洞

## [1.0.2] - 2026-04-04

### Changed

- 增强变更收集器对新增和删除文件的兜底处理

## [1.0.1] - 2026-04-04

### Changed

- 更新默认提示模板。
