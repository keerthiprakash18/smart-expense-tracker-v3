// Served as a raw classic-worker asset, not evaluated from receipt content.
// Asset URLs come only from receiptOcrWorker's fixed Vite imports.
(() => {
  const params = new URL(globalThis.location.href).searchParams;
  const asset = (key) => {
    const value = params.get(key);
    if (!value) throw new Error('Missing local OCR core asset');
    const url = new URL(value, globalThis.location.href);
    if (url.origin !== globalThis.location.origin) throw new Error('OCR assets must be same-origin');
    return url.href;
  };
  const script = asset('ocrCoreScript');
  const wasm = asset('ocrCoreWasm');
  const model = asset('ocrLanguageAsset');
  const modelRequest = asset('ocrLanguageRequest');
  const originalFetch = globalThis.fetch.bind(globalThis);
  // Tesseract requests a fixed eng.traineddata.gz name; Vite fingerprints the
  // installed model. Resolve that one logical request to its bundled URL. All
  // other fetches in this OCR worker are denied except the chosen WASM asset.
  globalThis.fetch = (input, init) => {
    const requested = new URL(typeof input === 'string' ? input : input.url || input.href, globalThis.location.href).href;
    const target = requested === modelRequest ? model : requested === wasm ? wasm : null;
    if (!target) return Promise.reject(new Error('Unexpected OCR network resource'));
    return originalFetch(target, { ...init, credentials: 'omit', mode: 'same-origin', redirect: 'error' });
  };
  globalThis.importScripts(script);
  const factory = globalThis.TesseractCore;
  globalThis.TesseractCore = (options) => factory({
    ...options,
    locateFile: (path) => {
      if (path.endsWith('.wasm')) return wasm;
      throw new Error('Unexpected OCR core resource');
    },
  });
})();
