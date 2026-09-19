# vault-bases research notes

Everything here comes from public sources: the Obsidian help vault
(`obsidianmd/obsidian-help`, `en/Bases/**`), the MIT-licensed `obsidian.d.ts`
(v1.13.1, in `node_modules/obsidian`), Obsidian's public changelogs and forum,
the official Maps plugin's example vault, kepano's public `obsidian-skills`
Bases reference, and `.base` files people have published on GitHub. The
installed Obsidian app was never read or run. Where those sources are silent
the choice made is marked **(judgment)** so it can be revisited.

## Sources read

| Source | What it settled |
|---|---|
| `en/Bases/Bases syntax.md` | file schema, filter and/or/not, formulas, properties, summaries section, the default summary table, file properties, `this`, operators, date arithmetic units, type system, link equality |
| `en/Bases/Functions.md` | every global function and per-type method (list below) |
| `en/Bases/Formulas.md` | formula examples, objects `{"name": "value"}` are literals, no circular references |
| `en/Bases/Views.md`, `Layouts/*.md` | layouts table/cards/list/kanban/map; embed `![[File.base#View]]`; row height; card size/image/fit/aspect ratio; list markers/indent/separator; map settings; built-in summaries by type |
| `en/Bases/Create a base.md` | ```` ```base ```` code blocks are the same YAML |
| `obsidian.d.ts` 1.13.1 | `BasesConfigFile`, `BasesConfigFileFilter`, `BasesConfigFileView`, `BasesSortConfig {property, direction: 'ASC'\|'DESC'}`, `BasesPropertyId = note.\|formula.\|file.`, `BasesEntryGroup` (null key when missing), `BasesQueryResult.groupedData` (single group with empty key when not grouped), `Value` hierarchy, `DateValue.parseFromString` examples, `DurationValue` (ISO 8601 parse, `fromMilliseconds`, `addToDate`), `ListValue.includes` = loose equality, `getDisplayName` rule |
| Changelog 1.9.2 / 1.10.x | object-oriented methods, `note["Property Name"]`; 1.10: group by, table summaries, List view, `reduce/mean/stddev/median`, `html()`, `random()`, timezone offsets in ISO parsing, indeterminate checkboxes sort with false |
| kepano/obsidian-skills `obsidian-bases` | date − date is a **Duration** with fields `days/hours/minutes/seconds/milliseconds`; durations need `.days` before `.round()` |
| Forum "days since modification", "date duration" | `.days` is fractional (people write `.days.round()`) |
| Forum "can base files have aliases" | `file.name` includes the extension (`file.name.split(".",1)`) |
| obsidian-maps `examples/Places.base` | map view keys `coordinates`, `markerIcon`, `markerColor`, `defaultZoom`, `center`, `mapTiles`; `list(type)[0].asFile().properties.icon`; `categories.containsAny(link("Places"))` on frontmatter wikilinks |
| Public `.base` files on GitHub (loop-board, charted-roots, vaultcms, academic-obsidian, cinematheque, Xenocryst, Pkmer-Math, obsidian-tasks docs, nicksp dotfiles) | `sort:` list of `{property, direction}`, `columnSize: {note.x: px}`, `rowHeight: medium`, `cardSize`, `image: note.cover`, `imageFit: contain`, `imageAspectRatio: 0.45`, list `markers: number\|bullet`, `nestedProperties`, `indentProperties`, `separator`; top-level key order is not fixed (`summaries` before `filters`); custom summaries named `Filled`/`Empty`/`Unique` override built-ins; `file.folder == "/"` for the root; formula named `""` referenced as `formula.`; empty formula strings; `isType("Link")` capitalised; nested list literals `[[ … ]]`; multi-line `|-`/`|+` formulas; negative column sizes |

## Value model (mirrors `obsidian.d.ts`)

`null`, `boolean`, `number`, `string` and its subclasses `link` (+ optional
`display` Value), `html`, `icon`, `image`, `tag`, `url`; `date` (ms + `time`
flag), `duration` (moment's `months`/`days`/`milliseconds` + total `value`),
`list`, `object` (insertion ordered), `file` (path), `regexp` (source + flags),
and `error` (what `BasesEntry.getValue` returns on failure). JSON is
`{"type": …, "value": …}`; non-finite numbers are the strings `NaN`/`Infinity`.

String subclasses answer `isType("string")` and accept every string method,
because they extend `StringValue` in the d.ts.

## Functions implemented

Global: `date duration escapeHTML file html icon if image link list max min now
number random today`.

Any: `isTruthy isType toString isEmpty`.
String (and subclasses): fields `length`; `contains containsAll containsAny
endsWith isEmpty lower upper title trim replace repeat reverse slice split
startsWith`.
Number: `abs ceil floor round(digits) toFixed isEmpty`.
Date: fields `year month day hour minute second millisecond`; `date format time
relative isEmpty`.
Duration (kepano reference + Xenocryst.base): fields `years months weeks days
hours minutes seconds milliseconds`, all fractional totals using moment's
`as()` conversions.
List: field `length`; `contains containsAll containsAny filter map reduce flat
join reverse sort unique slice isEmpty mean median stddev` plus `sum min max
earliest latest average` (used by published bases; harmless superset).
Link: `asFile linksTo` + string methods. File: fields `name basename path folder
ext size ctime mtime tags links embeds backlinks properties file`; `asLink
hasLink hasProperty hasTag inFolder`. Object: `keys values isEmpty`. RegExp:
`matches`.

## Semantics and the reasoning behind them

- **Property names**: bare `x` = `note.x`; `note["my prop"]`; lookups fall back
  to a case-insensitive match (Obsidian treats property names case-insensitively).
- **Type inference** for frontmatter: `.obsidian/types.json` types win
  (`text`, `number`, `checkbox`, `date`, `datetime`, `multitext`, `tags`).
  Without a type, `YYYY-MM-DD[THH:mm[:ss]]` strings become dates, whole-string
  `[[wikilinks]]` become links (the docs: "Wikilinks in frontmatter properties
  are automatically recognized as Link objects"), `scheme://…` strings become
  URLs. **(judgment for dates/URLs)**
- **Dates** are local-time: `run_view` takes `tz_offset_min` (minutes *east* of
  UTC, the negation of JS `getTimezoneOffset()`); one fixed offset, no DST.
  Date-only values carry `time: false` and display `YYYY-MM-DD`; datetimes
  display `YYYY-MM-DD HH:mm` **(judgment)**. `date.time()` is `HH:mm:ss`
  (docs example "23:59:59").
- **Parsing** follows `DateValue.parseFromString`'s examples: `2025-12-31`,
  `…T23:59`, `… 23:59:59`, fractional seconds, `Z`, `±HH:MM`, `±HHMM`, `±HH`;
  `/` and `.` separators and one-digit month/day accepted.
- **Durations** parse the documented units (`y/year/years`, `M/month/months`,
  `w`, `d`, `h`, `m`, `s`; single letters case-sensitive, words not), compound
  strings (`1y 2M`, `1 day, 2 hours`) and ISO 8601 (`P1DT12H`). They are added to
  dates the way moment's `add` is: milliseconds, then rounded days, then rounded
  months with day-of-month clamping — so `date("2024-12-01") + "1M" + "4h" +
  "3m"` is `2025-01-01 04:03:00` (docs) and Jan 31 + 1M is Feb 28.
- **Date − date** is a Duration (kepano); `(now() + "1d") - now()` has
  `.milliseconds == 86400000` and `number()` of it is 86400000 (docs wording).
  `duration * n` and `duration / n` scale; `n * duration` is an error with the
  docs' own advice ("the duration must be on the left").
- **Duration display**: `1 year, 2 months, 3 days, 4 hours` **(judgment; the
  forum only says it shows years, months, days, minutes and seconds)**.
- **`relative()`** is moment's `fromNow()` in English with default thresholds.
- **`format()`** implements moment tokens: `YYYY YY Y Q Qo M MM MMM MMMM Mo D DD
  Do DDD DDDD DDDDo d do dd ddd dddd e E w wo ww W Wo WW gg gggg GG GGGG H HH h
  hh k kk m mm s ss S…SSSSSSSSS A a Z ZZ X x Hmm Hmmss hmm hmmss`, `[escaped]`,
  `\x`, and the `en` long formats `LT LTS L LL LLL LLLL l ll lll llll`.
- **`==`** is `Value.looseEquals`: numbers equal numeric strings; dates equal
  parseable date strings; links equal when they resolve to the same file, or
  (both unresolved) when their link text matches (docs); a link equals a file
  it resolves to (`author == this`); tags compare without `#`, case-insensitively
  (published bases use both `file.tags.contains("recipes")` and
  `contains("#source/paper")`); lists and objects compare element-wise.
- **`<`/`>`** compare numbers, dates (with date strings), durations, and strings
  by UTF-16 code units; anything involving null is false.
- **`&&`/`||`** return an operand, as JavaScript does — `name || file.name` in
  the charted-roots template relies on it.
- **Missing values in arithmetic**: `null` poisons `- * / %` and numeric `+`
  (result `null`, an empty cell) and concatenates as `""` with strings. JS would
  give `0`/`"null"`; this avoids averages polluted by zeros **(judgment)**.
  Other JS coercions stand: `true + 1 == 2`, `"6" * "7" == 42`, string + anything
  concatenates, list + list concatenates.
- **Methods on null** (other than the any-type four) are errors — kepano's skill
  says `date(due_date)` "crashes if due_date is empty". Field access and
  indexing on null return null.
- **`list(null)`** is `[]` **(judgment)**. Negative list indices count from the
  end (`[-1]` appears in published bases).
- **`if()`**, `filter/map/reduce` arguments are evaluated lazily; `value`,
  `index`, `acc` are bound per element; `values` in summaries.
- **Formulas** are evaluated at most once per row (cached), with cycle
  detection reporting the chain (`a → b → a`). An empty formula is `null`.
- **Regular expressions** are JS literals compiled with `regex-lite` (flags
  `i m s` inline, `g` controls replace-all); no look-around or backreferences.
  `replace` translates `$1 $& $<name> $$`.
- **String indices and `length`** are UTF-16 code units (JS strings).
- **`file.hasTag`** matches nested tags (`book` matches `#book/scifi`);
  **`inFolder`** includes sub-folders and ignores leading/trailing `/`;
  **`hasLink`** resolves each outgoing link (frontmatter included) and compares
  files, falling back to link text for unresolved links.
- **Link resolution** (for `asFile`, `==`, `file()`, `hasLink`): exact path,
  path + `.md`, path relative to the source folder, then name/basename match
  preferring the source's folder, then the shortest path — the documented
  behaviour of `getFirstLinkpathDest`.

## Views

- Global and view filters are ANDed; `not` is "none of the following"; an
  empty statement matches everything. A syntax error in a filter matches
  nothing and is reported in `errors` with its `source` (`views[0].filters.and[1]`)
  and UTF-16 offsets; the first evaluation error per statement is reported with
  the offending file, and that row is excluded.
- Order of operations: filter → sort → `limit` (`total` is before, `count`
  after) → group → cells → summaries (per group and overall, over the rows
  shown).
- Sorting is stable over the input order, multi-key, empty values last in both
  directions, then by type, numbers numerically, dates chronologically, text
  naturally (number-aware, case-insensitive like `localeCompare` with
  `numeric: true`).
- Grouping keys use loose equality within a type (links to the same file group
  together); rows with an empty key go to one `null` group, sorted last.
- Columns come from `order` (default `[file.name]`), normalised to
  `note.x`/`file.x`/`formula.x`; display names from `properties` (matching
  either `x` or `note.x`), else the default: note/formula name, or for file
  properties `file name`, `file base name`, `file path`, `folder`,
  `file extension`, `file size`, `created time`, `modified time`, `file tags`,
  `file links`, `file embeds`, `backlinks`, `file properties` **(judgment for the
  exact wording)**. `columnSize` becomes `Column.width`.
- Built-in summaries (case-insensitive): Average, Min, Max, Sum, Range, Median,
  Stddev (population), Earliest, Latest, Range over dates (a Duration), Checked,
  Unchecked, Empty, Filled, Unique (distinct non-empty values). Custom summaries
  in the base's `summaries` section take precedence over built-ins with the same
  name. A custom summary that errors over a group with no values is empty.

## File format

- `parse_base` reads YAML 1.2 (yaml-rust2), keeps unknown keys at the top
  level, inside `properties.*` and inside each view, and remembers key order.
  `serialize_base` writes them back in that order (new keys after), block style,
  two-space indent, plain scalars where safe, single quotes otherwise, `|-`/`|`/`|+`
  block literals for multi-line formulas, `{}`/`[]` for empty sections that were
  present. Direction is normalised to `ASC`/`DESC`; the legacy sort key `column`
  is read as `property`.
- Typed view options: `limit filters groupBy order sort summaries columnSize
  rowHeight cardSize image imageFit imageAspectRatio`. Everything else (list
  `markers/separator/indentProperties/nestedProperties`, map settings, plugin
  views) is preserved in `extra`.
- `validate_base` parses every expression and returns all syntax errors with
  sources — the formula editor's green check.

## Known gaps

- Frontmatter objects arrive as `serde_json::Map`, which sorts keys, so
  `meta.keys()` on a frontmatter object is alphabetical rather than file order
  (object literals in formulas keep their order).
- One fixed timezone offset per run: DST transitions inside a date range are not
  modelled.
- Regex engine is regex-lite: no look-around, backreferences or Unicode classes.
- `file.backlinks`, `file.links` and `file.embeds` are only as good as the
  `FileRecord` the caller builds; resolution is a faithful-in-spirit
  reimplementation, not vault-index's.
- Error message wording is ours; Obsidian's exact strings are not public.
- No `RelativeDateValue`/`TagValue` producers beyond `file.tags` and `tags`-typed
  properties; kanban column ordering, table search and CSV export are UI
  concerns left to `packages/app`.
