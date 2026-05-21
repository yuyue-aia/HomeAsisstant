# 智能语音对话系统开发计划

更新时间：2026-05-22

## 总体架构

```
麦克风 → sherpa-onnx KWS（小余小余）
       → 腾讯云 ASR（实时 WebSocket）
       → OpenAI Agents SDK
       → 腾讯云 TTS
       → 浏览器播放
```

## 已完成（核心闭环）

- TypeScript 工程骨架与统一配置（`src/config/env.ts`）
- 唤醒：`WakeWordService` 封装 sherpa-onnx KWS（默认词「小余小余」）
- 语音识别：`TencentAsrClient` 实时 WebSocket（含 HMAC-SHA1 签名）
- Agent：`OpenAIAgentRuntime` + 工具 `control_device`、`get_current_time`
- 语音合成：`TencentTtsClient`（基础 + 长文本拆句）
- 对话状态机：`DialogSession`（idle → listening → thinking → speaking）
- 网关：`src/gateway/server.ts` HTTP + WebSocket
- 前端：`public/voice.html`（采集、可视化、自动播放）
- Home Assistant 工具：白名单域 + 真实 HTTP 调用，未配置时降级模拟

## 启动方式

```bash
cp .env.example .env
# 填写 OPENAI_API_KEY、TENCENTCLOUD_APP_ID/SECRET_ID/SECRET_KEY
npm install
npm run kws:download-model  # 仅首次
npm run gateway
```

打开浏览器：

```
http://localhost:3020/voice.html
```

操作步骤：

1. 点击「开始」并允许麦克风权限
2. 对着电脑说「小余小余」
3. 接着说一句话，例如「现在几点了」
4. 系统识别 → Agent 回答 → TTS 播报

## 离线测试入口（不需要腾讯云）

- 唤醒词：`npm run kws:mic` → http://localhost:3010/kws-mic.html
- Agent 文本：`npm run agent:ask -- "你好"`（需要 OPENAI_API_KEY）

## 后续阶段

### 阶段 A：体验优化

- 播放中打断（speaking 期间检测到唤醒词或新语音输入立即中止）
- VAD 静音判断更精确（目前使用 ASR final + 1.5s 静默）
- 多轮上下文记忆（按 sessionId 缓存对话历史）

### 阶段 B：稳定性

- 腾讯云 ASR/TTS 自动重连与限流
- OpenAI 调用超时 / 重试 / 预算监控
- 结构化日志归档与脱敏

### 阶段 C：智能家居

- Home Assistant 设备发现与中文别名映射（「客厅灯」→ light.living_room）
- 高风险动作二次确认（开锁、支付、删除）
- 工具调用审计日志

### 阶段 D：部署

- pm2 / systemd 守护进程
- Nginx wss 反向代理
- 树莓派 / Mac mini 边缘部署文档
