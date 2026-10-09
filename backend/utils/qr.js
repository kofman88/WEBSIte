/**
 * QR codes drawn on this server (the qrcode package, MIT) as PNG data: URLs.
 *
 * What they carry must not leave the machine: the 2FA QR is the otpauth:// URI with the user's
 * TOTP secret, the checkout QR the payment address of an invoice. A third-party QR API (as the
 * pages used before) would receive every secret / invoice address in its query string. The pages
 * put the result straight into <img src>, which the production CSP's img-src data: allows.
 */
const QRCode = require('qrcode');

// 400 px = the 200 px <img> of settings.html at 2x; margin 1 module (the pages frame the image in
// white padding); error correction M (15 %), qrcode's default; black on white.
const QR_OPTIONS = Object.freeze({ type: 'image/png', errorCorrectionLevel: 'M', margin: 1, width: 400 });

/** Promise of 'data:image/png;base64,…' encoding `text` byte for byte. */
function qrDataUrl(text) {
  if (typeof text !== 'string' || !text) return Promise.reject(new Error('qrDataUrl: text required'));
  return QRCode.toDataURL(text, { ...QR_OPTIONS });
}

module.exports = { qrDataUrl, QR_OPTIONS };
