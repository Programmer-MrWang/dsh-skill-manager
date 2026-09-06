# 安全模型

Skill 内容会直接控制 Agent 行为。即使它以 Markdown 存储，管理 Skill 仍属于安全敏感的创作能力。

## 信任分类

- **shipped/bundled**：可读、可复制，但不可编辑或删除；
- **runtime/remote**：Provider 允许时可读，否则仅显示摘要；默认不可写；
- **用户根目录**：受 Host 策略约束，可写；
- **Workspace 根目录**：仅在当前 sandbox 与审批策略允许时可写。

UI 必须始终显示来源和信任等级，不能把“已安装”视为“可信”。

## 文件系统规则

1. Client 不提交任意绝对路径。
2. Host 将不透明 root/candidate ID 映射到 canonical target。
3. 每次读写都重新检查 canonical containment。
4. 拒绝符号链接和 junction 逃逸。
5. Skill 名称必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`。
6. 导入拒绝绝对路径、`..`、设备文件、链接、过深目录、过多文件和超大内容。
7. 写入必须原子化并检查 revision。
8. 删除默认移入插件回收站；永久删除是独立确认动作。
9. 插件永远不能修改 shipped preset 或包安装目录。

## 文件夹导入

操作者挑选的源文件夹是“Client 永不提交任意绝对路径”这一规则的唯一有意例外：路径由宿主原生目录选择器产生（用户手势），页面无法伪造。导入对源只读，并作为一次全有或全无的宿主操作执行：

- 先预检每个文件夹（必须是真实目录而非符号链接；包含 `SKILL.md` bundle 或恰好一个 Markdown Skill 文件；frontmatter 名称合法且无冲突）；
- 只复制普通文件——拒绝符号链接/联接点、跳过点条目、限制单文件与总大小；
- 目标名来自受管根目录内经过校验的 Skill frontmatter；任何复制失败都会整体回滚；
- Wire 只携带按序索引、状态与名称——绝不携带源路径（页面仅将其保留在本地用于暂存）。

## Wire 规则

Remote 响应只能包含脱离 Host 的 JSON，不能包含：

- Cordis Context、Service、Provider、Agent、Session 或 Scope 对象；
- Provider 的不透明 locator；
- Host canonical 绝对路径；
- 不受限的目录列表；
- 未脱敏的设置 Secret。

## 策略规则

- Skill 作者的 `modelInvocable: false` 和 `userInvocable: false` 是硬门。
- 管理策略只能限制，不能放宽硬门。
- 在胜出选择后过滤，防止被禁用的高优先级候选暴露低优先级同名 Skill。
- 模型目录、加载工具、`/name` 和浏览器菜单必须一致。
- 策略修改只影响未来 step；已经保留到历史中的 Skill 指令不会被追溯删除。

## 供应链

在本地创作流程完善前不实现 Git 安装。未来实现时必须记录来源 URL 和不可变 revision、预览变更、禁止安装后执行，并建议固定 commit。
