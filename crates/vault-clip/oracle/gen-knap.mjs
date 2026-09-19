// Regenerate src/template/oracle_tests.rs from the reference implementation.
// Needs: npm i knap@0.5.0 (run from a directory whose node_modules has it), TZ=UTC.
//   TZ=UTC node gen-knap.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const here = path.dirname(fileURLToPath(import.meta.url));
const { vars: V, cases } = JSON.parse(fs.readFileSync(path.join(here, 'knap-cases.json'), 'utf8'));
const require = createRequire(path.join(process.cwd(), 'x.js'));
const { createEngine, standardFilters } = await import(require.resolve('knap'));
const engine = createEngine({ filters: standardFilters });
let s = `//! Generated from knap 0.5.0 running in Node (TZ=UTC) by oracle/gen-knap.mjs
//! from oracle/knap-cases.json. Each case renders the same template with the
//! same variables and must produce byte-identical output.

use super::*;

const VARS: &str = ${JSON.stringify(JSON.stringify(V))};

fn oracle(tpl: &str, vars: Option<&str>, expected: &str) {
    let mut ctx = TemplateContext::new("https://example.com/a", 1_700_000_000_000.0);
    ctx.defer_prompts = false;
    let json = Value::parse_json(vars.unwrap_or(VARS)).unwrap();
    if let Value::Object(m) = json {
        for (k, v) in m.0 {
            ctx.variables.insert(k, v);
        }
    }
    let out = render_template_full(tpl, &ctx);
    assert_eq!(out.output, expected, "template: {tpl}\\nerrors: {:?}", out.errors);
}
`;
for (const c of cases) {
  const variables = {};
  for (const [k, v] of Object.entries(c.vars ?? V)) variables[`{{${k}}}`] = v;
  const r = await engine.render(c.tpl, { variables });
  const vars = c.vars ? `Some(${JSON.stringify(JSON.stringify(c.vars))})` : 'None';
  s += `\n#[test]\nfn oracle_${c.name}() {\n    oracle(${JSON.stringify(c.tpl)}, ${vars}, ${JSON.stringify(r.output)});\n}\n`;
}
fs.writeFileSync(path.join(here, '../src/template/oracle_tests.rs'), s);
console.log(`${cases.length} knap cases`);
