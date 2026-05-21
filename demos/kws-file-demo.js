const fs = require('node:fs');
const path = require('node:path');
const sherpaOnnx = require('sherpa-onnx-node');

const MODEL_DIR = 'models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01';

function parseArgs(argv) {
  const args = {
    modelDir: MODEL_DIR,
    keywords: null,
    wav: null,
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
    } else if (key === '--wav') {
      args.wav = value;
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
  node demos/kws-file-demo.js [options]

Options:
  --model-dir <dir>   KWS model directory. Default: ${MODEL_DIR}
  --keywords <file>   Tokenized keywords file. Default: <model-dir>/test_wavs/test_keywords.txt
  --wav <file>        WAV file to test. Default: <model-dir>/test_wavs/3.wav
  --debug             Enable sherpa-onnx debug logs

Examples:
  npm run kws:test
  node demos/kws-file-demo.js --wav ./your-16bit-mono.wav --keywords models/kws/keywords-xiaojia.txt`);
}

function mustExist(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function buildConfig(args) {
  const modelDir = path.resolve(args.modelDir);
  const keywordsFile = path.resolve(args.keywords || path.join(modelDir, 'test_wavs/test_keywords.txt'));

  const config = {
    featConfig: {
      sampleRate: 16000,
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
    keywordsFile,
  };

  mustExist(config.modelConfig.transducer.encoder, 'encoder');
  mustExist(config.modelConfig.transducer.decoder, 'decoder');
  mustExist(config.modelConfig.transducer.joiner, 'joiner');
  mustExist(config.modelConfig.tokens, 'tokens');
  mustExist(config.keywordsFile, 'keywords file');

  return config;
}

function detectKeywords(kws, wavPath) {
  mustExist(wavPath, 'wav file');

  const wave = sherpaOnnx.readWave(wavPath);
  const stream = kws.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });

  const tailPadding = new Float32Array(Math.floor(wave.sampleRate * 0.4));
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: tailPadding });

  const detected = [];
  const startedAt = Date.now();

  while (kws.isReady(stream)) {
    kws.decode(stream);
    const result = kws.getResult(stream);
    if (result.keyword) {
      detected.push(result.keyword);
    }
  }

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const durationSeconds = wave.samples.length / wave.sampleRate;

  return {
    sampleRate: wave.sampleRate,
    durationSeconds,
    elapsedSeconds,
    rtf: elapsedSeconds / durationSeconds,
    detected,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const modelDir = path.resolve(args.modelDir);
  const wavPath = path.resolve(args.wav || path.join(modelDir, 'test_wavs/3.wav'));
  const config = buildConfig(args);

  const kws = new sherpaOnnx.KeywordSpotter(config);
  const result = detectKeywords(kws, wavPath);

  console.log('WAV:', wavPath);
  console.log('Keywords:', config.keywordsFile);
  console.log('Sample rate:', result.sampleRate);
  console.log('Duration:', result.durationSeconds.toFixed(3), 'seconds');
  console.log('Elapsed:', result.elapsedSeconds.toFixed(3), 'seconds');
  console.log('RTF:', result.rtf.toFixed(3));
  console.log('Detected keywords:', result.detected);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  console.error('\nRun first: npm install && npm run kws:download-model');
  process.exit(1);
}
