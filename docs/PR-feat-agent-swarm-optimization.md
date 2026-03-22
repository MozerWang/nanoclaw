# PR Report: Agent Swarm Optimization

**Branch:** `feat/agent-swarm-optimization`
**Files Changed:** 4 files, +68 / -14 lines（不含本文档）
**Date:** 2026-03-22

---

## 动机

Agent Teams（多智能体协作）模式下，orchestrator 将用户请求拆分给多个 subagent 并行执行。当前实现存在三个问题，随着 subagent 数量增加而恶化：

**问题 1：消息碎片化。** 每个 subagent 完成时产出一个 `result`，`processGroupMessages` 逐条调用 `channel.sendMessage()`。3 个 subagent 并行 = 用户连续收到 3 条独立消息，阅读体验差、通知轰炸。

**问题 2：角色不透明。** `send_message` MCP tool 已支持 `sender` 字段（如 `"Researcher"`），但宿主 IPC 处理层直接忽略了这个字段——`await deps.sendMessage(data.chatJid, data.text)`，`data.sender` 被丢弃。用户无法区分消息来自哪个 subagent。

**问题 3：容器槽位浪费。** `IDLE_TIMEOUT` 固定 30 分钟。如果容器启动后 Agent 因 API 超时或 SDK bug 卡死、始终不产出 result，容器白白占用一个并发槽位直到 30min 后硬超时。`MAX_CONCURRENT_CONTAINERS=5` 时，5 个卡死容器即可完全阻塞系统。

| 指标 | 改进前 | 改进后 |
|------|--------|--------|
| 3 个 subagent 并行产出 | 3 条独立消息 | 1 条合并消息 |
| IPC 消息来源 | 无法区分 | `[Researcher]` 角色前缀 |
| 卡死容器释放时间 | 30min | 5min（首次输出前） |

---

## 改进点

### 1. Result Debounce — 合并碎片化输出

**文件：** `src/config.ts`（+1 行）、`src/index.ts`（+45 行）

在 `processGroupMessages` 的 `onOutput` 回调中插入 debounce 层。连续到达的 result 被收集到 `pendingSegments` 数组，在 `RESULT_DEBOUNCE_MS`（默认 2s）窗口内无新输出后合并发送：

```typescript
const flushPending = async () => {
  if (pendingSegments.length === 0) return;
  const segments = pendingSegments;
  pendingSegments = [];

  const text =
    segments.length === 1 ? segments[0] : segments.join('\n\n---\n\n');

  await channel.sendMessage(chatJid, text);
  outputSentToUser = true;
};

const scheduleFlush = () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flushPending().catch((err) =>
      logger.error({ group: group.name, err }, 'Failed to flush debounced output'),
    );
  }, RESULT_DEBOUNCE_MS);
};
```

**三个 flush 触发点保证不丢消息：**

| 触发点 | 场景 | 代码位置 |
|--------|------|----------|
| Debounce 超时 | 2s 内无新输出，正常路径 | `scheduleFlush()` 内的 `setTimeout` |
| `status: 'success'` | Agent 完成，立即 flush | `onOutput` 回调中清除 timer 后调用 `flushPending()` |
| 容器退出 | 异常路径兜底 | `runAgent` 返回后、`setTyping(false)` 前 |

**效果对比：**

```
── 改进前 ──                          ── 改进后 ──
消息 1: 搜索结果已整理完毕             搜索结果已整理完毕
消息 2: 代码生成完成                   
消息 3: 测试全部通过                   ---

                                      代码生成完成

                                      ---

                                      测试全部通过
                                      （1 条消息）
```

### 2. IPC Sender 角色前缀

**文件：** `src/ipc.ts`（+5 行 / -2 行）

IPC 消息处理时，如果 `data.sender` 存在，作为 `[Role]` 前缀拼接到发送文本中：

```typescript
const text = data.sender
  ? `[${data.sender}] ${data.text}`
  : data.text;
await deps.sendMessage(data.chatJid, text);
logger.info(
  { chatJid: data.chatJid, sourceGroup, sender: data.sender },
  'IPC message sent',
);
```

**设计选择：** 不修改 `Channel.sendMessage(jid, text)` 的签名。原因：
- 最小侵入——不需要改动 Channel 接口和所有 channel 实现（WhatsApp/Telegram/Slack/Discord）
- 通用兼容——所有 channel 自动显示前缀，无需各自适配
- 未来若某些 channel 需要用 sender 做特殊处理（如 Telegram 的独立 bot 身份），可以在 channel 层面解析 `[Role]` 前缀

**效果对比：**

```
── 改进前 ──                          ── 改进后 ──
Andy: 代码审查完成                    Andy: [Reviewer] 代码审查完成
Andy: 测试用例已编写                  Andy: [Coder] 测试用例已编写
Andy: 文档已更新                      Andy: [Writer] 文档已更新
```

### 3. 自适应 Idle Timeout — 防阻塞

**文件：** `src/config.ts`（+1 行）、`src/index.ts`（+18 行 / -8 行）、`src/group-queue.ts`（+7 行 / -2 行）

将固定的 `IDLE_TIMEOUT` 改为两阶段自适应：

```
容器启动
    │
    ├─── Cold Start Phase ───────────────────┐
    │    timeout = COLD_START_TIMEOUT (5min)  │
    │    hasProducedOutput = false             │
    │                                         │ 5min 无输出 → closeStdin
    ▼                                         │ → 释放容器槽位
首次 result 到达                              │
    │                                         │
    ├─── Active Phase ──────────────────┐    │
    │    timeout = IDLE_TIMEOUT (30min)  │    │
    │    hasProducedOutput = true        │    │
    │                                    │    │
    ▼                                    │    │
后续 result / 新消息 pipe in             │    │
    │    每次 reset timer               │    │
    ...                                  │    │
```

关键实现：

```typescript
let hasProducedOutput = false;

const resetIdleTimer = () => {
  if (idleTimer) clearTimeout(idleTimer);
  const timeout = hasProducedOutput ? IDLE_TIMEOUT : COLD_START_TIMEOUT;
  idleTimer = setTimeout(() => {
    logger.info(
      { group: group.name, phase: hasProducedOutput ? 'idle' : 'cold-start' },
      'Timeout reached, closing container stdin',
    );
    queue.closeStdin(chatJid);
  }, timeout);
};

resetIdleTimer(); // 启动后立即开始 cold-start 倒计时
```

同时改进 `GroupQueue.sendMessage`：当 `isTaskContainer` 为 true 时，不再静默返回 false，而是记录明确日志说明消息将在任务完成后被 drain 机制处理：

```typescript
if (state.isTaskContainer) {
  logger.debug(
    { groupJid },
    'Container running a scheduled task, message will be queued until task completes',
  );
  return false;
}
```

---

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `RESULT_DEBOUNCE_MS` | `2000` | 合并窗口时长（ms）。设为 `0` 恢复逐条发送 |
| `COLD_START_TIMEOUT` | `300000` (5min) | 首次输出前最大等待时间 |
| `IDLE_TIMEOUT` | `1800000` (30min) | 有输出后的空闲等待时间（不变） |

---

## 兼容性说明

- **单 agent 场景：** result 只有一条，debounce 仅引入 2s 延迟（可忽略或设 `RESULT_DEBOUNCE_MS=0` 禁用）
- **现有 channel 无需修改：** 前缀拼接在 IPC 层完成，Channel 接口不变
- **正常 Agent：** 首次 result 一般在 10-30s 内到达，远小于 5min cold-start 阈值
- **不设置 sender 的 subagent：** 行为不变，无前缀
- **高负载复杂任务：** 若确需超过 5min 才能产出首次结果，可通过 `COLD_START_TIMEOUT` 环境变量调大

---

## 测试状态

| 测试项 | 结果 |
|--------|------|
| TypeScript 编译 | ✅ 零错误 |
| 全量测试（219 个用例） | ✅ 全部通过 |
| Prettier 格式化 | ✅ 已通过 pre-commit hook |

---

## 提交历史

| Commit | 描述 |
|--------|------|
| `e3610d4` | feat: agent swarm optimization — debounce, sender prefix, anti-blocking |
