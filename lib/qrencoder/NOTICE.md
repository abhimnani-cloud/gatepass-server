# Third-party code notice

The files in this folder (`QRCode/index.js`, `QR8bitByte.js`, `QRBitBuffer.js`,
`QRErrorCorrectLevel.js`, `QRMaskPattern.js`, `QRMath.js`, `QRMode.js`,
`QRPolynomial.js`, `QRRSBlock.js`, `QRUtil.js`) are the standard QR Code
encoding algorithm implementation:

> QRCode for JavaScript
> Copyright (c) 2009 Kazuhiko Arase, http://www.d-project.com/
> Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
> "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

This is the same widely-used reference implementation bundled inside many
popular QR packages (e.g. `qrcode-generator`, `qrcode-terminal`). It was
vendored here unmodified so this project has zero npm dependencies for QR
generation — no network access is required to install or run it.

`server/lib/qr.js` in this project is a small original wrapper around this
library (auto-picks the smallest QR version, renders the result as an SVG
data URI). That wrapper is project code, not part of the third-party notice
above.
