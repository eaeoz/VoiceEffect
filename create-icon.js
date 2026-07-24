const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function createPNG() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const cx = SIZE / 2, cy = SIZE / 2;

  function setPixel(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    const idx = (y * SIZE + x) * 4;
    const srcA = pixels[idx + 3] / 255;
    const dstA = a / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      pixels[idx] = Math.round((pixels[idx] * srcA + r * dstA * (1 - srcA)) / outA);
      pixels[idx + 1] = Math.round((pixels[idx + 1] * srcA + g * dstA * (1 - srcA)) / outA);
      pixels[idx + 2] = Math.round((pixels[idx + 2] * srcA + b * dstA * (1 - srcA)) / outA);
      pixels[idx + 3] = Math.round(outA * 255);
    }
  }

  function fillCircle(cx, cy, radius, r, g, b, a) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (x * x + y * y <= radius * radius) {
          setPixel(cx + x, cy + y, r, g, b, a);
        }
      }
    }
  }

  function fillRoundedRect(x, y, w, h, rad, r, g, b, a) {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        let inRect = false;
        if (px >= x + rad && px <= x + w - rad && py >= y && py <= y + h) inRect = true;
        if (py >= y + rad && py <= y + h - rad && px >= x && px <= x + w) inRect = true;
        if (!inRect) {
          const corners = [
            [x + rad, y + rad], [x + w - rad, y + rad],
            [x + rad, y + h - rad], [x + w - rad, y + h - rad]
          ];
          for (const [ccx, ccy] of corners) {
            const dx = px - ccx, dy = py - ccy;
            if (dx * dx + dy * dy <= rad * rad) { inRect = true; break; }
          }
        }
        if (inRect) setPixel(px, py, r, g, b, a);
      }
    }
  }

  // Teal/green gradient background circle
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const dx = px - cx, dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxR = SIZE / 2 - 4;
      if (dist <= maxR) {
        const t = py / SIZE;
        const r = Math.round(0 + t * 10);
        const g = Math.round(180 - t * 40);
        const b = Math.round(170 - t * 20);
        setPixel(px, py, r, g, b, 255);
      }
    }
  }

  // Dark outline ring for contrast on any background
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const dx = px - cx, dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxR = SIZE / 2 - 4;
      if (dist > maxR - 5 && dist <= maxR) {
        setPixel(px, py, 10, 40, 50, 255);
      }
    }
  }

  // Audio waveform / equalizer bars
  const barWidth = 14;
  const barGap = 8;
  const bars = [40, 70, 100, 130, 100, 70, 40];
  const totalW = bars.length * barWidth + (bars.length - 1) * barGap;
  const startX = cx - totalW / 2;
  const maxBarH = 100;

  for (let i = 0; i < bars.length; i++) {
    const barH = Math.round(maxBarH * bars[i] / 100);
    const bx = startX + i * (barWidth + barGap);
    const by = cy - barH / 2;

    // Dark outline
    fillRoundedRect(bx - 3, by - 3, barWidth + 6, barH + 6, 7, 10, 40, 50, 255);
    // White bar
    fillRoundedRect(bx, by, barWidth, barH, 5, 255, 255, 255, 255);
  }

  // Small speaker icon at bottom-right
  const spkX = cx + 55, spkY = cy + 60;
  // Speaker body
  fillRoundedRect(spkX - 8, spkY - 8, 12, 16, 3, 10, 40, 50, 255);
  fillRoundedRect(spkX - 6, spkY - 6, 8, 12, 2, 255, 255, 255, 255);
  // Sound waves from speaker
  for (let angle = -0.4; angle <= 0.4; angle += 0.05) {
    fillCircle(spkX + 6 + Math.cos(angle) * 12, spkY + Math.sin(angle) * 10, 2, 10, 40, 50, 200);
    fillCircle(spkX + 6 + Math.cos(angle) * 18, spkY + Math.sin(angle) * 14, 2, 10, 40, 50, 140);
  }
  for (let angle = -0.4; angle <= 0.4; angle += 0.05) {
    fillCircle(spkX + 6 + Math.cos(angle) * 12, spkY + Math.sin(angle) * 10, 1.5, 255, 255, 255, 220);
    fillCircle(spkX + 6 + Math.cos(angle) * 18, spkY + Math.sin(angle) * 14, 1.5, 255, 255, 255, 160);
  }

  return encodePNG(pixels, SIZE, SIZE);
}

function encodePNG(pixels, width, height) {
  function crc32(buf) {
    let table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData));
    return Buffer.concat([len, typeData, crc]);
  }

  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0;
    pixels.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawData);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function resizePNG(pixels, srcSize, dstSize) {
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const scale = srcSize / dstSize;
  for (let dy = 0; dy < dstSize; dy++) {
    for (let dx = 0; dx < dstSize; dx++) {
      const sx = Math.floor(dx * scale);
      const sy = Math.floor(dy * scale);
      const si = (sy * srcSize + sx) * 4;
      const di = (dy * dstSize + dx) * 4;
      dst[di] = pixels[si];
      dst[di + 1] = pixels[si + 1];
      dst[di + 2] = pixels[si + 2];
      dst[di + 3] = pixels[si + 3];
    }
  }
  return dst;
}

function createICO(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  let dataOffset = 6 + count * 16;

  for (const { size, buffer } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry[0] = size < 256 ? size : 0;
    entry[1] = size < 256 ? size : 0;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    dirEntries.push(entry);
    dataOffset += buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers.map(e => e.buffer)]);
}

console.log('Generating icon...');
const png = createPNG();
fs.writeFileSync(path.join(dataDir, 'icon.png'), png);

const icoSizes = [16, 32, 48, 256];
const icoBuffers = icoSizes.map(size => ({
  size,
  buffer: encodePNG(resizePNG(png, SIZE, size), size, size)
}));
fs.writeFileSync(path.join(dataDir, 'icon.ico'), createICO(icoBuffers));
console.log('Icons created: data/icon.png, data/icon.ico');
