# PR Report: Terminal Channel & Moonshot SDK 兼容

**Branch:** `feat/terminal-channel`
**Files Changed:** 5 files, +260 / -12 lines
**Date:** 2026-03-22

---

## 动机

NanoClaw 的消息渠道系统（WhatsApp/Telegram/Slack/Discord）依赖外部服务认证，给本地开发和调试带来了不必要的摩擦。在初始 setup 阶段，不配置任何渠道就意味着服务无法启动、Agent 无法测试。

同时，NanoClaw 当前硬绑定 Anthropic API，而 Claude API 的调用成本较高。国内开发者更希望使用 Moonshot（kimi-k2.5）等兼容 Anthropic 协议的模型，但现有的 credential-proxy 存在两个缺陷导致无法对接第三方 provider。

本 PR 解决了两个痛点：**零配置本地调试** 和 **低成本第三方模型接入**。

---

## 改进点

### 1. Terminal Channel（新增渠道）

**新增文件：** `src/channels/terminal.ts`（189 行）

| 特性 | 说明 |
|------|------|
| 输入 | 通过 Node.js `readline` 读取 `process.stdin`，每行作为一条消息 |
| 输出 | Agent 回复通过 `process.stdout` 打印，带 ANSI 颜色区分 |
| JID | 使用 `terminal://local` 伪 JID，与现有渠道完全隔离 |
| 自动注册 | 启动时自动注册为 main group（无需触发词），创建 `groups/terminal/` 目录 |
| 启用方式 | `.env` 中设置 `TERMINAL_CHANNEL=true`，或通过环境变量传入 |
| TTY 感知 | 交互模式下显示彩色 banner、输入提示符、"thinking…" 状态；管道模式下纯文本输出 |
| 退出命令 | 输入 `/exit`、`/quit` 或 `/q` 即可退出，无需依赖 Ctrl+C/D |
| 优雅关闭 | TTY 模式 Ctrl+D 立即退出；管道模式等待 Agent 处理完毕后退出 |

**相关改动：**

- `src/channels/index.ts`：注册 terminal 渠道到 barrel import
- `src/config.ts`：新增 `TERMINAL_CHANNEL_ENABLED`，同时支持 `process.env` 和 `.env` 文件读取

### 2. 第三方 LLM Provider 兼容（Moonshot kimi-k2.5）

解决了 credential-proxy 对接第三方 Anthropic 兼容 API 时的三个关键问题：

#### Bug 1：URL 路径前缀丢失

**文件：** `src/credential-proxy.ts`

Moonshot 的 Anthropic 兼容 endpoint 为 `https://api.moonshot.cn/anthropic`，其中 `/anthropic` 是路径前缀。但 proxy 转发时直接使用容器发来的 `/v1/messages` 作为路径，忽略了 `ANTHROPIC_BASE_URL` 中的路径部分，导致请求打到了错误的 URL 返回 404。

**修复：** 在转发前拼接 base URL 的 pathname 前缀：

```typescript
const basePath = upstreamUrl.pathname.replace(/\/$/, '');
const upstreamPath = basePath + (req.url ?? '/');
```

#### Bug 2：Model 名称不兼容

**文件：** `src/credential-proxy.ts`

Claude Code SDK 内部有模型名白名单，只接受 `claude-*` 格式的名称。直接设置 `ANTHROPIC_MODEL=kimi-k2.5` 会被 SDK 在本地拒绝，请求根本不会发出。

**修复：** 采用两层模型名策略：
- **容器内（SDK 层）：** 环境变量使用合法的 Claude 模型名（如 `claude-sonnet-4-5`），通过 SDK 的本地校验
- **Proxy 层（HTTP 层）：** 读取 `.env` 中的 `ANTHROPIC_MODEL=kimi-k2.5`，在转发 HTTP 请求时替换 JSON body 中的 `model` 字段

```typescript
if (overrideModel && body.length > 0) {
  const json = JSON.parse(body.toString('utf-8'));
  if (json && typeof json === 'object' && 'model' in json) {
    json.model = overrideModel;
    body = Buffer.from(JSON.stringify(json), 'utf-8');
  }
}
```

#### Bug 3：模型环境变量未注入容器

**文件：** `src/container-runner.ts`

容器启动时缺少模型相关的环境变量，SDK 会回退到默认模型名。

**修复：** `buildContainerArgs` 中从 `.env` 读取并注入 `ANTHROPIC_DEFAULT_*_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`、`ENABLE_TOOL_SEARCH` 等变量到容器。`ANTHROPIC_MODEL` 故意不注入（仅供 proxy 读取）。

---

## 配置示例

在 `.env` 文件中添加以下配置即可同时启用 Terminal 渠道和 Moonshot 模型：

```env
# Terminal 渠道
TERMINAL_CHANNEL=true

# Moonshot Kimi K2.5
ANTHROPIC_BASE_URL=https://api.moonshot.cn/anthropic
ANTHROPIC_API_KEY=<your-moonshot-api-key>

# Proxy 层替换为 kimi-k2.5，容器内用合法 Claude 名
ANTHROPIC_MODEL=kimi-k2.5
ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-5
ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5
CLAUDE_CODE_SUBAGENT_MODEL=claude-haiku-4-5
ENABLE_TOOL_SEARCH=false
```

启动：

```bash
npm run dev
```

---

## 效果

### Terminal Channel

```
──────────────────────────────────────────────────
NanoClaw Terminal  (type a message and press Enter)
Agent name: Andy  |  /exit to quit
──────────────────────────────────────────────────
You > 你好，用一句话介绍一下你自己

Andy > 你好！我是Claude，一个由Anthropic开发的AI助手，可以帮助你完成各种
       任务、回答问题、编写代码、分析文件等。

You >
```

### Moonshot 兼容性验证

| 测试项 | 结果 |
|--------|------|
| Proxy 启动，authMode=api-key | ✅ |
| 直接 curl proxy，model 字段被替换为 kimi-k2.5 | ✅ |
| URL 路径正确拼接 `/anthropic/v1/messages` | ✅ |
| 容器内 SDK 通过模型名校验 | ✅ |
| 端到端：stdin → 消息存储 → 容器 Agent → kimi-k2.5 响应 → stdout | ✅ |

---

## 架构图

```
┌─────────────────────────────────────────────────────────┐
│  Terminal (stdin/stdout)                                │
│  ┌──────────────────┐                                   │
│  │ TerminalChannel   │  readline → onMessage → storeDB  │
│  │ JID: terminal://  │  sendMessage → stdout             │
│  └──────────────────┘                                   │
└──────────────────┬──────────────────────────────────────┘
                   │ message loop
                   ▼
┌──────────────────────────────────────────────────────────┐
│  Container (Docker)                                      │
│  Claude Code SDK                                         │
│  model=claude-sonnet-4-5 (local validation passes)       │
│  ANTHROPIC_BASE_URL → credential-proxy:3001              │
└──────────────────┬───────────────────────────────────────┘
                   │ HTTP POST /v1/messages
                   ▼
┌──────────────────────────────────────────────────────────┐
│  Credential Proxy (localhost:3001)                        │
│  1. Inject x-api-key (Moonshot key)                      │
│  2. Rewrite body.model → "kimi-k2.5"                    │
│  3. Prepend base path → /anthropic/v1/messages           │
└──────────────────┬───────────────────────────────────────┘
                   │ HTTPS
                   ▼
┌──────────────────────────────────────────────────────────┐
│  Moonshot API (api.moonshot.cn/anthropic)                 │
│  model=kimi-k2.5 → 正常响应                              │
└──────────────────────────────────────────────────────────┘
```

---

## 兼容性说明

- **对现有渠道无影响：** Terminal 渠道默认关闭，`TERMINAL_CHANNEL` 未设置时工厂返回 `null`，不影响 WhatsApp/Telegram 等渠道
- **对原有 Anthropic API 无影响：** `ANTHROPIC_MODEL` 未设置时不做 body 替换；`ANTHROPIC_BASE_URL` 默认为 `https://api.anthropic.com`，路径前缀为 `/`，拼接后无变化
- **可扩展性：** 同样的机制适用于其他 Anthropic 兼容 provider（如 AWS Bedrock、GCP Vertex、OpenRouter 等），只需配置对应的 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`

---

## 提交历史

| Commit | 描述 |
|--------|------|
| `79d0840` | feat: add terminal channel for local development and debugging |
| `25cab33` | feat: support alternative LLM providers via model override in credential proxy |
| `20c4dbc` | fix: prepend base URL path prefix when proxying to alternative providers |
| `0ecace7` | feat: add /exit, /quit, /q commands to terminal channel for easy shutdown |
