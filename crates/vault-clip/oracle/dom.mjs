// Print how a browser-grade HTML parser (domino, Turndown's) builds a fragment:
//   node dom.mjs < fragment.html
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(path.join(process.cwd(), 'x.js'));
const domino = require('@mixmark-io/domino');
const doc = domino.createDocument('<x-turndown id="r">' + fs.readFileSync(0, 'utf8') + '</x-turndown>');
process.stdout.write(doc.getElementById('r').innerHTML);
