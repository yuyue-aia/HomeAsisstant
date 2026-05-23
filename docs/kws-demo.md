# sherpa-onnx KWS Demo

本 Demo 用于验证本地中文唤醒词检测。

## 1. 安装依赖

```bash
npm install
```

## 2. 下载中文 KWS 模型

```bash
npm run kws:download-model
```

模型会下载到：

```text
models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/
```

## 3. 运行官方测试音频

```bash
npm run kws:test
```

预期会检测出模型自带测试音频中的关键词，例如：

```text
Detected keywords: [ '文森特卡索', '法国' ]
```

## 4. 监听电脑麦克风测试“菜包菜包”

当前 `package.json` 暂未配置 `kws:mic` 脚本，可直接启动本地 Demo 服务：

```bash
node demos/kws-mic-server.js
```

然后打开：

```text
http://localhost:3010/kws-mic.html
```

点击“开始监听”，允许浏览器访问麦克风，然后对着电脑说“菜包菜包”。检测成功时，网页和终端都会显示唤醒结果。

> 正式语音助手链路已封装在 `src/wake/wake-word-service.ts`，它接收外部传入的 `16kHz/16bit/mono PCM`，不直接采集麦克风。

## 5. 用 WAV 文件测试“菜包菜包”

先准备一个 16-bit、单声道 WAV 文件，内容包含“菜包菜包”。然后运行：

```bash
node demos/kws-file-demo.js \
  --wav ./your-caibao.wav \
  --keywords models/kws/keywords-caibao.txt
```

当前自定义关键词文件：

```text
models/kws/keywords-caibao.txt
```

内容：

```text
c ài b āo c ài b āo :2.0 #0.45 @菜包菜包
```

其中：

- `:2.0` 是 boosting score，越大越容易触发；
- `#0.45` 是触发阈值，越低越容易触发；
- 如果误唤醒多，提高阈值，例如 `#0.55`；
- 如果唤醒不灵敏，降低阈值，例如 `#0.35`。

## 6. 重新生成关键词文件

如需严格按模型 token 重新生成，可安装 `sherpa-onnx-cli` 后执行：

```bash
sherpa-onnx-cli text2token \
  --tokens models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/tokens.txt \
  --tokens-type ppinyin \
  models/kws/keywords-raw-caibao.txt \
  models/kws/keywords-caibao.txt
```

## 7. macOS 动态库问题

如果遇到 native library 加载失败，可先执行：

```bash
export DYLD_LIBRARY_PATH=$(npm root)/sherpa-onnx-node/lib:$DYLD_LIBRARY_PATH
```

Linux 对应：

```bash
export LD_LIBRARY_PATH=$(npm root)/sherpa-onnx-node/lib:$LD_LIBRARY_PATH
```
