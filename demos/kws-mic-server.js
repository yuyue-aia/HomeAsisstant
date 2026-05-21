const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const sherpaOnnx = require('sherpa-onnx-node');

const MODEL_DIR = 'models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01';
const DEFAULT_KEYWORDS = 'models/kws/keywords-xiaoyu.txt';
const DEFAULT_PORT = 3010;
const SAMPLE_RATE = 16000;
const COOLDOWN_MS = 1500;

function parseArgs(argv) {
  const args = {
    modelDir: MODEL_DIR,
    keywords: DEFAULT_KEYWORDS,
    port: DEFAULT_PORT,
    debug: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === '--model-dir') {
      args.modelDir = value;
      i += 1;
    } else if (key === '--keywords') {
      args.keywords = value;
      i += 1;
    } else if (key === '--port') {
      args.port = Number(value);
      i += 1;
    } else if (key === '--debug') {
      args.debug = true;
    } else if (key === '--help' || key === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node demos/kws-mic-server.js [options]

Options:
  --model-dir <dir>   KWS model directory. Default: ${MODEL_DIR}
  --keywords <file>   Tokenized keywords file. Default: ${DEFAULT_KEYWORDS}
  --port <number>     HTTP server port. Default: ${DEFAULT_PORT}
  --debug             Enable sherpa-onnx debug logs

Open:
  http://localhost:${DEFAULT_PORT}/kws-mic.html`);
}

function mustExist(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function buildConfig(args) {
  const modelDir = path.resolve(args.modelDir);
  const config = {
    featConfig: {
      sampleRate: SAMPLE_RATE,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
        decoder: path.join(modelDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
        joiner: path.join(modelDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx'),
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: args.debug ? 1 : 0,
    },
    keywordsFile: path.resolve(args.keywords),
  };

  mustExist(config.modelConfig.transducer.encoder, 'encoder');
  mustExist(config.modelConfig.transducer.decoder, 'decoder');
  mustExist(config.modelConfig.transducer.joiner, 'joiner');
  mustExist(config.modelConfig.tokens, 'tokens');
  mustExist(config.keywordsFile, 'keywords file');

  return config;
}

function pcm16ToFloat32(buffer) {
  const samples = new Float32Array(buffer.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    const value = buffer.readInt16LE(i * 2);
    samples[i] = value / 32768;
  }
  return samples;
}

function createServer() {
  const publicDir = path.resolve('public');

  return http.createServer((req, res) => {
    const urlPath = req.url === '/' ? '/kws-mic.html' : req.url;
    const filePath = path.join(publicDir, path.normalize(urlPath));

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (error, content) => {
      if (error) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
  });
}

function main() {
  const args = parseArgs(process.argv);
  const config = buildConfig(args);
  const kws = new sherpaOnnx.KeywordSpotter(config);
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let stream = kws.createStream();
    let lastWakeAt = 0;

    ws.send(JSON.stringify({ type: 'ready', message: 'KWS 服务已连接，请说“小余小余”' }));

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;

      const samples = pcm16ToFloat32(Buffer.from(data));
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });

      while (kws.isReady(stream)) {
        kws.decode(stream);
        const keyword = kws.getResult(stream).keyword;
        const now = Date.now();

        if (keyword && now - lastWakeAt > COOLDOWN_MS) {
          lastWakeAt = now;
          console.log(`[WAKE] ${keyword}`);
          ws.send(JSON.stringify({ type: 'wake', keyword }));
          stream = kws.createStream();
          break;
        }
      }
    });
  });

  server.listen(args.port, () => {
    console.log(`KWS mic demo: http://localhost:${args.port}/kws-mic.html`);
    console.log(`Keywords: ${config.keywordsFile}`);
    console.log('Press Ctrl+C to stop.');
  });
}

try {
  main();
} catch (error) {
  console.error(error.message);
  console.error('\nRun first: npm install && npm run kws:download-model');
  process.exit(1);
}
