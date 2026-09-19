// Regenerate src/template/validate_oracle_tests.rs from knap's engine.validate.
//   node gen-validate.mjs   (cwd must have node_modules with knap@0.5.0)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.cwd(), 'x.js'));
const { createEngine, standardFilters } = await import(require.resolve('knap'));
const stub = Object.assign(() => '', { metadata: {} });
const engine = createEngine({ filters: { ...standardFilters, markdown: stub, html_to_json: stub, remove_html: stub } });
const tpls = [
 '{{ title | upper }}', '{{ title | uper }}', '{{ x | calc:"%2" }}', '{{ x | calc }}', '{{ x | calc:"+2" }}',
 '{{ x | date_modify:"+1 fortnight" }}', '{{ x | date_modify:"+1 day" }}', '{{ x | replace:a:b }}', '{{ x | replace:"a":"b" }}',
 '{{ x | slice:a,b }}', '{{ x | slice:1,2 }}', '{{ x | sort:("n","sideways") }}', '{{ x | sort:desc }}', '{{ x | nth:abc }}',
 '{{ x | truncate }}', '{{ x | truncate:limit }}', '{{ x | where:"a" }}', '{{ x | object:entries }}', '{{ x | list:bullets }}',
 '{{ x | highlight:pink }}', '{{ x | safe_name:dos }}', '{{ x | map }}', '{{ x | map:p => p.name }}', '{{ x | template }}',
 '{{ x | yaml:block }}', '{{ x | yaml_property }}', '{{ x | indent:-1 }}', '{{ x | round:-1 }}', '{{ x | bold:"~" }}',
 '{% if x %}', '{{ x ', '{% for %}{% endfor %}', '{{ x | hr:"middle" }}', '{{ x | code:"a`b" }}',
 '{{ x | nth:1,2:0 }}', '{{ x | sum:"a..b" }}', '{{ x | where:("", 1) }}', '{{ x | truncatewords:(2,"…","x") }}',
 '{{ x | replace:("a":"b","/c/g":"d") }}', '{% if a %}{{ b | frob }}{% endif %}', '{{ x | list }}',
];
let s = `//! Generated from knap 0.5.0 \`engine.validate\` by oracle/gen-validate.mjs.

use super::*;

fn codes(t: &str) -> Vec<String> {
    validate_template(t).into_iter().map(|d| d.code).collect()
}
`;
tpls.forEach((t, i) => {
  const codes = engine.validate(t).map(e => e.code);
  s += `\n#[test]\nfn validate_${i}() {\n    let expected: Vec<String> = vec![${codes.map(c => JSON.stringify(c) + '.to_string()').join(', ')}];\n    assert_eq!(codes(${JSON.stringify(t)}), expected, "{}", ${JSON.stringify(t)});\n}\n`;
});
fs.writeFileSync(path.join(here, '../src/template/validate_oracle_tests.rs'), s);
console.log(`${tpls.length} validation cases`);
