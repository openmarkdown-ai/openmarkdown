//! Evaluates a matcher tree against one file, reproducing the result shapes
//! of Obsidian's matcher classes.
//!
//! Every matcher answers one of three things, exactly like the app's
//! `match()` returning an object, `null` or `undefined`:
//!
//! * [`Outcome::Hit`] — matched, with ranges per key;
//! * [`Outcome::Null`] — did not match;
//! * [`Outcome::Undef`] — not applicable here (e.g. `path:` evaluated where
//!   there is no path, `""`). At the top level "not applicable" counts as a
//!   match with no ranges, which is why `-foo` alone lists every file
//!   without `foo`, and why `//` matches everything.
//!
//! A context carries the strings a file exposes (`filename`, `filepath`,
//! `content`, and for property/tag matching `propertyName` / `tag`) and the
//! subset of *keys* plain terms look at. For a note the keys are file name
//! and content; for a canvas or base just the file name; for an attachment
//! none, so only `file:` and `path:` can find it.
//!
//! Ranges are byte offsets relative to the string they were found in and are
//! shifted into place by the chunking operators, as the app does; the caller
//! converts them to UTF-16.

use super::parser::{Node, RegexTerm};
use crate::index::Note;
use crate::tags::{frontmatter_tags, tags_key};
use crate::util::{self, find_all, find_whole_word};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::cell::OnceCell;

pub(crate) type Range = [usize; 2];

/// A property match (`properties` in the app's result object).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PropertyHit {
    pub key: String,
    /// Index into a list value.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subkey: Option<Vec<usize>>,
    /// UTF-16 range inside the value's string form.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pos: Option<[u32; 2]>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Hits {
    pub filename: Option<Vec<Range>>,
    pub filepath: Option<Vec<Range>>,
    pub content: Option<Vec<Range>>,
    pub property_name: Option<Vec<Range>>,
    pub tag: Option<Vec<Range>>,
    pub properties: Option<Vec<PropertyHit>>,
}

impl Hits {
    /// `jA(this, other)`: prepend `other`'s ranges for every key it has.
    fn absorb(&mut self, other: Hits) {
        fn join<T>(into: &mut Option<Vec<T>>, from: Option<Vec<T>>) {
            if let Some(mut f) = from {
                if let Some(existing) = into.take() {
                    f.extend(existing);
                }
                *into = Some(f);
            }
        }
        join(&mut self.filename, other.filename);
        join(&mut self.filepath, other.filepath);
        join(&mut self.content, other.content);
        join(&mut self.property_name, other.property_name);
        join(&mut self.tag, other.tag);
        join(&mut self.properties, other.properties);
    }

    pub fn normalize(&mut self) {
        for k in [
            &mut self.filename,
            &mut self.filepath,
            &mut self.content,
            &mut self.property_name,
            &mut self.tag,
        ] {
            if let Some(v) = k.take() {
                *k = Some(util::merge_ranges(v));
            }
        }
    }

    pub fn count(&self) -> usize {
        [
            &self.filename,
            &self.filepath,
            &self.content,
            &self.property_name,
            &self.tag,
        ]
        .iter()
        .map(|k| k.as_ref().map_or(0, Vec::len))
        .sum::<usize>()
            + self.properties.as_ref().map_or(0, Vec::len)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Outcome {
    Null,
    Undef,
    Hit(Hits),
}

pub(crate) const K_FILENAME: u8 = 1;
pub(crate) const K_FILEPATH: u8 = 2;
pub(crate) const K_CONTENT: u8 = 4;
pub(crate) const K_PROPNAME: u8 = 8;
pub(crate) const K_TAG: u8 = 16;

/// A string plus its lazily computed case fold.
pub(crate) struct Lazy<'a> {
    raw: Cow<'a, str>,
    fold: OnceCell<String>,
}

impl<'a> Lazy<'a> {
    pub fn new(raw: impl Into<Cow<'a, str>>) -> Self {
        Lazy {
            raw: raw.into(),
            fold: OnceCell::new(),
        }
    }
    fn folded(&self) -> &str {
        self.fold.get_or_init(|| util::fold(&self.raw))
    }
    pub fn whole(&self) -> Str<'_> {
        Str {
            lazy: self,
            start: 0,
            end: self.raw.len(),
        }
    }
}

/// A slice of a [`Lazy`] string.
#[derive(Clone, Copy)]
pub(crate) struct Str<'a> {
    lazy: &'a Lazy<'a>,
    start: usize,
    end: usize,
}

impl<'a> Str<'a> {
    fn raw(&self) -> &'a str {
        &self.lazy.raw[self.start..self.end]
    }
    fn folded(&self) -> &'a str {
        &self.lazy.folded()[self.start..self.end]
    }
    /// A sub-slice, byte offsets relative to this slice (clamped).
    fn sub(&self, s: usize, e: usize) -> Str<'a> {
        let len = self.end - self.start;
        let (s, e) = (s.min(len), e.min(len).max(s.min(len)));
        Str {
            lazy: self.lazy,
            start: self.start + s,
            end: self.start + e,
        }
    }
    fn len(&self) -> usize {
        self.end - self.start
    }
}

/// Heading-delimited sections (`SP`'s list).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Sec {
    start: usize,
    end: usize,
    children: usize,
}

#[derive(Clone, Copy)]
pub(crate) struct Ctx<'a> {
    pub filename: Option<Str<'a>>,
    pub filepath: Option<Str<'a>>,
    pub content: Option<Str<'a>>,
    pub property_name: Option<Str<'a>>,
    pub tag: Option<Str<'a>>,
    pub keys: u8,
    pub case_sensitive: bool,
    pub note: Option<&'a Note>,
    /// `EP` data: the section list being iterated and the current index.
    /// `Some((None, _))` marks "inside a section search of a note with no
    /// headings".
    sections: SectionState<'a>,
    /// `MP` data: the property value a value matcher is looking at.
    prop_value: Option<&'a Value>,
}

impl<'a> Ctx<'a> {
    pub fn new(keys: u8, case_sensitive: bool) -> Self {
        Ctx {
            filename: None,
            filepath: None,
            content: None,
            property_name: None,
            tag: None,
            keys,
            case_sensitive,
            note: None,
            sections: None,
            prop_value: None,
        }
    }

    fn key_strings(&self) -> impl Iterator<Item = (u8, Str<'a>)> + '_ {
        [
            (K_FILENAME, self.filename),
            (K_FILEPATH, self.filepath),
            (K_CONTENT, self.content),
            (K_PROPNAME, self.property_name),
            (K_TAG, self.tag),
        ]
        .into_iter()
        .filter(move |(k, s)| self.keys & k != 0 && s.is_some())
        .map(|(k, s)| (k, s.unwrap()))
    }
}

fn set_key(h: &mut Hits, key: u8, v: Vec<Range>) {
    match key {
        K_FILENAME => h.filename = Some(v),
        K_FILEPATH => h.filepath = Some(v),
        K_CONTENT => h.content = Some(v),
        K_PROPNAME => h.property_name = Some(v),
        _ => h.tag = Some(v),
    }
}

pub(crate) fn eval<'a>(n: &Node, ctx: &Ctx<'a>) -> Outcome {
    match n {
        Node::Text(t) => {
            if t.is_empty() {
                return Outcome::Null;
            }
            let needle = if ctx.case_sensitive {
                t.clone()
            } else {
                util::fold(t)
            };
            per_key(ctx, |_, s| {
                find_all(
                    s.raw(),
                    || Cow::Borrowed(s.folded()),
                    &needle,
                    ctx.case_sensitive,
                )
            })
        }
        Node::Regex(r) => eval_regex(r, ctx),
        Node::Exact(t) => {
            if t.is_empty() {
                return Outcome::Undef;
            }
            let needle = if ctx.case_sensitive {
                t.clone()
            } else {
                util::fold(t)
            };
            let t_lower = t.to_lowercase();
            per_key(ctx, |key, s| match key {
                K_PROPNAME => {
                    if s.raw().to_lowercase() == t_lower {
                        vec![[0, s.len()]]
                    } else {
                        Vec::new()
                    }
                }
                K_CONTENT => find_whole_word(
                    s.raw(),
                    || Cow::Borrowed(s.folded()),
                    t,
                    ctx.case_sensitive,
                    true,
                ),
                _ => find_all(
                    s.raw(),
                    || Cow::Borrowed(s.folded()),
                    &needle,
                    ctx.case_sensitive,
                ),
            })
        }
        Node::And(items) => {
            let mut acc: Option<Hits> = None;
            for m in items {
                match eval(m, ctx) {
                    Outcome::Null => return Outcome::Null,
                    Outcome::Undef => {}
                    Outcome::Hit(h) => match &mut acc {
                        Some(a) => a.absorb(h),
                        None => acc = Some(h),
                    },
                }
            }
            acc.map_or(Outcome::Undef, Outcome::Hit)
        }
        Node::Or(items) => {
            let mut state = Outcome::Undef;
            for m in items {
                let r = eval(m, ctx);
                let state_hit = matches!(state, Outcome::Hit(_));
                if state_hit || r == Outcome::Undef {
                    if let (Outcome::Hit(a), Outcome::Hit(h)) = (&mut state, r) {
                        a.absorb(h);
                    }
                } else {
                    state = r;
                }
            }
            state
        }
        Node::Not(inner) => match eval(inner, ctx) {
            Outcome::Undef => Outcome::Undef,
            Outcome::Hit(_) => Outcome::Null,
            Outcome::Null => Outcome::Hit(Hits::default()),
        },
        Node::Case(cs, inner) => {
            let mut c = *ctx;
            c.case_sensitive = *cs;
            eval(inner, &c)
        }
        Node::Path(inner) => scoped(ctx, ctx.filepath.is_some(), K_FILEPATH, inner),
        Node::File(inner) => scoped(ctx, ctx.filename.is_some(), K_FILENAME, inner),
        Node::Content(inner) => scoped(ctx, ctx.content.is_some(), K_CONTENT, inner),
        Node::Line(inner) => {
            let Some(content) = ctx.content else {
                return Outcome::Undef;
            };
            let raw = content.raw();
            let mut chunks = Vec::new();
            let mut off = 0usize;
            for line in raw.split('\n') {
                chunks.push((content.sub(off, off + line.len()), off, None));
                off += line.len() + 1;
            }
            split_match(ctx, inner, chunks)
        }
        Node::Block(inner) => {
            let Some(content) = ctx.content else {
                return Outcome::Undef;
            };
            let Some(note) = ctx.note else {
                return Outcome::Null;
            };
            let mut chunks = Vec::new();
            if let Some(secs) = &note.meta.sections {
                for s in secs.iter().filter(|s| s.kind != "list") {
                    let (a, b) = (
                        note.byte(s.position.start.offset),
                        note.byte(s.position.end.offset),
                    );
                    chunks.push((content.sub(a, b), a, None));
                }
            }
            if let Some(items) = &note.meta.list_items {
                for li in items {
                    let (a, b) = (
                        note.byte(li.position.start.offset),
                        note.byte(li.position.end.offset),
                    );
                    chunks.push((content.sub(a, b), a, None));
                }
            }
            split_match(ctx, inner, chunks)
        }
        Node::Task(done, inner) => {
            let Some(content) = ctx.content else {
                return Outcome::Undef;
            };
            let Some(note) = ctx.note else {
                return Outcome::Null;
            };
            let mut chunks = Vec::new();
            if let Some(items) = &note.meta.list_items {
                for li in items {
                    let Some(task) = &li.task else { continue };
                    if let Some(want_done) = done {
                        if *want_done != (task != " ") {
                            continue;
                        }
                    }
                    let (a, b) = (
                        note.byte(li.position.start.offset),
                        note.byte(li.position.end.offset),
                    );
                    chunks.push((content.sub(a, b), a, None));
                }
            }
            split_match(ctx, inner, chunks)
        }
        Node::Section(inner) => eval_section(inner, ctx),
        Node::Everything => {
            let mut h = Hits::default();
            for (key, s) in ctx.key_strings() {
                if s.len() > 0 {
                    set_key(&mut h, key, vec![[0, 0]]);
                }
            }
            Outcome::Hit(h)
        }
        Node::Tag(tag) => eval_tag(tag, ctx),
        Node::Property { key, value } => eval_property(key, value.as_deref(), ctx),
        Node::Literal(expected) => {
            let v = ctx.prop_value.unwrap_or(&Value::Null);
            let ok = match expected {
                Some(b) => v.as_bool() == Some(*b),
                None => v.is_null(),
            };
            if ok {
                Outcome::Hit(Hits {
                    content: Some(vec![[0, js_string(v).len()]]),
                    ..Default::default()
                })
            } else {
                Outcome::Null
            }
        }
        Node::Compare { less, text } => {
            let Some(v) = ctx.prop_value.filter(|v| !v.is_null()) else {
                return Outcome::Null;
            };
            let ok = match js_compare(v, text) {
                Some(std::cmp::Ordering::Less) => *less,
                Some(std::cmp::Ordering::Greater) => !*less,
                _ => false,
            };
            if ok {
                Outcome::Hit(Hits {
                    content: Some(vec![[0, js_string(v).len()]]),
                    ..Default::default()
                })
            } else {
                Outcome::Null
            }
        }
    }
}

fn per_key<'a>(ctx: &Ctx<'a>, mut f: impl FnMut(u8, Str<'a>) -> Vec<Range>) -> Outcome {
    let mut h = Hits::default();
    let mut any = false;
    for (key, s) in ctx.key_strings() {
        let r = f(key, s);
        if !r.is_empty() {
            set_key(&mut h, key, r);
            any = true;
        }
    }
    if any {
        Outcome::Hit(h)
    } else {
        Outcome::Null
    }
}

fn eval_regex(r: &RegexTerm, ctx: &Ctx) -> Outcome {
    let re = if ctx.case_sensitive {
        &r.sensitive
    } else {
        &r.insensitive
    };
    let Some(re) = re else { return Outcome::Undef };
    per_key(ctx, |_, s| {
        re.find_iter(s.raw())
            .filter(|m| !m.is_empty())
            .map(|m| [m.start(), m.end()])
            .collect()
    })
}

fn scoped(ctx: &Ctx, present: bool, key: u8, inner: &Node) -> Outcome {
    if !present {
        return Outcome::Undef;
    }
    let mut c = *ctx;
    c.keys = key;
    eval(inner, &c)
}

/// Section iteration state: the list (None when the note has no headings)
/// and the current index.
type SectionState<'a> = Option<(Option<&'a [Sec]>, usize)>;

/// A content chunk, its offset within the parent content, and the section
/// state to evaluate it under.
type Chunk<'a> = (Str<'a>, usize, SectionState<'a>);

/// `wP.splitContentMatch`.
fn split_match<'a>(ctx: &Ctx<'a>, inner: &Node, chunks: Vec<Chunk<'a>>) -> Outcome {
    let mut matched = false;
    let mut undefined = false;
    let mut ranges = Vec::new();
    for (chunk, off, sections) in chunks {
        let mut c = *ctx;
        c.keys = K_CONTENT;
        c.content = Some(chunk);
        if sections.is_some() {
            c.sections = sections;
        }
        match eval(inner, &c) {
            Outcome::Undef => undefined = true,
            Outcome::Null => {}
            Outcome::Hit(h) => {
                matched = true;
                match h.content {
                    Some(v) => ranges.extend(v.into_iter().map(|r| [r[0] + off, r[1] + off])),
                    None => ranges.push([off, off]),
                }
            }
        }
    }
    if matched {
        Outcome::Hit(Hits {
            content: Some(ranges),
            ..Default::default()
        })
    } else if undefined {
        Outcome::Undef
    } else {
        Outcome::Null
    }
}

fn sections_of(note: &Note) -> Vec<Sec> {
    let Some(headings) = note.meta.headings.as_ref().filter(|h| !h.is_empty()) else {
        return Vec::new();
    };
    let len = note.text.len();
    let mut out = Vec::new();
    for (i, h) in headings.iter().enumerate() {
        let a = note.byte(h.position.start.offset);
        if i == 0 && a > 0 {
            out.push(Sec {
                start: 0,
                end: a,
                children: 0,
            });
        }
        let end = headings
            .get(i + 1)
            .map_or(len, |n| note.byte(n.position.start.offset));
        let children = headings[i + 1..]
            .iter()
            .take_while(|x| x.level > h.level)
            .count();
        out.push(Sec {
            start: a,
            end,
            children,
        });
    }
    out
}

fn eval_section<'a>(inner: &Node, ctx: &Ctx<'a>) -> Outcome {
    let Some(content) = ctx.content else {
        return Outcome::Undef;
    };
    let Some(note) = ctx.note else {
        return Outcome::Null;
    };
    let has_headings = note.meta.headings.as_ref().is_some_and(|h| !h.is_empty());
    if !has_headings {
        if ctx.sections.is_some() {
            return Outcome::Null;
        }
        let mut c = *ctx;
        c.sections = Some((None, 0));
        return eval(inner, &c);
    }
    // The original text, whatever slice `content` currently is.
    let original = Str {
        lazy: content.lazy,
        start: 0,
        end: content.lazy.raw.len(),
    };
    let owned;
    let (secs, base, from, to): (&[Sec], usize, usize, usize) = match ctx.sections {
        Some((None, _)) => return Outcome::Null,
        Some((Some(secs), idx)) => {
            let h = secs[idx];
            if h.children == 0 {
                return Outcome::Null;
            }
            (
                secs,
                h.start,
                idx + 1,
                (idx + 1 + h.children).min(secs.len()),
            )
        }
        None => {
            owned = sections_of(note);
            let n = owned.len();
            (&owned[..], 0, 0, n)
        }
    };
    let mut chunks = Vec::new();
    for (k, s) in secs.iter().enumerate().take(to).skip(from) {
        if s.end <= s.start {
            continue;
        }
        chunks.push((
            original.sub(s.start, s.end),
            s.start - base,
            Some((Some(secs), k)),
        ));
    }
    // SAFETY of lifetimes: `secs` lives for this call; chunks are consumed
    // before returning.
    split_match_local(ctx, inner, chunks)
}

/// `split_match` for chunks borrowing call-local data.
fn split_match_local<'a, 'b>(ctx: &Ctx<'a>, inner: &Node, chunks: Vec<Chunk<'b>>) -> Outcome
where
    'a: 'b,
{
    let c: Ctx<'b> = *ctx;
    split_match(&c, inner, chunks)
}

fn eval_tag(tag: &str, ctx: &Ctx) -> Outcome {
    let test = |candidate: &str| -> bool {
        let (c, t) = (candidate.to_lowercase(), tag.to_lowercase());
        c.strip_prefix(t.as_str())
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    if let Some(s) = ctx.tag {
        if test(s.raw()) {
            return Outcome::Hit(Hits::default());
        }
    }
    if ctx.content.is_none() {
        return Outcome::Undef;
    }
    let Some(note) = ctx.note else {
        return Outcome::Null;
    };
    let mut found = false;
    let mut properties = None;
    let fm = note.meta.frontmatter.as_ref();
    if let Some(ft) = frontmatter_tags(fm) {
        if ft.iter().any(|t| test(t)) {
            found = true;
            properties = Some(vec![PropertyHit {
                key: tags_key(fm.unwrap()),
                subkey: None,
                pos: None,
            }]);
        }
    }
    let mut content = Vec::new();
    if let Some(tags) = &note.meta.tags {
        for t in tags {
            if test(&t.tag) {
                content.push([
                    note.byte(t.position.start.offset),
                    note.byte(t.position.end.offset),
                ]);
                found = true;
            }
        }
    }
    if found {
        Outcome::Hit(Hits {
            content: Some(content),
            properties,
            ..Default::default()
        })
    } else {
        Outcome::Null
    }
}

fn eval_property(key: &Node, value: Option<&Node>, ctx: &Ctx) -> Outcome {
    if ctx.content.is_none() {
        return Outcome::Undef;
    }
    let Some(fm) = ctx.note.and_then(|n| n.meta.frontmatter.as_ref()) else {
        return Outcome::Null;
    };
    let mut hits = Vec::new();
    for (name, v) in fm {
        let name_lazy = Lazy::new(name.as_str());
        let mut kc = *ctx;
        kc.keys = K_PROPNAME;
        kc.property_name = Some(name_lazy.whole());
        if !matches!(eval(key, &kc), Outcome::Hit(_)) {
            continue;
        }
        let Some(value) = value else {
            hits.push(PropertyHit {
                key: name.clone(),
                subkey: None,
                pos: None,
            });
            continue;
        };
        let items: Vec<(Option<usize>, &Value)> = match v {
            Value::Array(a) => a.iter().enumerate().map(|(i, x)| (Some(i), x)).collect(),
            other => vec![(None, other)],
        };
        for (sub, item) in items {
            let s = js_string(item);
            let lazy = Lazy::new(s.as_str());
            let mut vc = *ctx;
            vc.keys = K_CONTENT;
            vc.content = Some(lazy.whole());
            vc.prop_value = Some(item);
            if let Outcome::Hit(Hits {
                content: Some(ranges),
                ..
            }) = eval(value, &vc)
            {
                let m = util::U16Mapper::new(&s);
                for r in m.map(&ranges) {
                    hits.push(PropertyHit {
                        key: name.clone(),
                        subkey: sub.map(|i| vec![i]),
                        pos: Some(r),
                    });
                }
            }
        }
    }
    if hits.is_empty() {
        Outcome::Null
    } else {
        Outcome::Hit(Hits {
            properties: Some(hits),
            ..Default::default()
        })
    }
}

/// JavaScript `String(value)` for JSON values.
pub(crate) fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn js_number_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(f64::NAN);
    if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        let s = format!("{f}");
        s.replace("e", "e+").replace("e+-", "e-")
    }
}

/// JavaScript `StringToNumber`.
fn js_to_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return i64::from_str_radix(rest, radix).map_or(f64::NAN, |v| v as f64);
        }
    }
    if t.chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
    {
        t.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// Abstract relational comparison of a property value with query text.
fn js_compare(v: &Value, text: &str) -> Option<std::cmp::Ordering> {
    let num = |x: f64| x.partial_cmp(&js_to_number(text));
    match v {
        Value::String(s) => Some(s.encode_utf16().cmp(text.encode_utf16())),
        Value::Array(_) | Value::Object(_) => {
            Some(js_string(v).encode_utf16().cmp(text.encode_utf16()))
        }
        Value::Number(n) => num(n.as_f64()?),
        Value::Bool(b) => num(if *b { 1.0 } else { 0.0 }),
        Value::Null => None,
    }
}
