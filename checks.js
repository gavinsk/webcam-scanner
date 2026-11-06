// checks.js — page quality and orientation checks for the webcam scanner.
//
// Quality (blur / lighting) is plain pixel math: instant, no libraries.
// Orientation uses Tesseract.js OCR. Handwriting is ignored on purpose: we only
// count words Tesseract reads with high confidence, which in practice means the
// printed text on a worksheet. The rotation that yields the most such words wins.
(function () {
  // Thresholds are first guesses. Tune them against real sample scans
  // (open the scanner with ?debug in the URL to see the measured numbers).
  const CONFIG = {
    blurMin: 20,           // sharpness below this = blurry (synthetic tests: sharp ≈ 65, 2px blur ≈ 8)
    darkMax: 70,           // mean brightness (0-255) below this = too dark
    brightMin: 240,        // mean brightness above this = washed out
    contrastMin: 20,       // brightness std-dev below this = low contrast / blank
    qualityLongEdge: 800,  // quality is measured on a copy this size, so numbers are comparable
    ocrLongEdge: 2000,     // OCR runs on a copy scaled to this size (small printed labels need it big)
    wordConfMin: 75,       // a general word counts only if Tesseract is at least this confident
    // Printed labels expected on the pages (engineering notebook + common worksheet headers).
    // Finding one of these is strong evidence the rotation is right; they almost never
    // appear by accident in upside-down or sideways text.
    // (Not "PROPRIETARY": some notebooks print that box sideways relative to the page.)
    keywords: ['title', 'designed', 'witnessed', 'date', 'name', 'period', 'class'],
    keywordConfMin: 50,
    keywordWeight: 3,      // one keyword counts as this many confident words
    minScore: 3,           // need at least this score to trust a rotation
    minMargin: 3,          // ...and the winner must beat the runner-up by this much
  };

  // Draw `source` rotated clockwise by `deg` (0/90/180/270), optionally scaled
  // so its long edge is `longEdge` pixels (up or down). Returns a new canvas.
  function rotateToCanvas(source, w, h, deg, longEdge) {
    const s = longEdge ? longEdge / Math.max(w, h) : 1;
    const sw = Math.round(w * s), sh = Math.round(h * s);
    const swap = deg % 180 !== 0;
    const c = document.createElement('canvas');
    c.width = swap ? sh : sw;
    c.height = swap ? sw : sh;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(source, -sw / 2, -sh / 2, sw, sh);
    return c;
  }

  // --- Quality: sharpness, brightness, contrast ---
  function measureQuality(source, w, h) {
    const s = Math.min(1, CONFIG.qualityLongEdge / Math.max(w, h));
    const cw = Math.max(3, Math.round(w * s)), ch = Math.max(3, Math.round(h * s));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, cw, ch);
    const d = ctx.getImageData(0, 0, cw, ch).data;

    const g = new Float32Array(cw * ch);
    let sum = 0;
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      const v = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      g[i] = v; sum += v;
    }
    const brightness = sum / g.length;
    let sq = 0;
    for (let i = 0; i < g.length; i++) sq += (g[i] - brightness) ** 2;
    const contrast = Math.sqrt(sq / g.length);

    // Smooth with a 3×3 box first so webcam grain doesn't read as "detail".
    const sm = new Float32Array(g.length);
    for (let y = 1; y < ch - 1; y++) {
      for (let x = 1; x < cw - 1; x++) {
        const i = y * cw + x;
        sm[i] = (g[i - cw - 1] + g[i - cw] + g[i - cw + 1] + g[i - 1] + g[i] + g[i + 1] +
                 g[i + cw - 1] + g[i + cw] + g[i + cw + 1]) / 9;
      }
    }
    // Variance of the Laplacian: sharp edges give large values, blur flattens them.
    let ls = 0, ls2 = 0, n = 0;
    for (let y = 2; y < ch - 2; y++) {
      for (let x = 2; x < cw - 2; x++) {
        const i = y * cw + x;
        const l = sm[i - cw] + sm[i + cw] + sm[i - 1] + sm[i + 1] - 4 * sm[i];
        ls += l; ls2 += l * l; n++;
      }
    }
    const lm = ls / n;
    // Divide by contrast² so a dim-but-sharp photo isn't mistaken for a blurry one.
    const sharpness = 1000 * (ls2 / n - lm * lm) / Math.max(1, contrast * contrast);

    const problems = [];
    if (brightness < CONFIG.darkMax) problems.push('too dark');
    else if (brightness > CONFIG.brightMin) problems.push('washed out');
    if (contrast < CONFIG.contrastMin) problems.push('faint (low contrast)');
    if (sharpness < CONFIG.blurMin) problems.push('blurry');

    return {
      ok: problems.length === 0,
      problems,
      sharpness: Math.round(sharpness),
      brightness: Math.round(brightness),
      contrast: Math.round(contrast),
    };
  }

  // --- Orientation via OCR ---
  let workerPromise = null;
  function getWorker() {
    if (typeof Tesseract === 'undefined') return Promise.reject(new Error('Tesseract.js not loaded'));
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('eng').catch(err => { workerPromise = null; throw err; });
    }
    return workerPromise;
  }

  // Start downloading the OCR engine early (e.g. when the camera starts).
  function warmUp() { getWorker().catch(() => {}); }

  // Score one rotation: confident general words + weighted printed-label hits.
  function scoreWords(data) {
    let words = 0, keywords = 0;
    const found = [];
    for (const w of data.words || []) {
      const t = w.text.replace(/[^A-Za-z]/g, '');
      if (CONFIG.keywords.includes(t.toLowerCase()) && w.confidence >= CONFIG.keywordConfMin) {
        keywords++; found.push(t.toUpperCase());
      } else if (w.confidence >= CONFIG.wordConfMin && t.length >= 3 && /^[A-Za-z]+$/.test(w.text.replace(/[.,;:!?()"'“”‘’\-_]/g, ''))) {
        words++; found.push(t);
      }
    }
    return { score: words + CONFIG.keywordWeight * keywords, found };
  }

  // One OCR job at a time; captures queue up behind each other.
  let queue = Promise.resolve();

  // Returns { status: 'ok', rotation, scores }  — rotate clockwise by `rotation` to make it upright
  //         { status: 'unknown', scores }       — not enough printed text to decide
  //         { status: 'unavailable', error }    — OCR engine failed to load
  function detectOrientation(source, w, h) {
    const job = queue.then(() => detectNow(source, w, h));
    queue = job.catch(() => {});
    return job;
  }

  async function detectNow(source, w, h) {
    let worker;
    try { worker = await getWorker(); }
    catch (err) { return { status: 'unavailable', error: String(err) }; }

    const scores = {}, found = {};
    const decide = () => {
      const ranked = Object.entries(scores).map(([d, s]) => [Number(d), s]).sort((a, b) => b[1] - a[1]);
      const [best, second = [null, 0]] = ranked;
      return (best[1] >= CONFIG.minScore && best[1] - second[1] >= CONFIG.minMargin) ? best[0] : null;
    };

    // Students scan sideways, so try the two sideways rotations first and stop
    // early if one is a clear winner. Otherwise also try upright and upside down.
    for (const group of [[90, 270], [0, 180]]) {
      for (const deg of group) {
        const c = rotateToCanvas(source, w, h, deg, CONFIG.ocrLongEdge);
        const { data } = await worker.recognize(c);
        const s = scoreWords(data);
        scores[deg] = s.score; found[deg] = s.found;
      }
      const r = decide();
      if (r !== null) return { status: 'ok', rotation: r, scores, found };
    }
    return { status: 'unknown', scores, found };
  }

  window.ScanChecks = { CONFIG, rotateToCanvas, measureQuality, detectOrientation, warmUp };
})();
