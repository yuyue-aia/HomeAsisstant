# 智能语音对话系统开发计划

更新时间：2026-05-23

## 当前总体架构

```text
本机麦克风
  → VoiceService
  → DialogSession
  → WakeWordService（sherpa-onnx KWS，小余小余）
  → TencentAsrClient（腾讯云实时 ASR WebSocket）
  → OpenAIAgentRuntime（OpenAI Agents SDK）
  → TencentTtsClient（腾讯云 TTS）
  → 本机播放器
```

> 当前项目已实现本机 CLI 常驻进程闭环；`src/gateway/`、`public/voice.html` 和浏览器完整语音助手尚未实现。

## 已完成（核心闭环）

- TypeScript 工程骨架与统一配置（`src/config/env.ts`）
- CLI 入口：`start`、`stop`、`status`、`logs`、`ask`
- 本机音频：`node-microphone` 采集 + 系统播放器播放
- 唤醒：`WakeWordService` 封装 sherpa-onnx KWS（默认词「小余小余」）
- 语音识别：`TencentAsrClient` 实时 WebSocket（含 HMAC-SHA1 签名）
- Agent：`OpenAIAgentRuntime` + 工具 `control_device`、`get_current_time`
- 语音合成：`TencentTtsClient`（基础 + 长文本拆句）
- 对话状态机：`DialogSession`（`idle → listening → thinking → speaking → idle`）
- Home Assistant 工具：白名单 domain + 真实 HTTP 调用，未配置时降级模拟

## 当前启动方式

```bash
cp .env.example .env
# 填写 OPENAI_API_KEY、TENCENTCLOUD_APP_ID/SECRET_ID/SECRET_KEY
npm install
npm run kws:download-model  # 仅首次
npm run start               # 前台启动语音服务
npm run start -- --daemon   # 后台启动
npm run status
npm run logs
npm run stop
```

单次文本问答：

```bash
npm run ask -- "现在几点"
```

本机依赖：

- macOS 录音建议安装 `sox`：`brew install sox`
- 播放器会自动尝试 `ffplay`、`afplay`、`mpg123`、`aplay`
- 可通过 `AUDIO_PLAY_CMD` 覆盖播放器命令

## 离线/半离线测试入口

- 唤醒词文件测试：`npm run kws:test`
- 自定义“小余小余”文件测试：`npm run kws:test:xiaoyu`
- 麦克风 KWS Demo：当前没有 npm script，可直接运行 `node demos/kws-mic-server.js`，再打开 `http://localhost:3010/kws-mic.html`
- Agent 文本：`npm run agent:ask -- "你好"`（需要 `OPENAI_API_KEY`）

## 后续阶段

### 阶段 A：本机体验优化

- 播放中打断（`speaking` 期间检测到唤醒词或新语音输入立即中止）
- VAD 静音判断更精确（目前使用 ASR final + 1.5s 静默）
- 多轮上下文记忆（按 `sessionId` 缓存对话历史）
- TTS 常见短文本缓存

### 阶段 B：稳定性

- 腾讯云 ASR/TTS 自动重连与限流
- OpenAI 调用超时 / 重试 / 预算监控
- 结构化日志归档与脱敏
- `.env` 密钥泄露后的轮换流程

### 阶段 C：智能家居

- Home Assistant 设备发现与中文别名映射（「客厅灯」→ `light.living_room`）
- 高风险动作二次确认（开锁、支付、删除）
- 工具调用审计日志

### 阶段 D：Gateway 与多端接入

- `src/gateway/voice-gateway.ts` HTTP + WebSocket
- `src/gateway/voice-protocol.ts` 协议定义
- `public/voice.html` 浏览器语音助手
- Nginx `wss` 反向代理
- 树莓派 / Mac mini 边缘部署文档
