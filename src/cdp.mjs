import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

class DevTools {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const entry = this.#pending.get(message.id);
        if (!entry) return;
        this.#pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result ?? {});
        return;
      }
      const listeners = this.#listeners.get(message.method) ?? [];
      for (const listener of listeners) listener(message.params ?? {});
    });
    socket.addEventListener('close', () => {
      for (const entry of this.#pending.values()) entry.reject(new Error('Chrome DevTools connection closed'));
      this.#pending.clear();
    });
  }

  static async connect(wsUrl, timeoutMs = 8000) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome DevTools')), timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to Chrome DevTools')); }, { once: true });
    });
    return new DevTools(socket);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const listeners = this.#listeners.get(method) ?? [];
      const finish = value => {
        clearTimeout(timer);
        const current = this.#listeners.get(method) ?? [];
        this.#listeners.set(method, current.filter(listener => listener !== finish));
        resolve(value);
      };
      const timer = setTimeout(() => {
        const current = this.#listeners.get(method) ?? [];
        this.#listeners.set(method, current.filter(listener => listener !== finish));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      listeners.push(finish);
      this.#listeners.set(method, listeners);
    });
  }

  close() { this.#socket.close(); }
}

const CAPTURE_PAGE = String.raw`(() => {
  const visible = element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width >= 2 && box.height >= 2 && style.visibility !== 'hidden'
      && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const normalizedText = element => (element?.innerText ?? element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const candidates = [...document.querySelectorAll('article,[role="main"],main')].filter(visible)
    .map(element => ({ element, text: normalizedText(element), tag: element.tagName.toLowerCase() }))
    .filter(item => item.text.length > 280);
  candidates.sort((a, b) => {
    const priority = value => value === 'article' ? 1_000_000 : value === 'main' ? 500_000 : 0;
    return (priority(b.tag) + b.text.length) - (priority(a.tag) + a.text.length);
  });
  let root = candidates[0]?.element;
  if (!root) {
    const pageTextLength = normalizedText(document.body).length;
    const headline = [...document.querySelectorAll('h1,h2')].find(element => visible(element) && normalizedText(element).length > 24);
    let container = headline;
    const threshold = Math.max(120, pageTextLength * 0.82);
    while (container?.parentElement && normalizedText(container).length < threshold) container = container.parentElement;
    root = container ?? document.body;
  }
  if (!root) throw new Error('The page has no readable body content.');
  const body = normalizedText(root);
  if (body.length < 120) throw new Error('Could not identify a substantial article body.');

  const gridArtifact = element => {
    if (!visible(element) || element.tagName !== 'DIV' || element.closest('figure,table,[role="img"]')) return false;
    const box = element.getBoundingClientRect();
    if (box.width < 280 || box.height < 170 || box.width * box.height < 90000) return false;
    const style = getComputedStyle(element);
    const mode = style.display;
    if (!['grid', 'inline-grid', 'flex', 'inline-flex'].includes(mode)) return false;
    const text = normalizedText(element);
    const semanticBlockCount = element.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol,dl,pre,blockquote,table,figure').length;
    if (text.length > 5000) return false;
    const percentages = text.match(/\b\d+(?:\.\d+)?%/g)?.length ?? 0;
    const children = [...element.children].filter(visible);
    const composedGraphic = element.querySelectorAll('svg,canvas').length >= 2;
    const sizedGroups = new Map();
    for (const child of children) {
      const r = child.getBoundingClientRect();
      const key = (Math.round(r.width / 4) * 4) + 'x' + (Math.round(r.height / 4) * 4);
      sizedGroups.set(key, (sizedGroups.get(key) ?? 0) + 1);
    }
    const repeatedCells = Math.max(0, ...sizedGroups.values()) >= 4;
    const matrixLike = percentages >= 6 && children.length >= 2;
    // Do not turn a whole prose section into an image just because sibling
    // cards happen to share dimensions or the section contains several SVGs.
    // The special matrix case is retained because its colored cells have no
    // semantic table or text representation in the source DOM.
    if (semanticBlockCount > 3 && !matrixLike && !repeatedCells) return false;
    return text.length >= 24 && (matrixLike || repeatedCells || composedGraphic);
  };

  const metricCardCluster = element => {
    if (!visible(element) || element.tagName !== 'DIV') return false;
    const style = getComputedStyle(element);
    if (!['grid', 'inline-grid', 'flex', 'inline-flex'].includes(style.display)) return false;
    const children = [...element.children].filter(visible);
    if (children.length < 3 || children.length > 8) return false;
    const cards = children.map(child => {
      const paragraphs = [...child.querySelectorAll('p')].filter(visible);
      const value = normalizedText(paragraphs[0]);
      return /^\d[\d,.]*(?:\.\d+)?%?$/.test(value)
        && paragraphs.length >= 2
        && normalizedText(child).length <= 1000;
    });
    return cards.length >= 3 && cards.every(Boolean);
  };

  const semanticArtifacts = [...root.querySelectorAll('figure,table,canvas,[role="img"],[role="table"]')]
    .filter(visible);
  const graphics = new Set(semanticArtifacts);
  for (const svg of root.querySelectorAll('svg')) {
    if (visible(svg) && !svg.closest('figure,table,[role="img"]')) {
      const box = svg.getBoundingClientRect();
      const hasTextOrName = normalizedText(svg).length >= 8 || svg.getAttribute('aria-label') || svg.getAttribute('role');
      if (box.width >= 64 && box.height >= 48 && box.width * box.height >= 8000 && (hasTextOrName || box.width * box.height >= 30000)) graphics.add(svg);
    }
  }
  // SVG-backed charts often split bars, axes, and labels across sibling SVGs.
  // Capture their smallest shared visual wrapper so the PDF retains the full
  // chart instead of several clipped fragments.
  for (const svg of root.querySelectorAll('svg')) {
    if (!visible(svg)) continue;
    let group = null;
    for (let parent = svg.parentElement; parent && parent !== root; parent = parent.parentElement) {
      const box = parent.getBoundingClientRect();
      const svgCount = parent.querySelectorAll('svg,canvas').length;
      const semanticCount = parent.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol,dl,pre,blockquote,table,figure').length;
      const text = normalizedText(parent);
      if (svgCount < 2 || box.width < 280 || box.height < 170 || box.height > 800 || text.length >= 1600 || semanticCount > 24) continue;
      group = parent;
      if (/figure\s+\d+\s*\./i.test(text)) break;
    }
    if (group) graphics.add(group);
  }
  for (const image of root.querySelectorAll('img,picture')) {
    if (visible(image) && !image.closest('figure,table,[role="img"]')) {
      const box = image.getBoundingClientRect();
      if (box.width >= 16 && box.height >= 16) graphics.add(image);
    }
  }
  for (const div of root.querySelectorAll('div')) {
    if (gridArtifact(div) || metricCardCluster(div)) graphics.add(div);
  }
  // Page builders commonly make tables from nested divs and omit table roles.
  // An explicit visual table name is a stronger signal than the row heuristic,
  // and retains the separate header row with the repeated data rows.
  for (const table of root.querySelectorAll('[data-framer-name="Table"]')) {
    const box = table.getBoundingClientRect();
    const cellCount = table.querySelectorAll('[data-framer-name="Cell"]').length;
    if (visible(table) && box.width >= 280 && box.height >= 170 && cellCount >= 6
      && normalizedText(table).length < 8000) graphics.add(table);
  }
  // Some builders assemble charts from many SVG and text layers without a
  // semantic figure, table, or grid role. A visible, explicitly named figure
  // caption provides a reliable anchor for capturing its smallest visual
  // parent together with the caption and labels.
  for (const caption of root.querySelectorAll('[data-framer-name]')) {
    if (!/^(?:figure|table)\s+\d+\s*\./i.test(caption.getAttribute('data-framer-name') || '') || !visible(caption)) continue;
    for (let parent = caption.parentElement; parent && parent !== root; parent = parent.parentElement) {
      const box = parent.getBoundingClientRect();
      const descendantCount = parent.querySelectorAll('div,svg,canvas,table,img,[role="img"]').length;
      const parentText = normalizedText(parent);
      if (box.width >= 280 && box.height >= 170 && descendantCount >= 4 && parentText.length < 5000) {
        graphics.add(parent);
        break;
      }
    }
  }

  // Keep a single screenshot for nested semantic wrappers; it retains captions
  // and axis labels that sit adjacent to the chart's SVG or painted cells.
  const artifactNodes = [...graphics].filter(element => !element.closest('nav,footer,[role="navigation"]')).filter(element => {
    for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (graphics.has(parent)) return false;
    }
    return true;
  }).sort((a, b) => {
    const relation = a.compareDocumentPosition(b);
    return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1
      : relation & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  });
  const toSelector = element => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    for (let node = element; node && node !== root.parentElement; node = node.parentElement) {
      let item = node.tagName.toLowerCase();
      const classes = [...node.classList].filter(name => !name.startsWith('framer-motion') && name.length < 80).slice(0, 3);
      if (classes.length) item += '.' + classes.map(CSS.escape).join('.');
      const parent = node.parentElement;
      if (parent) {
        const peers = [...parent.children].filter(peer => peer.tagName === node.tagName);
        if (peers.length > 1) item += ':nth-of-type(' + (peers.indexOf(node) + 1) + ')';
      }
      parts.unshift(item);
      if (node === root) break;
    }
    return parts.join(' > ');
  };
  const blockNodes = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol,dl,pre,blockquote,table,figure,canvas,[role="img"],[role="table"],iframe,video,audio')]
    .filter(visible).filter(element => !element.closest('nav,header,footer,[role="navigation"]'))
    .filter(element => normalizedText(element).toLocaleLowerCase() !== 'go back')
    .filter(element => !artifactNodes.some(artifact => element !== artifact && artifact.contains(element)));
  const inventoryBlocks = blockNodes.length ? blockNodes : [root];
  const blocks = inventoryBlocks.map((element, index) => ({
    id: 'block-' + String(index + 1).padStart(4, '0'),
    kind: element.matches('h1,h2,h3,h4,h5,h6') ? 'heading'
      : element.matches('table,[role="table"]') ? 'table'
      : element.matches('figure,canvas,[role="img"]') ? 'figure'
      : element.matches('iframe,video,audio') ? element.tagName.toLowerCase()
      : element.tagName.toLowerCase(),
    tag: element.tagName.toLowerCase(),
    level: /^H[1-6]$/.test(element.tagName) ? Number(element.tagName[1]) : null,
    text: normalizedText(element).slice(0, 6000),
    selector: toSelector(element),
  }));

  const artifacts = artifactNodes.filter(visible).map((element, index) => {
    const box = element.getBoundingClientRect();
    const selector = toSelector(element);
    const caption = element.querySelector('figcaption') ?? element;
    const label = normalizedText(caption).slice(0, 400) || element.getAttribute('aria-label')
      || element.getAttribute('alt') || element.querySelector('[aria-label]')?.getAttribute('aria-label')
      || element.querySelector('img[alt]')?.getAttribute('alt') || '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let minVisibleTextPx = null;
    while (walker.nextNode()) {
      if (!walker.currentNode.nodeValue.trim()) continue;
      const parent = walker.currentNode.parentElement;
      if (!parent || !visible(parent)) continue;
      const px = Number.parseFloat(getComputedStyle(parent).fontSize);
      if (Number.isFinite(px)) minVisibleTextPx = minVisibleTextPx === null ? px : Math.min(minVisibleTextPx, px);
    }
    const id = 'artifact-' + String(index + 1).padStart(3, '0');
    element.setAttribute('data-archive-marker', id);
    return {
      id,
      kind: element.matches('img,picture') ? 'inline-image'
        : element.matches('table,[role="table"]') ? 'table'
        : element.matches('canvas') ? 'canvas'
        : element.matches('svg') ? 'svg'
        : element.matches('[role="img"]') ? 'accessible-figure'
        : metricCardCluster(element) ? 'metric-cards'
        : gridArtifact(element) ? 'styled-grid'
        : 'figure',
      selector,
      label,
      sourceText: normalizedText(element).slice(0, 6000),
      pageBox: { x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height },
      minVisibleTextPx,
      imageNaturalSize: (element.matches('img') ? [element] : [...element.querySelectorAll('img')]).map(image => {
        const source = image.currentSrc || image.src;
        let pixelWidth = image.naturalWidth;
        for (const candidate of image.srcset.split(',')) {
          const [url, descriptor] = candidate.trim().split(/\s+/);
          if (!url || !descriptor) continue;
          try {
            if (new URL(url, document.baseURI).href !== source) continue;
            const value = Number.parseFloat(descriptor);
            if (descriptor.endsWith('w') && Number.isFinite(value)) pixelWidth = value;
            else if (descriptor.endsWith('x') && Number.isFinite(value)) pixelWidth = image.naturalWidth * value;
          } catch {}
        }
        return { source, width: image.naturalWidth, height: image.naturalHeight,
          pixelWidth, pixelHeight: image.naturalWidth ? pixelWidth * image.naturalHeight / image.naturalWidth : image.naturalHeight,
          animated: /\.gif(?:[?#]|$)/i.test(source) };
      }),
      captureState: 'loaded default view',
    };
  });

  const tabs = [...root.querySelectorAll('[role="tab"],button[aria-controls],input[type="radio"]')]
    .filter(visible).map((element, index) => ({
      id: 'tab-' + String(index + 1).padStart(3, '0'),
      label: normalizedText(element) || element.getAttribute('aria-label') || element.value || '',
      selected: element.getAttribute('aria-selected') === 'true' || element.checked === true,
      selector: toSelector(element),
      panelId: element.getAttribute('aria-controls') || null,
    }));

  const clone = root.cloneNode(true);
  for (const node of clone.querySelectorAll('script,style,noscript,template,form,button,input,select,textarea,iframe,object,embed,nav,footer')) node.remove();
  for (const link of clone.querySelectorAll('a')) {
    if (normalizedText(link).toLocaleLowerCase() === 'go back') link.remove();
  }
  clone.removeAttribute('style');
  for (const node of clone.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || attribute.name === 'style') node.removeAttribute(attribute.name);
    }
  }
  for (const artifact of artifacts) {
    const node = clone.querySelector('[data-archive-marker="' + artifact.id + '"]');
    if (!node) continue;
    const image = document.createElement('img');
    image.src = 'archive-asset:' + artifact.id;
    image.alt = artifact.label || '';
    image.setAttribute('data-archive-captured', 'true');
    node.replaceWith(image);
  }
  for (const node of clone.querySelectorAll('[data-archive-marker]')) node.removeAttribute('data-archive-marker');
  for (const image of clone.querySelectorAll('img,picture')) {
    if (image.hasAttribute('data-archive-captured')) continue;
    const label = image.getAttribute('alt') || image.querySelector('img[alt]')?.getAttribute('alt') || '';
    if (label) image.replaceWith(document.createTextNode('[' + label + ']'));
    else image.remove();
  }
  for (const source of clone.querySelectorAll('source')) source.remove();
  for (const svg of clone.querySelectorAll('svg')) {
    const label = svg.getAttribute('aria-label') || normalizedText(svg);
    if (label) svg.replaceWith(document.createTextNode('[' + label + ']'));
    else svg.remove();
  }
  const allowedAttributes = new Set(['href','src','alt','title','id','start','value','datetime','cite','colspan','rowspan','reversed','type']);
  for (const node of clone.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      const preserveId = attribute.name === 'id' && /^(?:H[1-6]|A|SUP|LI)$/.test(node.tagName);
      const validForTag = (attribute.name === 'href' && node.tagName === 'A')
        || (attribute.name === 'src' && node.tagName === 'IMG');
      if ((!allowedAttributes.has(attribute.name) || !validForTag && ['href','src'].includes(attribute.name))
        || (attribute.name === 'id' && !preserveId)) node.removeAttribute(attribute.name);
    }
  }
  for (const wrapper of clone.querySelectorAll('div,section,main,article,aside')) {
    wrapper.replaceWith(...wrapper.childNodes);
  }
  for (const node of clone.querySelectorAll('[data-archive-captured]')) node.removeAttribute('data-archive-captured');

  const title = normalizedText([...root.querySelectorAll('h1,h2')].find(element => visible(element) && normalizedText(element).length > 24))
    || normalizedText([...document.querySelectorAll('h1,h2')].find(element => visible(element) && normalizedText(element).length > 24))
    || document.querySelector('meta[property="og:title"]')?.content
    || document.title || 'Archived article';
  const author = document.querySelector('meta[name="author"]')?.content ?? '';
  const description = document.querySelector('meta[name="description"]')?.content ?? '';
  const date = document.querySelector('meta[property="article:published_time"]')?.content ?? '';
  return {
    title, author, description, date, bodyText: body, articleHtml: clone.innerHTML,
    articleSelector: toSelector(root),
    articleTag: root.tagName.toLowerCase(),
    articleHeight: root.getBoundingClientRect().height,
    pageTitle: document.title,
    blocks, artifacts, tabs,
    captureViewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, colorScheme: 'light' },
    capturedAt: new Date().toISOString(),
  };
})()`;

function findExecutable(explicitPath, candidates) {
  if (explicitPath) return explicitPath;
  return candidates.find(Boolean);
}

function evaluateResult(result, description) {
  if (result.exceptionDetails) {
    throw new Error(`${description}: ${result.exceptionDetails.text ?? result.exceptionDetails.exception?.description ?? 'page script failed'}`);
  }
  return result.result?.value;
}

export async function captureArticle(url, { browserPath, timeoutMs = 45000 } = {}) {
  const source = new URL(url);
  if (!['http:', 'https:'].includes(source.protocol)) {
    throw new Error('Article capture accepts only http and https URLs.');
  }
  const chromePath = findExecutable(browserPath, process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']);
  if (!chromePath) throw new Error('Google Chrome or Chromium is required. Pass --browser /path/to/chrome.');

  const workDir = await mkdtemp(path.join(tmpdir(), 'article-archive-chrome-'));
  const profileDir = path.join(workDir, 'profile');
  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`, '--window-size=1440,1200', '--force-device-scale-factor=3',
    '--hide-scrollbars', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', 'about:blank',
  ], { stdio: 'ignore' });
  let devtools;
  let page;
  let stage = 'start Chrome';
  try {
    let activePort;
    const activeFile = path.join(profileDir, 'DevToolsActivePort');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited before capture (code ${chrome.exitCode}).`);
      try {
        activePort = (await readFile(activeFile, 'utf8')).split(/\r?\n/)[0].trim();
        if (activePort) break;
      } catch {}
      await delay(100);
    }
    if (!activePort) throw new Error('Chrome did not open a local DevTools endpoint.');
    const base = `http://127.0.0.1:${activePort}`;
    const created = await fetch(`${base}/json/new?about:blank`, { method: 'PUT' });
    if (!created.ok) throw new Error(`Chrome could not create a capture tab (${created.status}).`);
    page = await created.json();
    devtools = await DevTools.connect(page.webSocketDebuggerUrl);
    await devtools.send('Page.enable');
    await devtools.send('Runtime.enable');
    await devtools.send('Network.enable', { maxTotalBufferSize: 20_000_000 });
    await devtools.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1200, deviceScaleFactor: 3, mobile: false,
    });
    await devtools.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: 'light' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
    stage = 'load source page';
    const loaded = devtools.once('Page.loadEventFired', timeoutMs);
    await devtools.send('Page.navigate', { url: source.href }, 15000);
    await loaded;

    // Resolve fonts and page-lazy media using a bounded, reproducible scroll.
    await devtools.send('Runtime.evaluate', {
      expression: `(async () => {
        const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
        let previousHeight = 0;
        for (let step = 0; step < 40; step++) {
          const height = document.documentElement.scrollHeight;
          if (window.scrollY >= height - innerHeight || height === previousHeight) {
            if (step > 5) break;
          }
          previousHeight = height;
          window.scrollTo(0, Math.min((step + 1) * Math.max(innerHeight - 180, 500), height));
          await pause(110);
        }
        window.scrollTo(0, 0);
        await pause(500);
        await document.fonts.ready;
        await Promise.race([Promise.all([...document.images].map(image => image.decode().catch(() => null))), pause(7000)]);
        return { ready: document.readyState, height: document.documentElement.scrollHeight };
      })()`, awaitPromise: true, timeout: 15000,
    }, 20000);
    await delay(900);

    stage = 'snapshot loaded page';
    const raw = await devtools.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, 15000);
    const rawHtml = evaluateResult(raw, 'Could not save the rendered page snapshot');
    if (typeof rawHtml !== 'string' || rawHtml.length < 300) throw new Error('The rendered page snapshot is empty.');
    stage = 'inventory article and artifacts';
    const result = await devtools.send('Runtime.evaluate', { expression: CAPTURE_PAGE, returnByValue: true }, 30000);
    const pageData = evaluateResult(result, 'Could not inventory the rendered article');
    if (!pageData?.blocks?.length) throw new Error(`No readable article blocks were found. Page title: ${pageData?.pageTitle ?? '(none)'}. Body text length: ${pageData?.bodyText?.length ?? 0}.`);

    const assets = [];
    const exceptions = [];
    for (const artifact of pageData.artifacts) {
      const pixelAreaLimit = 16_000_000;
      const width = artifact.pageBox.width;
      const height = artifact.pageBox.height;
      const aspect = width / Math.max(1, height);
      const inlineImage = artifact.kind === 'inline-image';
      const targetDpi = 300;
      const textPx = artifact.minVisibleTextPx;
      const portrait = { width: 6.5, height: 8.1 };
      const landscape = { width: 10.2, height: 6.9 };
      const pointSize = box => textPx == null ? null : textPx * Math.min(box.width / width, box.height / height) * 72;
      const portraitPt = pointSize(portrait);
      const landscapePt = pointSize(landscape);
      const maxPanelHeight = width * landscape.height / landscape.width;
      const panelCount = Math.ceil(height / maxPanelHeight);
      const panelTextPt = textPx == null || panelCount < 2 ? null
        : textPx * Math.min(landscape.width / width, landscape.height / (height / panelCount)) * 72;
      const tiled = !inlineImage && panelCount > 1 && portraitPt < 8 && landscapePt < 8 && panelTextPt >= 8;
      const tileCount = tiled ? panelCount : 1;
      let orientation = 'portrait';
      if (portraitPt != null && portraitPt < 8 && landscapePt != null && landscapePt >= 8) orientation = 'landscape';
      else if (aspect > 1.65 || (height / width) * 6.5 > 8.1) {
        orientation = landscapePt != null && (portraitPt == null || landscapePt > portraitPt) ? 'landscape' : 'portrait';
      }
      if (tiled) orientation = 'landscape';
      const box = orientation === 'landscape' ? landscape : portrait;
      const targetPrintWidth = tiled
        ? landscape.width
        : Math.min(box.width, box.height * aspect, inlineImage ? width / 96 : Infinity);
      for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
        const tileHeight = height / tileCount;
        const pageBox = tileCount === 1 ? artifact.pageBox : {
          ...artifact.pageBox,
          y: artifact.pageBox.y + tileIndex * tileHeight,
          height: tileHeight,
        };
        // A small headroom absorbs fractional CSS widths and PDF rounding so
        // a nominal 300-DPI target does not land at 299.x DPI after placement.
        const requestedScale = targetDpi * 1.01 * targetPrintWidth / Math.max(1, width * 3);
        const memoryScale = Math.sqrt(pixelAreaLimit / Math.max(1, width * tileHeight * 9));
        const scale = Math.min(Math.max(0.5, requestedScale), memoryScale);
        const id = tileCount === 1 ? artifact.id : `${artifact.id}-part-${tileIndex + 1}`;
        stage = `capture ${id} (${tileIndex + 1}/${tileCount}; ${Math.round(width)}x${Math.round(tileHeight)} CSS px; clip scale ${scale.toFixed(2)})`;
        const clip = { ...pageBox, scale };
        const screenshot = await devtools.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: true, clip,
        }, 30000);
        const png = Buffer.from(screenshot.data, 'base64');
        if (png.length < 256) {
          exceptions.push({ severity: 'blocking', code: 'empty-artifact-capture', blockId: id, message: 'The visual artifact capture was empty.' });
          continue;
        }
        assets.push({
          id,
          parentArtifactId: artifact.id,
          tileIndex: tileCount > 1 ? tileIndex + 1 : null,
          tileCount: tileCount > 1 ? tileCount : null,
          filename: `${id}.png`,
          mimeType: 'image/png',
          png: png.toString('base64'),
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
          cssHeight: tileHeight,
          scale,
          source: artifact,
        });
      }
    }
    const markerToAsset = new Map();
    for (const asset of assets) {
      if (!markerToAsset.has(asset.parentArtifactId)) markerToAsset.set(asset.parentArtifactId, asset.filename);
    }
    pageData.articleHtml = pageData.articleHtml.replace(/src="archive-asset:(artifact-\d+)"/g,
      (_match, id) => `src="assets/${markerToAsset.get(id) ?? id + '.missing.png'}"`);
    for (const artifact of pageData.artifacts) {
      if (!markerToAsset.has(artifact.id)) exceptions.push({ severity: 'blocking',
        code: 'missing-artifact', blockId: artifact.id, message: 'The article artifact is present in the source but no capture was saved.',
      });
    }
    const unreachable = await devtools.send('Runtime.evaluate', {
      expression: '({ viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio }, fullHeight: document.documentElement.scrollHeight })',
      returnByValue: true,
    });
    pageData.pageMetrics = unreachable.result?.value ?? {};
    pageData.bodyTextChecksum = undefined;
    return { pageData, rawHtml, assets, exceptions, sourceUrl: source.href };
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`, { cause: error });
  } finally {
    devtools?.close();
    chrome.kill('SIGTERM');
    await new Promise(resolve => {
      if (chrome.exitCode !== null) resolve();
      else {
        const timer = setTimeout(resolve, 1500);
        chrome.once('exit', () => { clearTimeout(timer); resolve(); });
      }
    });
    await rm(workDir, { recursive: true, force: true });
  }
}
