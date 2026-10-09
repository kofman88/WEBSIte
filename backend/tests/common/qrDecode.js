'use strict';
/**
 * qrDecode.js — reads a QR code back from a PNG data: URL the way a phone camera would read the
 * <img> the pages show (pngjs + jsQR, dev dependencies). Throws if the URL is anything but a
 * self-contained PNG data: URL, returns null if no QR code is found in the image.
 */
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;

function decodeQrDataUrl(url) {
  const m = PNG_DATA_URL.exec(String(url));
  if (!m) throw new Error(`not a PNG data: URL: ${String(url).slice(0, 60)}`);
  const png = PNG.sync.read(Buffer.from(m[1], 'base64'));
  const rgba = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length);
  const code = jsQR(rgba, png.width, png.height);
  return code ? code.data : null;
}

module.exports = { decodeQrDataUrl, PNG_DATA_URL };
