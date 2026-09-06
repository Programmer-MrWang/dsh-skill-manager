# DSH Skill Manager

[English](README.md) | 简体中文

一个可发布的 DeepSeek Harness 插件，用于在 Web 设置页面发现、创作、安装和管理 AI Agent Skill，并控制不同会话实际可使用的 Skill。

> 状态：针对 DeepSeek Harness `0.1.2-alpha.5` 的实现已完成（Host 策略存储与
> 创作服务、`skillManager` Remote 命名空间、作用域化运行时覆盖、浏览器
> Settings 页面与包元数据）。类型检查、单元测试（41 通过，含真实
> SkillRegistry 上的覆盖遮蔽语义测试）、产物构建、独立冒烟 profile 上的
> 运行态激活、无头浏览器验证（Settings → Skills 视图、磁盘 Skill 列表、
> 策略写入并持久化到 settings.yaml），以及注册表层强制生效语义均已通过。
> 活动模型会话内的端到端强制生效为已知限制，附逐步手动验证指南：
> [`docs/verification.md`](docs/verification.md)。

## 目标

- 浏览最终生效的 Skill 目录以及所有可管理的文件系统候选版本。
- 新建、导入、查看、编辑、复制和删除用户级或工作区级 Skill。
- 将 bundled、runtime 和随系统 Preset 安装的 Skill 保持为只读。
- 明确解释同名 Skill 的优先级和遮蔽关系，而不是隐藏被遮蔽版本。
- 以确定性继承规则应用全局、Preset、Workspace 和 Session 策略。
- 对模型目录、`skill` 工具、显式 `/name` 调用和 Web Slash 菜单执行相同的最终策略。
- 保证文件系统路径包含关系、乐观并发控制和可恢复删除。
- 作为生态插件发布；绝不修改已安装 Harness 或 shipped Agent Preset。

## 计划中的包

本仓库发布一个可安装的 Profile Bundle，其中包含双端 Host/Client Cordis 插件：

```text
dsh-skill-manager
├── Host 管理与策略服务（src/index.ts、src/runtime.ts、src/remote.ts）
├── 严格的浏览器 Remote API（src/wire.ts + src/remote.ts 描述符）
├── 作用域化运行时策略覆盖（src/runtime.ts SkillOverlayEngine）
└── Client settings.section 页面（src/client/）
```

实现内部保持模块化，使 Host capability、wire DTO、策略引擎和 Client UI 日后能够拆包，同时不改变持久化数据。

## 兼容策略

DeepSeek Harness `0.1.2-alpha.5` 提供 invocation-neutral、分层的 `ctx.skills` 注册表，但没有修改接口或策略过滤扩展点。因此，本插件通过作用域化覆盖 Provider 让每个活动 Agent 的视图始终等于策略结果：

1. 在 Agent scope 之下解析注册表的中立胜出项。
2. 在 Agent scope 注册一个 provider（`skill-manager-policy`），其低 rank 候选只遮蔽被策略收紧的 Skill；正文通过 `get` 实时从底层注册表加载。
3. 由现有胜出规则和调用检查统一应用结果。
4. 在策略、Workspace、Preset 或 Skill 发现结果变化时重建 provider。

插件不会在胜出选择之前过滤，因此禁用高优先级候选不会意外暴露同名的低优先级 Skill。

未来 Harness 若提供 `getVisible`/`snapshotVisible` 等 audience-aware 核心方法，可以替换为对应适配器；持久化策略与浏览器 API 不需要改变。

详见 [`docs/architecture.zh-CN.md`](docs/architecture.zh-CN.md) 和 [`docs/security.zh-CN.md`](docs/security.zh-CN.md)。

## 安装

安装说明将在首次构建验证后最终确定。计划使用 Harness 官方支持的 Profile 插件命令：

```powershell
dsh plugin --profile web add dsh-skill-manager
```

该包贡献自己的 Bundle Patch，不修改 shipped `web` Profile 或 Agent Preset。

## 开发安全

如果开发机器可能正在执行 Harness 任务，则构建、测试、类型检查、Lint、运行时加载和浏览器验证都不会在未得到操作者明确确认时执行。

## 许可证

MIT
