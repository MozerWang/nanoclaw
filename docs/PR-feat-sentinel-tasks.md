# PR Report: Sentinel Mode for Scheduled Tasks

**Branch:** `feat/sentinel-tasks`
**Files Changed:** 9 files, +253 / -16 lines
**Date:** 2026-03-22

---

## 动机

NanoClaw 的定时任务系统目前对每次触发都执行完整的 Agent 流程：启动容器（~1-3s）→ TypeScript 编译（~5-15s）→ Claude SDK 初始化 → LLM 调用。这对低频任务（天级/小时级）完全合理，但对高频监控类任务（每 5-15 分钟）会产生大量不必要的 token 消耗。

以"每 5 分钟监控一个网页是否变化"为例：

| 指标 | 无 Sentinel | 有 Sentinel（99% 无变化） |
|------|-----------|------------------------|
| 每天容器启动 | 288 次 | ~3 次 |
| 每天 LLM 调用 | 288 次 | ~3 次 |
| 每天 token 消耗 | 全量 × 288 | 全量 × 3 |
| **节省比例** | — | **~99%** |

核心矛盾在于：大多数高频监控任务的"检查"环节是确定性的（curl、diff、grep），不需要 LLM 参与；只有"分析和响应"环节才需要 Agent 推理。

---

## 改进点

### 1. Sentinel 执行引擎（宿主机侧）

**文件：** `src/task-scheduler.ts`（+117 行）

在 `runTask()` 函数中插入哨兵前置检查分支，实现三条执行路径：

| 路径 | 条件 | 行为 | 成本 |
|------|------|------|------|
| **跳过** | sentinel 脚本 exit 0 | 记录日志，更新 next_run，不启动容器 | ~100ms，零 token |
| **触发** | sentinel 脚本 exit 非 0 | 将 stdout 注入 Agent prompt 作为上下文，启动容器 | 正常 Agent 成本 |
| **维护** | 距上次维护超过 7 天 | 要求 Agent 审查并更新 sentinel 脚本 | 正常 Agent 成本 |

关键实现：

```typescript
function runSentinelScript(scriptPath: string): Promise<SentinelResult> {
  return new Promise((resolve) => {
    execFile('/bin/bash', [scriptPath], 
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          triggered: exitCode !== 0,
          stdout: stdout.trim(),
          // ...
        });
      });
  });
}
```

**安全设计：**
- 脚本在宿主机执行，超时 30 秒自动终止
- 脚本存储在 group folder 下的 `sentinels/` 目录，每个 group 隔离
- stdout 限制 1MB，防止异常输出撑爆内存

### 2. 数据模型扩展

**文件：** `src/types.ts`（+2 行）、`src/db.ts`（+38 行）

`ScheduledTask` 新增两个字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sentinel_script` | `string \| null` | 脚本路径（相对于 group folder），如 `sentinels/task-xxx.sh` |
| `sentinel_maintain_at` | `string \| null` | 上次维护时间戳，用于触发定期审查 |

数据库 migration 采用 `ALTER TABLE ADD COLUMN` 模式，向后兼容——现有任务的这两个字段默认为 `null`，行为完全不变。

### 3. MCP 工具扩展（容器内）

**文件：** `container/agent-runner/src/ipc-mcp-stdio.ts`（+55 行）

#### `schedule_task` — 新增 `sentinel_enabled` 参数

当 `sentinel_enabled=true` 时：
1. 工具自动计算脚本路径 `sentinels/{task-id}.sh`
2. 将 `[SENTINEL SETUP REQUIRED]` 指引注入 prompt，要求 Agent 在首次执行时生成检查脚本
3. 工具描述中内嵌了完整的 sentinel 脚本约定和示例，引导 Agent 生成正确格式的脚本

#### `update_task` — 新增 `sentinel_script` 参数

允许 Agent 在后续交互中设置或更新 sentinel 脚本路径。传入空字符串可禁用 sentinel 模式。

### 4. IPC 透传

**文件：** `src/ipc.ts`（+25 行）

- `schedule_task` IPC 消息透传 `sentinel_script` 字段
- `update_task` IPC 消息支持更新 sentinel 相关字段
- 创建任务时自动设置 `sentinel_maintain_at` 为当前时间

---

## 完整工作流

```
用户："每 5 分钟监控 pricing 页面，价格变了告诉我"
    ↓
Agent 调用 schedule_task(sentinel_enabled=true, schedule_type="cron", schedule_value="*/5 * * * *")
    ↓
┌── 第一次运行 ─────────────────────────────────────────────────────┐
│  Agent 完整执行：                                                  │
│  1. curl 目标页面，记录价格快照到 sentinels/pricing-snapshot.txt    │
│  2. 生成 sentinels/{task-id}.sh 检查脚本                          │
│  3. 回复用户："已设置监控"                                         │
└──────────────────────────────────────────────────────────────────┘
    ↓
┌── 后续 99% 的运行（哨兵检查，零 token）────────────────────────────┐
│  宿主机直接执行 bash 脚本 → exit 0 → 跳过 → ~100ms 完成           │
└──────────────────────────────────────────────────────────────────┘
    ↓
┌── 检测到变化时（哨兵触发）──────────────────────────────────────────┐
│  脚本 exit 1，stdout 输出 diff 内容                                │
│  → 启动容器，Agent 收到 [SENTINEL ALERT] + diff 上下文             │
│  → Agent 分析变化，生成自然语言摘要推送给用户                       │
└──────────────────────────────────────────────────────────────────┘
    ↓
┌── 每 7 天一次（自动维护）──────────────────────────────────────────┐
│  强制唤醒 Agent，要求审查脚本是否因外部变化（如网站改版）而失效      │
│  Agent 更新脚本后继续哨兵模式                                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 适用场景

Sentinel 模式最适合**高频检查、低频变化、变化时需要智能分析**的任务：

| 场景 | 哨兵检查方式 | Agent 介入时机 |
|------|-------------|---------------|
| 网页/竞品监控 | `curl` + `diff` 对比快照 | 页面内容变化 |
| 价格追踪 | `curl` API + `jq` 比较阈值 | 价格超过/跌破阈值 |
| 服务健康检查 | `curl -f` 检查 HTTP 状态码 | 服务不可达或超时 |
| GitHub 仓库动态 | GitHub API + `jq` 检查新 Issue/PR 数量 | 有新增 Issue/PR |
| SSL 证书到期 | `openssl s_client` 检查到期日 | 证书即将过期 |
| 日志异常检测 | `grep` / `wc -l` 统计错误数 | 错误数超过阈值 |

**不适用场景：** 每次都需要 LLM 生成内容的任务（如"每天早上写一份简报"），因为没有可跳过的检查环节。

---

## 兼容性说明

- **向后兼容：** 现有定时任务不受任何影响。`sentinel_script` 默认为 `null`，走原有的完整 Agent 路径
- **新建任务默认关闭：** `sentinel_enabled` 参数默认 `false`，只有显式启用才会生效
- **数据库 migration 安全：** 使用 `ALTER TABLE ADD COLUMN` + `try/catch`，重复执行不会报错
- **跨平台：** sentinel 脚本通过 `/bin/bash` 执行，macOS 和 Linux 均支持

---

## 测试状态

| 测试项 | 结果 |
|--------|------|
| TypeScript 编译 | ✅ 零错误 |
| 全量测试（219 个用例） | ✅ 全部通过 |
| Lint 检查 | ✅ 零警告 |
| Prettier 格式化 | ✅ 已通过 pre-commit hook |

---

## 提交历史

| Commit | 描述 |
|--------|------|
| `d8db443` | feat: add sentinel mode for scheduled tasks to reduce token usage |
| `1436360` | style: apply prettier formatting from pre-commit hook |
