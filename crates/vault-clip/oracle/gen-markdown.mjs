// Regenerate src/markdown/oracle_tests.rs from Defuddle's createMarkdownContent
// (Turndown 7 + domino, as the clipper's node build uses). Needs defuddle@0.19.3.
//   node gen-markdown.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.cwd(), 'x.js'));
const md = require(path.join(process.cwd(), 'node_modules/defuddle/dist/markdown.js'));
const cases = JSON.parse(fs.readFileSync(path.join(here, 'markdown-cases.json'), 'utf8'));
let s = `//! Generated from Defuddle 0.19.3 createMarkdownContent (Turndown 7.2.4 + domino)
//! by oracle/gen-markdown.mjs from oracle/markdown-cases.json. Each case must
//! convert byte-identically.

use super::super::*;

fn oracle(html: &str, expected: &str) {
    assert_eq!(clean_html_to_markdown(html), expected, "html: {html}");
}
`;
for (const c of cases) {
  const expected = c.expect ?? md.createMarkdownContent(c.html, 'https://example.com/');
  const note = c.departure ? `// Departure from Defuddle: ${c.departure}\n` : '';
  s += `\n#[test]\n${note}fn md_${c.name}() {\n    oracle(${JSON.stringify(c.html)}, ${JSON.stringify(expected)});\n}\n`;
}
fs.writeFileSync(path.join(here, '../src/markdown/oracle_tests.rs'), s);
console.log(`${cases.length} markdown cases`);
