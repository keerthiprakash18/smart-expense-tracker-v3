import { createWorker, PSM } from 'tesseract.js';
import { simd, relaxedSimd } from 'wasm-feature-detect';
import workerAsset from 'tesseract.js/dist/worker.min.js?url';
import languageAsset from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';
import loaderAsset from './receiptOcrCore.js?url&no-inline';
import coreBase from 'tesseract.js-core/tesseract-core-lstm.js?url';
import wasmBase from 'tesseract.js-core/tesseract-core-lstm.wasm?url';
import coreSimd from 'tesseract.js-core/tesseract-core-simd-lstm.js?url';
import wasmSimd from 'tesseract.js-core/tesseract-core-simd-lstm.wasm?url';
import coreRelaxed from 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.js?url';
import wasmRelaxed from 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm?url';

let engine;
let busy = false;
const asset = (path) => {
  const url = new URL(path, globalThis.location.href);
  if (url.origin !== globalThis.location.origin) throw new Error('Cross-origin OCR assets are forbidden');
  return url.href;
};

async function initialize() {
  const variant = await relaxedSimd() ? [coreRelaxed, wasmRelaxed] : await simd() ? [coreSimd, wasmSimd] : [coreBase, wasmBase];
  const path = new URL(asset(workerAsset));
  path.searchParams.set('ocrCoreScript', asset(variant[0]));
  path.searchParams.set('ocrCoreWasm', asset(variant[1]));
  const langPath = new URL('.', asset(languageAsset)).href;
  path.searchParams.set('ocrLanguageAsset', asset(languageAsset));
  path.searchParams.set('ocrLanguageRequest', new URL('eng.traineddata.gz', langPath).href);
  const worker = await createWorker('eng', 1, {
    workerPath: path.href, corePath: asset(loaderAsset), workerBlobURL: false,
    langPath, cacheMethod: 'none', logging: false,
    errorHandler: () => {},
    logger: ({ status, progress }) => {
      const known = ['loading tesseract core', 'initializing tesseract', 'loading language traineddata', 'initializing api', 'recognizing text'];
      globalThis.postMessage({ type: 'progress', status: known.includes(status) ? status : 'preparing local OCR', progress: Math.max(0, Math.min(1, Number(progress) || 0)) });
    },
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1', user_defined_dpi: '200' });
  return worker;
}

globalThis.onmessage = async ({ data }) => {
  if (data?.type !== 'recognize' || busy || !(data.bytes instanceof ArrayBuffer)) return;
  busy = true;
  try {
    engine ||= await initialize();
    const result = await engine.recognize(new Uint8Array(data.bytes), {}, { text: true, blocks: false, hocr: false, tsv: false });
    globalThis.postMessage({ type: 'result', text: result.data.text, confidence: result.data.confidence });
  } catch {
    globalThis.postMessage({ type: 'error', message: 'Local OCR could not initialize or read this image. Check that the app’s OCR assets loaded, or try a clearer JPEG/PNG image in a current browser.' });
  } finally { busy = false; }
};
