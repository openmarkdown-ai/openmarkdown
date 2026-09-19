// Run the reference Defuddle over a saved page for differential checks:
//   node page.mjs <dir> <name>   (reads <dir>/<name>.html and <name>.url)
// writes <name>.defuddle.html (content), .defuddle.md (clipper Markdown), .defuddle.json (metadata).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const [dir, name] = process.argv.slice(2);
const require = createRequire(path.join(process.cwd(), 'x.js'));
const { pathToFileURL } = await import('url');
const { parseHTML } = require('linkedom');
const { Defuddle } = await import(pathToFileURL(path.join(process.cwd(), 'node_modules/defuddle/dist/node.js')).href);
const md = require(path.join(process.cwd(), 'node_modules/defuddle/dist/markdown.js'));
const html = fs.readFileSync(path.join(dir, name + '.html'), 'utf8');
const url = fs.readFileSync(path.join(dir, name + '.url'), 'utf8').trim();
const { document } = parseHTML(html);
const r = await Defuddle(document, url);
fs.writeFileSync(path.join(dir, name + '.defuddle.html'), r.content);
fs.writeFileSync(path.join(dir, name + '.defuddle.md'), md.createMarkdownContent(r.content, url));
const meta = { ...r }; delete meta.content;
fs.writeFileSync(path.join(dir, name + '.defuddle.json'), JSON.stringify(meta, null, 1));
console.log(name, '|', r.title, '|', r.author, '|', r.published, '| words', r.wordCount);
