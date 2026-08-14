export const BEAD_PALETTE = [
  '#F7F4E8', '#E4D8BB', '#D5AC70', '#8B5E3C', '#4A3028', '#1D2220',
  '#C84D4D', '#F27A50', '#F4BF4F', '#86BD66', '#2E8B6E', '#63C9C5',
  '#5CA8D8', '#3D6FAA', '#293D70', '#C994C7', '#E789B2', '#F2A5A0',
  '#A7AAAD', '#6C7175', '#D7E7E2', '#B5D8EC', '#AEC77B', '#B77852',
];

const RGB_PALETTE = BEAD_PALETTE.map(hexToRgb);

export function hexToRgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function colorDistance(r, g, b, target) {
  const redMean = (r + target[0]) / 2;
  const dr = r - target[0];
  const dg = g - target[1];
  const db = b - target[2];
  return (2 + redMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - redMean) / 256) * db * db;
}

export function nearestColorIndex(r, g, b, palette = RGB_PALETTE) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i++) {
    const distance = colorDistance(r, g, b, palette[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function cornerBackground(rgba, width, height) {
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  const result = [0, 0, 0];
  let count = 0;
  for (const pixelIndex of corners) {
    const offset = pixelIndex * 4;
    if (rgba[offset + 3] < 32) continue;
    result[0] += rgba[offset];
    result[1] += rgba[offset + 1];
    result[2] += rgba[offset + 2];
    count++;
  }
  return count === 0 ? [255, 255, 255] : result.map((value) => value / count);
}

function isNearBackground(rgba, pixelIndex, background, threshold) {
  const offset = pixelIndex * 4;
  if (rgba[offset + 3] === 0) return true;
  const dr = rgba[offset] - background[0];
  const dg = rgba[offset + 1] - background[1];
  const db = rgba[offset + 2] - background[2];
  return Math.sqrt(dr * dr + dg * dg + db * db) <= threshold;
}

/**
 * 只标记与画布边界连通的背景；被轮廓封闭的同色区域不会进入结果。
 */
export function exteriorBackgroundMask(rgba, width, height, threshold = 44) {
  if (rgba.length !== width * height * 4) throw new Error('RGBA 数据长度错误');
  const background = cornerBackground(rgba, width, height);
  const outside = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  function enqueue(pixelIndex) {
    if (outside[pixelIndex] !== 0) return;
    if (!isNearBackground(rgba, pixelIndex, background, threshold)) return;
    outside[pixelIndex] = 1;
    queue[tail++] = pixelIndex;
  }

  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixelIndex = queue[head++];
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x + 1 < width) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y + 1 < height) enqueue(pixelIndex + width);
  }
  return outside;
}

/** 返回保留原透明度、仅把外部连通背景 Alpha 设为 0 的副本。 */
export function applyExteriorTransparency(rgba, width, height, threshold = 44) {
  const output = new Uint8ClampedArray(rgba);
  const outside = exteriorBackgroundMask(output, width, height, threshold);
  for (let pixelIndex = 0; pixelIndex < outside.length; pixelIndex++) {
    if (outside[pixelIndex] !== 0) output[pixelIndex * 4 + 3] = 0;
  }
  return output;
}

function addError(buffer, mask, width, height, x, y, er, eg, eb, weight) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const pixelIndex = y * width + x;
  if (mask[pixelIndex] === 0) return;
  const offset = pixelIndex * 3;
  buffer[offset] += er * weight;
  buffer[offset + 1] += eg * weight;
  buffer[offset + 2] += eb * weight;
}

/** 把低分辨率 RGBA 样本量化为有限拼豆色板和 base36 网格。 */
export function quantizeRgba(rgba, width, height, options = {}) {
  if (rgba.length !== width * height * 4) throw new Error('RGBA 数据长度错误');
  const removeBackground = options.removeBackground ?? true;
  const threshold = options.backgroundThreshold ?? 44;
  const maxColors = Math.max(1, Math.min(BEAD_PALETTE.length, options.maxColors ?? 12));
  const outside = removeBackground
    ? exteriorBackgroundMask(rgba, width, height, threshold)
    : new Uint8Array(width * height);
  const mask = new Uint8Array(width * height);
  const histogram = new Uint32Array(BEAD_PALETTE.length);

  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const offset = pixelIndex * 4;
    if (rgba[offset + 3] < 96 || outside[pixelIndex] !== 0) continue;
    mask[pixelIndex] = 1;
    histogram[nearestColorIndex(rgba[offset], rgba[offset + 1], rgba[offset + 2])]++;
  }

  let selectedGlobal = Array.from(histogram.keys())
    .filter((index) => histogram[index] > 0)
    .sort((a, b) => histogram[b] - histogram[a])
    .slice(0, maxColors);
  if (selectedGlobal.length === 0) selectedGlobal = [0];
  const selectedRgb = selectedGlobal.map((index) => RGB_PALETTE[index]);

  const work = new Float32Array(width * height * 3);
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const sourceOffset = pixelIndex * 4;
    const targetOffset = pixelIndex * 3;
    work[targetOffset] = rgba[sourceOffset];
    work[targetOffset + 1] = rgba[sourceOffset + 1];
    work[targetOffset + 2] = rgba[sourceOffset + 2];
  }

  const rawIndices = new Int16Array(width * height);
  rawIndices.fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      if (mask[pixelIndex] === 0) continue;
      const offset = pixelIndex * 3;
      const r = Math.max(0, Math.min(255, work[offset]));
      const g = Math.max(0, Math.min(255, work[offset + 1]));
      const b = Math.max(0, Math.min(255, work[offset + 2]));
      const localIndex = nearestColorIndex(r, g, b, selectedRgb);
      rawIndices[pixelIndex] = localIndex;

      if (options.dither) {
        const target = selectedRgb[localIndex];
        const er = r - target[0];
        const eg = g - target[1];
        const eb = b - target[2];
        addError(work, mask, width, height, x + 1, y, er, eg, eb, 7 / 16);
        addError(work, mask, width, height, x - 1, y + 1, er, eg, eb, 3 / 16);
        addError(work, mask, width, height, x, y + 1, er, eg, eb, 5 / 16);
        addError(work, mask, width, height, x + 1, y + 1, er, eg, eb, 1 / 16);
      }
    }
  }

  const usedLocal = Array.from(new Set(Array.from(rawIndices).filter((index) => index >= 0)));
  const compactMap = new Map(usedLocal.map((index, compactIndex) => [index, compactIndex]));
  const pixels = Array.from(rawIndices, (index) =>
    index < 0 ? '.' : compactMap.get(index).toString(36),
  ).join('');

  return {
    v: 1,
    cols: width,
    rows: height,
    // 协议要求至少一个色板项；全空图案保留占位色，豆位仍全部为 `.`。
    palette: (usedLocal.length > 0 ? usedLocal : [0]).map((index) => BEAD_PALETTE[selectedGlobal[index]]),
    pixels,
  };
}

export function drawPixelPattern(context, pattern, size) {
  const cell = size / Math.max(pattern.cols, pattern.rows);
  const gridWidth = cell * pattern.cols;
  const gridHeight = cell * pattern.rows;
  const startX = (size - gridWidth) / 2;
  const startY = (size - gridHeight) / 2;
  context.fillStyle = '#000000';
  context.fillRect(0, 0, size, size);

  for (let row = 0; row < pattern.rows; row++) {
    for (let col = 0; col < pattern.cols; col++) {
      const symbol = pattern.pixels[row * pattern.cols + col];
      if (symbol === '.') continue;
      const color = pattern.palette[Number.parseInt(symbol, 36)];
      context.fillStyle = color;
      const x0 = Math.round(startX + col * cell);
      const y0 = Math.round(startY + row * cell);
      const x1 = Math.round(startX + (col + 1) * cell);
      const y1 = Math.round(startY + (row + 1) * cell);
      context.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

export function containRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    throw new Error('图片和画布尺寸必须大于 0');
  }
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

function startBrowserApp() {
  const elements = {
    canvas: document.querySelector('#preview'),
    canvasShell: document.querySelector('#canvas-shell'),
    file: document.querySelector('#image-file'),
    emptyPicker: document.querySelector('#empty-picker'),
    deviceBeads: document.querySelector('#device-beads'),
    deviceMedia: document.querySelector('#device-media'),
    originalMode: document.querySelector('#mode-original'),
    cropMode: document.querySelector('#mode-crop'),
    beadMode: document.querySelector('#mode-beads'),
    gridOptions: document.querySelector('#grid-options'),
    gridOutput: document.querySelector('#grid-output'),
    customGrid: document.querySelector('#grid-custom'),
    colorCount: document.querySelector('#color-count'),
    colorOutput: document.querySelector('#color-output'),
    zoom: document.querySelector('#zoom'),
    zoomOutput: document.querySelector('#zoom-output'),
    removeBackground: document.querySelector('#remove-background'),
    threshold: document.querySelector('#background-threshold'),
    thresholdOutput: document.querySelector('#threshold-output'),
    thresholdGroup: document.querySelector('#threshold-group'),
    musicUrl: document.querySelector('#music-url'),
    musicState: document.querySelector('#music-state'),
    musicPlay: document.querySelector('#music-play'),
    musicPause: document.querySelector('#music-pause'),
    musicStop: document.querySelector('#music-stop'),
    musicMessage: document.querySelector('#music-message'),
    dither: document.querySelector('#dither'),
    palette: document.querySelector('#palette-strip'),
    meta: document.querySelector('#pattern-meta'),
    send: document.querySelector('#send-pattern'),
    download: document.querySelector('#download-pattern'),
    actionStatus: document.querySelector('#action-status'),
    deviceStatus: document.querySelector('#device-status'),
  };

  const context = elements.canvas.getContext('2d');
  const sampleCanvas = document.createElement('canvas');
  const state = {
    image: null,
    file: null,
    imageUrl: null,
    fileName: '',
    isGif: false,
    deviceMode: 'beads',
    screenWidth: 368,
    screenHeight: 448,
    mode: 'original',
    grid: 24,
    centerX: 0,
    centerY: 0,
    pattern: null,
    drag: null,
    music: { url: '', state: 'stopped', error: null },
    musicBusy: false,
  };

  function canvasToBlob(canvas, type = 'image/png') {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法生成图片')), type);
    });
  }

  function cleanCanvasExterior(context, width, height) {
    const imageData = context.getImageData(0, 0, width, height);
    const cleaned = applyExteriorTransparency(
      imageData.data,
      width,
      height,
      Number(elements.threshold.value),
    );
    imageData.data.set(cleaned);
    context.putImageData(imageData, 0, 0);
  }

  /** 把原图等比居中到透明画布，仅对边界连通背景清零 Alpha。 */
  function createContainedCanvas(width, height, removeBackground) {
    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const outputContext = output.getContext('2d');
    outputContext.clearRect(0, 0, width, height);

    const rect = containRect(state.image.naturalWidth, state.image.naturalHeight, width, height);
    const contentWidth = Math.max(1, Math.round(rect.width));
    const contentHeight = Math.max(1, Math.round(rect.height));
    const content = document.createElement('canvas');
    content.width = contentWidth;
    content.height = contentHeight;
    const contentContext = content.getContext('2d', { willReadFrequently: removeBackground });
    contentContext.clearRect(0, 0, contentWidth, contentHeight);
    contentContext.imageSmoothingEnabled = true;
    contentContext.imageSmoothingQuality = 'high';
    contentContext.drawImage(state.image, 0, 0, contentWidth, contentHeight);

    if (removeBackground) cleanCanvasExterior(contentContext, contentWidth, contentHeight);
    outputContext.drawImage(content, Math.round(rect.x), Math.round(rect.y));
    return output;
  }

  /** 生成设备端原图：使用网页当前方形裁剪区，不再发送完整原图。 */
  function createCroppedDeviceCanvas(width, height, removeBackground) {
    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const outputContext = output.getContext('2d');
    outputContext.clearRect(0, 0, width, height);

    const side = Math.max(1, Math.min(width, height));
    const content = document.createElement('canvas');
    content.width = side;
    content.height = side;
    const contentContext = content.getContext('2d', { willReadFrequently: removeBackground });
    const crop = cropRect();
    contentContext.clearRect(0, 0, side, side);
    contentContext.imageSmoothingEnabled = true;
    contentContext.imageSmoothingQuality = 'high';
    contentContext.drawImage(
      state.image,
      crop.x,
      crop.y,
      crop.size,
      crop.size,
      0,
      0,
      side,
      side,
    );
    if (removeBackground) cleanCanvasExterior(contentContext, side, side);
    outputContext.drawImage(content, Math.floor((width - side) / 2), Math.floor((height - side) / 2));
    return output;
  }

  async function fetchJson(path, options) {
    const response = await fetch(path, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '设备拒绝了请求');
    return result;
  }

  function applyMusicStatus(music, syncUrl = false) {
    const validStates = ['stopped', 'loading', 'playing', 'paused', 'error'];
    const next = {
      url: typeof music?.url === 'string' ? music.url : '',
      state: validStates.includes(music?.state) ? music.state : 'stopped',
      error: typeof music?.error === 'string' ? music.error : null,
    };
    state.music = next;
    if (syncUrl || document.activeElement !== elements.musicUrl) {
      elements.musicUrl.value = next.url;
    }

    const labels = {
      stopped: '未播放',
      loading: '正在连接',
      playing: '播放中',
      paused: '已暂停',
      error: '播放失败',
    };
    elements.musicState.textContent = labels[next.state];
    elements.musicPause.textContent = next.state === 'paused' ? '继续' : '暂停';
    elements.musicPlay.disabled = state.musicBusy || next.state === 'loading' || !elements.musicUrl.value.trim();
    elements.musicPause.disabled = state.musicBusy || (next.state !== 'playing' && next.state !== 'paused');
    elements.musicStop.disabled = state.musicBusy || (next.state !== 'loading' && next.state !== 'playing' && next.state !== 'paused');
    elements.musicMessage.textContent = next.error ?? '';
    elements.musicMessage.className = `action-status music-message${next.error ? ' error' : ''}`;
  }

  async function controlMusic(action, body) {
    state.musicBusy = true;
    if (action === 'play') {
      applyMusicStatus({ url: body.url, state: 'loading', error: null });
    } else {
      applyMusicStatus(state.music);
    }
    try {
      const result = await fetchJson(`/api/music/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      state.musicBusy = false;
      applyMusicStatus(result.music);
    } catch (error) {
      state.musicBusy = false;
      applyMusicStatus({
        ...state.music,
        state: action === 'play' ? 'error' : state.music.state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function uploadMedia(blob, kind, width, height, mediaOptions = {}) {
    const maxBytes = 2 * 1024 * 1024;
    if (blob.size > maxBytes) throw new Error('文件超过 2 MiB，请压缩后再上传');
    const started = await fetchJson('/api/media/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        kind,
        size: blob.size,
        width,
        height,
        removeBackground: mediaOptions.removeBackground ?? false,
        backgroundThreshold: mediaOptions.backgroundThreshold ?? 44,
        crop: mediaOptions.crop ?? null,
      }),
    });
    const chunkBytes = started.chunkBytes || 8192;
    let offset = 0;
    while (offset < blob.size) {
      const chunk = await blob.slice(offset, offset + chunkBytes).arrayBuffer();
      await fetchJson(`/api/media/chunk?id=${encodeURIComponent(started.id)}&offset=${offset}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk,
      });
      offset += chunk.byteLength;
      setActionStatus(`正在上传 ${Math.round(offset / blob.size * 100)}%`);
    }
    return fetchJson('/api/media/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: started.id }),
    });
  }

  function cropRect() {
    const zoom = Number(elements.zoom.value) / 100;
    const cropSize = Math.min(state.image.naturalWidth, state.image.naturalHeight) / zoom;
    const half = cropSize / 2;
    state.centerX = Math.max(half, Math.min(state.image.naturalWidth - half, state.centerX));
    state.centerY = Math.max(half, Math.min(state.image.naturalHeight - half, state.centerY));
    return { x: state.centerX - half, y: state.centerY - half, size: cropSize };
  }

  function renderCrop() {
    const crop = cropRect();
    context.fillStyle = '#000000';
    context.fillRect(0, 0, elements.canvas.width, elements.canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      state.image,
      crop.x,
      crop.y,
      crop.size,
      crop.size,
      0,
      0,
      elements.canvas.width,
      elements.canvas.height,
    );
    context.strokeStyle = 'rgba(255, 255, 255, 0.82)';
    context.lineWidth = 2;
    context.strokeRect(1, 1, elements.canvas.width - 2, elements.canvas.height - 2);
  }

  function renderOriginal() {
    context.fillStyle = '#000000';
    context.fillRect(0, 0, elements.canvas.width, elements.canvas.height);
    const removeBackground = elements.removeBackground.checked;
    if (removeBackground) {
      context.drawImage(createContainedCanvas(elements.canvas.width, elements.canvas.height, true), 0, 0);
      return;
    }
    const rect = containRect(
      state.image.naturalWidth,
      state.image.naturalHeight,
      elements.canvas.width,
      elements.canvas.height,
    );
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(state.image, rect.x, rect.y, rect.width, rect.height);
  }

  function renderPalette() {
    elements.palette.replaceChildren();
    if (!state.pattern) return;
    for (const color of state.pattern.palette) {
      const swatch = document.createElement('i');
      swatch.style.backgroundColor = color;
      swatch.title = color;
      elements.palette.append(swatch);
    }
  }

  function updatePattern() {
    if (!state.image) return;
    const crop = cropRect();
    sampleCanvas.width = state.grid;
    sampleCanvas.height = state.grid;
    const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
    sampleContext.clearRect(0, 0, state.grid, state.grid);
    sampleContext.imageSmoothingEnabled = true;
    sampleContext.imageSmoothingQuality = 'high';
    sampleContext.drawImage(
      state.image,
      crop.x,
      crop.y,
      crop.size,
      crop.size,
      0,
      0,
      state.grid,
      state.grid,
    );
    const imageData = sampleContext.getImageData(0, 0, state.grid, state.grid);
    state.pattern = quantizeRgba(imageData.data, state.grid, state.grid, {
      maxColors: Number(elements.colorCount.value),
      removeBackground: elements.removeBackground.checked,
      backgroundThreshold: Number(elements.threshold.value),
      dither: elements.dither.checked,
    });
    elements.meta.textContent = `${state.grid} x ${state.grid} · ${state.pattern.palette.length} 色`;
    elements.send.disabled = false;
    elements.download.disabled = false;
    renderPalette();
  }

  function render() {
    if (!state.image) {
      context.fillStyle = '#000000';
      context.fillRect(0, 0, elements.canvas.width, elements.canvas.height);
      return;
    }
    if (state.mode === 'original') renderOriginal();
    else if (state.mode === 'crop') renderCrop();
    else drawPixelPattern(context, state.pattern, elements.canvas.width);
  }

  function refresh() {
    updatePattern();
    render();
  }

  function setMode(mode) {
    state.mode = mode;
    elements.originalMode.classList.toggle('active', mode === 'original');
    elements.cropMode.classList.toggle('active', mode === 'crop');
    elements.beadMode.classList.toggle('active', mode === 'beads');
    elements.canvasShell.classList.toggle('crop-ready', mode === 'crop' && Boolean(state.image));
    render();
  }

  function setDeviceMode(mode) {
    state.deviceMode = mode;
    elements.deviceBeads.classList.toggle('active', mode === 'beads');
    elements.deviceMedia.classList.toggle('active', mode === 'media');
    elements.send.textContent = mode === 'beads'
      ? '显示像素图案'
      : state.isGif ? '显示 GIF' : '显示裁剪原图';
    elements.removeBackground.disabled = false;
    elements.threshold.disabled = false;
    elements.thresholdGroup.classList.remove('disabled');
    setActionStatus('');
  }

  function setActionStatus(message, kind = '') {
    elements.actionStatus.textContent = message;
    elements.actionStatus.className = `action-status ${kind}`.trim();
  }

  elements.file.addEventListener('change', () => {
    const file = elements.file.files?.[0];
    if (!file) return;
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.imageUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      state.image = image;
      state.file = file;
      state.fileName = file.name;
      state.isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
      state.centerX = image.naturalWidth / 2;
      state.centerY = image.naturalHeight / 2;
      elements.emptyPicker.classList.add('hidden');
      elements.canvasShell.classList.toggle('crop-ready', state.mode === 'crop');
      setDeviceMode(state.isGif ? 'media' : state.deviceMode);
      refresh();
    };
    image.onerror = () => setActionStatus('无法读取这张图片', 'error');
    image.src = state.imageUrl;
  });

  elements.originalMode.addEventListener('click', () => setMode('original'));
  elements.cropMode.addEventListener('click', () => setMode('crop'));
  elements.beadMode.addEventListener('click', () => setMode('beads'));
  elements.deviceBeads.addEventListener('click', () => setDeviceMode('beads'));
  elements.deviceMedia.addEventListener('click', () => setDeviceMode('media'));

  function setGrid(value) {
    state.grid = Math.max(8, Math.min(64, Math.round(value)));
    elements.customGrid.value = String(state.grid);
    elements.gridOutput.value = `${state.grid} x ${state.grid}`;
    for (const item of elements.gridOptions.querySelectorAll('button')) {
      item.classList.toggle('active', Number(item.dataset.grid) === state.grid);
    }
    refresh();
  }

  elements.gridOptions.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-grid]');
    if (!button) return;
    setGrid(Number(button.dataset.grid));
  });
  elements.customGrid.addEventListener('input', () => {
    const value = elements.customGrid.valueAsNumber;
    if (Number.isInteger(value) && value >= 8 && value <= 64) setGrid(value);
  });
  elements.customGrid.addEventListener('change', () => {
    const value = elements.customGrid.valueAsNumber;
    setGrid(Number.isFinite(value) ? value : 24);
  });

  elements.colorCount.addEventListener('input', () => {
    elements.colorOutput.value = `${elements.colorCount.value} 色`;
    refresh();
  });
  elements.zoom.addEventListener('input', () => {
    elements.zoomOutput.value = `${elements.zoom.value}%`;
    refresh();
  });
  elements.threshold.addEventListener('input', () => {
    elements.thresholdOutput.value = elements.threshold.value;
    refresh();
  });
  elements.removeBackground.addEventListener('change', () => {
    elements.thresholdGroup.hidden = !elements.removeBackground.checked;
    refresh();
  });
  elements.dither.addEventListener('change', refresh);
  elements.musicUrl.addEventListener('input', () => applyMusicStatus(state.music));
  elements.musicUrl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !elements.musicPlay.disabled) elements.musicPlay.click();
  });
  elements.musicPlay.addEventListener('click', () => {
    const url = elements.musicUrl.value.trim();
    if (!url) return;
    void controlMusic('play', { url });
  });
  elements.musicPause.addEventListener('click', () => {
    void controlMusic(state.music.state === 'paused' ? 'resume' : 'pause');
  });
  elements.musicStop.addEventListener('click', () => {
    void controlMusic('stop');
  });

  elements.canvasShell.addEventListener('pointerdown', (event) => {
    if (!state.image || state.mode !== 'crop') return;
    elements.canvasShell.setPointerCapture(event.pointerId);
    elements.canvasShell.classList.add('dragging');
    state.drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      centerX: state.centerX,
      centerY: state.centerY,
    };
  });
  elements.canvasShell.addEventListener('pointermove', (event) => {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    const rect = elements.canvasShell.getBoundingClientRect();
    const crop = cropRect();
    state.centerX = state.drag.centerX - (event.clientX - state.drag.x) * crop.size / rect.width;
    state.centerY = state.drag.centerY - (event.clientY - state.drag.y) * crop.size / rect.height;
    refresh();
  });
  const endDrag = (event) => {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    state.drag = null;
    elements.canvasShell.classList.remove('dragging');
  };
  elements.canvasShell.addEventListener('pointerup', endDrag);
  elements.canvasShell.addEventListener('pointercancel', endDrag);

  elements.send.addEventListener('click', async () => {
    if (!state.pattern || !state.image || !state.file) return;
    elements.send.disabled = true;
    setActionStatus('正在准备发送');
    try {
      if (state.deviceMode === 'beads') {
        const result = await fetchJson('/api/pattern', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.pattern),
        });
        setActionStatus(`已显示，共 ${result.beads} 个豆位`, 'success');
        elements.deviceStatus.textContent = '设备在线 · 像素图案';
      } else if (state.isGif) {
        const crop = cropRect();
        await uploadMedia(state.file, 'gif', state.image.naturalWidth, state.image.naturalHeight, {
          removeBackground: elements.removeBackground.checked,
          backgroundThreshold: Number(elements.threshold.value),
          crop: { x: crop.x, y: crop.y, size: crop.size },
        });
        setActionStatus('GIF 已在设备上播放', 'success');
        elements.deviceStatus.textContent = '设备在线 · GIF';
      } else {
        const deviceCanvas = createCroppedDeviceCanvas(
          state.screenWidth,
          state.screenHeight,
          elements.removeBackground.checked,
        );
        const blob = await canvasToBlob(deviceCanvas);
        await uploadMedia(blob, 'image', state.screenWidth, state.screenHeight);
        setActionStatus('裁剪原图已在设备上显示', 'success');
        elements.deviceStatus.textContent = '设备在线 · 裁剪原图';
      }
      elements.deviceStatus.className = 'device-status online';
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      elements.send.disabled = false;
    }
  });

  elements.download.addEventListener('click', () => {
    if (!state.pattern) return;
    const output = document.createElement('canvas');
    output.width = state.pattern.cols * 20;
    output.height = state.pattern.rows * 20;
    drawPixelPattern(output.getContext('2d'), state.pattern, output.width);
    output.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = `${state.fileName.replace(/\.[^.]+$/, '') || '拼豆图案'}-${state.pattern.cols}x${state.pattern.rows}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  });

  function applyDeviceStatus(status, syncMusicUrl = false) {
    if (Number.isInteger(status.screen?.width) && Number.isInteger(status.screen?.height)) {
      state.screenWidth = status.screen.width;
      state.screenHeight = status.screen.height;
    }
    if (status.mode === 'gif') elements.deviceStatus.textContent = '设备在线 · GIF';
    else if (status.mode === 'image') elements.deviceStatus.textContent = '设备在线 · 裁剪原图';
    else if (status.pattern) {
      elements.deviceStatus.textContent = `设备在线 · ${status.pattern.cols} x ${status.pattern.rows}`;
    } else elements.deviceStatus.textContent = '设备在线';
    elements.deviceStatus.className = 'device-status online';
    applyMusicStatus(status.music, syncMusicUrl);
  }

  let statusRequestInFlight = false;
  async function refreshDeviceStatus(syncMusicUrl = false) {
    if (statusRequestInFlight) return;
    statusRequestInFlight = true;
    try {
      applyDeviceStatus(await fetchJson('/api/status'), syncMusicUrl);
    } catch {
      elements.deviceStatus.textContent = '设备连接失败';
      elements.deviceStatus.className = 'device-status error';
    } finally {
      statusRequestInFlight = false;
    }
  }

  void refreshDeviceStatus(true);
  setInterval(() => void refreshDeviceStatus(), 1500);

  let lastGifPreviewAt = 0;
  function animatePreview(now) {
    if (state.isGif && state.image && state.mode !== 'beads' && now - lastGifPreviewAt >= 80) {
      lastGifPreviewAt = now;
      render();
    }
    requestAnimationFrame(animatePreview);
  }

  setDeviceMode('beads');
  applyMusicStatus(state.music);
  render();
  requestAnimationFrame(animatePreview);
}

if (typeof document !== 'undefined') startBrowserApp();
