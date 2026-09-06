# 架构

## 平面划分

Skill Manager 遵循 Harness 的归属边界：

- **Host 平面**负责持久化、文件修改、信任分类、策略解析、Session/Workspace 观察、Remote 方法和全局 Skill 注册表适配器。
- **Agent Scope**只负责每个 Agent 的覆盖注册和监听器；Fiber 释放时移除全部覆盖。
- **Client 平面**负责 `settings.section` 页面和浏览器状态，只接收不含路径的 JSON DTO，绝不直接访问文件系统。

## 策略模型

作用域从低到高为：

```text
全局 < Preset < Workspace < Session
```

最具体且不是 `inherit` 的决策胜出。Skill 作者声明的调用权限是硬门：管理策略可以进一步限制，但不能重新启用作者已经禁用的模型或用户调用入口。

策略文档带版本：

```ts
type SkillPolicyMode = 'inherit' | 'all' | 'allow-list' | 'deny-list'
type SkillPolicyDecision = 'inherit' | 'allow' | 'deny'

interface SkillPolicyDocumentV1 {
  version: 1
  mode: SkillPolicyMode
  overrides: Record<string, SkillPolicyDecision>
}
```

## Host 模块

### `SkillAuthoringService`

负责可写根目录、候选枚举、读取、校验、新建、更新、复制、移入回收站、恢复和永久删除。写入采用原子操作并携带不透明版本；浏览器只传 `rootId` 和 `candidateId`。

### `SkillPolicyService`

负责全局、Preset、Workspace 和 Session 策略持久化、合并与解释。Session API 允许时采用追加式 Session 状态；针对 `0.1.2-alpha.5` 提供带版本的外部存储兼容层。

### `SkillRuntimeAdapter`

在 `0.1.2-alpha.5` 上（核心没有过滤接缝），适配器让每个活动 Agent 的生效视图始终等于分层策略的结果：

1. Preset 行把 Skill Provider 注册在 Agent 自身作用域；适配器先卸载上一个覆盖，再在同一作用域读取中立胜出项。
2. `computeOverlayRestrictions` 只保留策略生效后与作者调用标志不同的 Skill —— 策略只能收紧。
3. 在 Agent scope 注册一个 provider（`skill-manager-policy`，rank 1），其候选遮蔽这些名字；scope 层在同名竞争时胜出，因此禁用高优先级 Skill 不会让同名低优先级版本穿透。
4. 正文在重算时快照进 provider（底层胜出项与覆盖同作用域，实时委托会递归），由 provider 的存储定义直接返回。
5. 策略、目录、Preset 或会话状态变化时重建 provider（`agent/created`、`agent/disposed`、`skills/change`、策略 watch）。

未来核心若提供 audience-aware API，可换用对应适配器。

### `SkillManagerController`

在 `skillManager/*` 下暴露严格 Remote DTO。错误使用稳定 code；绝不把 live Cordis 对象、Provider locator 或 Host 绝对路径传给浏览器。

## Client 模块

Client 向以下 Slot 添加页面：

```text
settings.section / id=skills
```

页面包含：

1. **已安装**：胜出与被遮蔽候选、信任来源和诊断；
2. **策略**：全局/Preset/Workspace/Session 继承和最终预览；
3. **编辑器**：结构化 frontmatter、Markdown 正文和冲突 Diff；
4. **导入与回收站**：多文件夹导入（原生目录选择器可多次挑选并暂存多个文件夹，每个文件夹须含一个 Skill；`importFolders` 一次调用预检全部、逐项返回结果且整体原子回滚）+ 可恢复删除。

## 一致性不变量

对同一个 Agent step，下列入口必须看到同一份最终策略：

```text
模型 <available_skills>
skill(name) 工具
显式 /name 注入
Web Slash 候选
```

## 生命周期

每个 Provider、覆盖项、Event listener、Remote binding、locale 字典、Slot 注册、watcher 和 timer 都由 Cordis Fiber 拥有并有准确 disposer。插件更新或删除后不得残留策略或 UI。
