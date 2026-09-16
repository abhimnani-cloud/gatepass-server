// Thin wrapper around the vendored QR encoder (see lib/qrencoder/NOTICE.md).
// Turns a text payload into a scannable QR code, returned as an
// <img>-ready data: URI (SVG) so nothing needs to touch the filesystem.

const QRCode = require('./qrencoder/index.js');
const ECL = require('./qrencoder/QRErrorCorrectLevel.js');

/**
 * @param {string} text - data to encode (we encode full verify URLs)
 * @param {object} [opts]
 * @param {number} [opts.scale=8] - pixels per module
 * @param {number} [opts.margin=4] - quiet-zone modules around the code
 * @returns {string} data:image/svg+xml;base64,... URI
 */
function encodeToSvgDataUri(text, opts) {
  opts = opts || {};
  const scale = opts.scale || 8;
  const margin = opts.margin != null ? opts.margin : 4;

  // typeNumber -1 => library auto-picks the smallest version that fits.
  const qr = new QRCode(-1, ECL.M);
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = (count + margin * 2) * scale;

  let rects = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        const x = (col + margin) * scale;
        const y = (row + margin) * scale;
        rects += `<rect x="${x}" y="${y}" width="${scale}" height="${scale}"/>`;
      }
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<g fill="#000">${rects}</g>` +
    `</svg>`;

  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

module.exports = { encodeToSvgDataUri };
