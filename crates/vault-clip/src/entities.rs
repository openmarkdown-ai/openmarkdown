//! HTML character references.
//!
//! Not the full 2,231-entry HTML5 table — that is ~40 KB of wasm for names that
//! almost never occur in article markup. This covers the Latin-1 set, the
//! typographic punctuation publishers use, Greek letters and the common maths
//! and arrow symbols (Wikipedia and arXiv pages use these). An unknown name is
//! left as literal text, which is visible and harmless.
//!
//! Adapted from openread's read-core `dom.rs` (same author, MIT OR Apache-2.0),
//! extended with the legacy no-semicolon forms browsers accept and the
//! Windows-1252 remapping of numeric references in 0x80–0x9F.

pub fn named(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" | "AMP" => "&",
        "lt" | "LT" => "<",
        "gt" | "GT" => ">",
        "quot" | "QUOT" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "iexcl" => "¡",
        "cent" => "¢",
        "pound" => "£",
        "curren" => "¤",
        "yen" => "¥",
        "brvbar" => "¦",
        "sect" => "§",
        "uml" => "¨",
        "copy" | "COPY" => "©",
        "ordf" => "ª",
        "laquo" => "«",
        "not" => "¬",
        "shy" => "\u{ad}",
        "reg" | "REG" => "®",
        "macr" => "¯",
        "deg" => "°",
        "plusmn" | "pm" => "±",
        "sup2" => "²",
        "sup3" => "³",
        "acute" => "´",
        "micro" => "µ",
        "para" => "¶",
        "middot" | "centerdot" => "·",
        "cedil" => "¸",
        "sup1" => "¹",
        "ordm" => "º",
        "raquo" => "»",
        "frac14" => "¼",
        "frac12" | "half" => "½",
        "frac34" => "¾",
        "iquest" => "¿",
        "Agrave" => "À",
        "Aacute" => "Á",
        "Acirc" => "Â",
        "Atilde" => "Ã",
        "Auml" => "Ä",
        "Aring" => "Å",
        "AElig" => "Æ",
        "Ccedil" => "Ç",
        "Egrave" => "È",
        "Eacute" => "É",
        "Ecirc" => "Ê",
        "Euml" => "Ë",
        "Igrave" => "Ì",
        "Iacute" => "Í",
        "Icirc" => "Î",
        "Iuml" => "Ï",
        "ETH" => "Ð",
        "Ntilde" => "Ñ",
        "Ograve" => "Ò",
        "Oacute" => "Ó",
        "Ocirc" => "Ô",
        "Otilde" => "Õ",
        "Ouml" => "Ö",
        "times" => "×",
        "Oslash" => "Ø",
        "Ugrave" => "Ù",
        "Uacute" => "Ú",
        "Ucirc" => "Û",
        "Uuml" => "Ü",
        "Yacute" => "Ý",
        "THORN" => "Þ",
        "szlig" => "ß",
        "agrave" => "à",
        "aacute" => "á",
        "acirc" => "â",
        "atilde" => "ã",
        "auml" => "ä",
        "aring" => "å",
        "aelig" => "æ",
        "ccedil" => "ç",
        "egrave" => "è",
        "eacute" => "é",
        "ecirc" => "ê",
        "euml" => "ë",
        "igrave" => "ì",
        "iacute" => "í",
        "icirc" => "î",
        "iuml" => "ï",
        "eth" => "ð",
        "ntilde" => "ñ",
        "ograve" => "ò",
        "oacute" => "ó",
        "ocirc" => "ô",
        "otilde" => "õ",
        "ouml" => "ö",
        "divide" | "div" => "÷",
        "oslash" => "ø",
        "ugrave" => "ù",
        "uacute" => "ú",
        "ucirc" => "û",
        "uuml" => "ü",
        "yacute" => "ý",
        "thorn" => "þ",
        "yuml" => "ÿ",
        "OElig" => "Œ",
        "oelig" => "œ",
        "Scaron" => "Š",
        "scaron" => "š",
        "Yuml" => "Ÿ",
        "fnof" => "ƒ",
        "circ" => "ˆ",
        "tilde" => "˜",
        "ensp" => "\u{2002}",
        "emsp" => "\u{2003}",
        "thinsp" => "\u{2009}",
        "hairsp" => "\u{200a}",
        "ZeroWidthSpace" => "\u{200b}",
        "zwnj" => "\u{200c}",
        "zwj" => "\u{200d}",
        "lrm" => "\u{200e}",
        "rlm" => "\u{200f}",
        "ndash" => "–",
        "mdash" => "—",
        "horbar" => "―",
        "lsquo" => "\u{2018}",
        "rsquo" | "rsquor" => "\u{2019}",
        "sbquo" => "‚",
        "ldquo" => "\u{201c}",
        "rdquo" | "rdquor" => "\u{201d}",
        "bdquo" => "„",
        "dagger" => "†",
        "Dagger" => "‡",
        "bull" | "bullet" => "•",
        "hellip" | "mldr" => "…",
        "permil" => "‰",
        "prime" => "′",
        "Prime" => "″",
        "lsaquo" => "‹",
        "rsaquo" => "›",
        "oline" => "‾",
        "frasl" => "⁄",
        "euro" => "€",
        "trade" | "TRADE" => "™",
        "larr" | "leftarrow" => "←",
        "uarr" => "↑",
        "rarr" | "rightarrow" | "srarr" => "→",
        "darr" => "↓",
        "harr" => "↔",
        "crarr" => "↵",
        "lArr" | "Leftarrow" => "⇐",
        "uArr" => "⇑",
        "rArr" | "Rightarrow" | "Implies" => "⇒",
        "dArr" => "⇓",
        "hArr" | "iff" => "⇔",
        "mapsto" => "↦",
        "forall" => "∀",
        "part" => "∂",
        "exist" => "∃",
        "empty" | "emptyset" => "∅",
        "nabla" => "∇",
        "isin" | "in" => "∈",
        "notin" => "∉",
        "ni" => "∋",
        "prod" => "∏",
        "sum" => "∑",
        "minus" => "−",
        "mnplus" | "mp" => "∓",
        "lowast" => "∗",
        "radic" | "Sqrt" => "√",
        "prop" | "propto" => "∝",
        "infin" => "∞",
        "ang" | "angle" => "∠",
        "mid" => "∣",
        "parallel" | "par" => "∥",
        "and" | "wedge" => "∧",
        "or" | "vee" => "∨",
        "cap" => "∩",
        "cup" => "∪",
        "int" => "∫",
        "there4" | "therefore" => "∴",
        "sim" => "∼",
        "cong" => "≅",
        "asymp" | "approx" => "≈",
        "ne" => "≠",
        "equiv" => "≡",
        "le" | "leq" => "≤",
        "ge" | "geq" => "≥",
        "ll" => "≪",
        "gg" => "≫",
        "sub" | "subset" => "⊂",
        "sup" | "supset" => "⊃",
        "nsub" => "⊄",
        "sube" => "⊆",
        "supe" => "⊇",
        "oplus" => "⊕",
        "otimes" => "⊗",
        "perp" => "⊥",
        "sdot" => "⋅",
        "lceil" => "⌈",
        "rceil" => "⌉",
        "lfloor" => "⌊",
        "rfloor" => "⌋",
        "lang" | "langle" => "⟨",
        "rang" | "rangle" => "⟩",
        "loz" => "◊",
        "spades" => "♠",
        "clubs" => "♣",
        "hearts" => "♥",
        "diams" => "♦",
        "check" | "checkmark" => "✓",
        "cross" => "✗",
        "star" => "☆",
        "starf" => "★",
        "Alpha" => "Α",
        "Beta" => "Β",
        "Gamma" => "Γ",
        "Delta" => "Δ",
        "Epsilon" => "Ε",
        "Zeta" => "Ζ",
        "Eta" => "Η",
        "Theta" => "Θ",
        "Iota" => "Ι",
        "Kappa" => "Κ",
        "Lambda" => "Λ",
        "Mu" => "Μ",
        "Nu" => "Ν",
        "Xi" => "Ξ",
        "Omicron" => "Ο",
        "Pi" => "Π",
        "Rho" => "Ρ",
        "Sigma" => "Σ",
        "Tau" => "Τ",
        "Upsilon" => "Υ",
        "Phi" => "Φ",
        "Chi" => "Χ",
        "Psi" => "Ψ",
        "Omega" => "Ω",
        "alpha" => "α",
        "beta" => "β",
        "gamma" => "γ",
        "delta" => "δ",
        "epsilon" | "epsi" => "ε",
        "zeta" => "ζ",
        "eta" => "η",
        "theta" => "θ",
        "iota" => "ι",
        "kappa" => "κ",
        "lambda" => "λ",
        "mu" => "μ",
        "nu" => "ν",
        "xi" => "ξ",
        "omicron" => "ο",
        "pi" => "π",
        "rho" => "ρ",
        "sigmaf" => "ς",
        "sigma" => "σ",
        "tau" => "τ",
        "upsilon" => "υ",
        "phi" => "φ",
        "chi" => "χ",
        "psi" => "ψ",
        "omega" => "ω",
        "thetasym" => "ϑ",
        "piv" => "ϖ",
        "NewLine" => "\n",
        "Tab" => "\t",
        "excl" => "!",
        "num" => "#",
        "dollar" => "$",
        "percnt" => "%",
        "lpar" => "(",
        "rpar" => ")",
        "ast" => "*",
        "plus" => "+",
        "comma" => ",",
        "period" => ".",
        "sol" => "/",
        "colon" => ":",
        "semi" => ";",
        "equals" => "=",
        "quest" => "?",
        "commat" => "@",
        "lsqb" | "lbrack" => "[",
        "bsol" => "\\",
        "rsqb" | "rbrack" => "]",
        "Hat" => "^",
        "lowbar" | "UnderBar" => "_",
        "grave" => "`",
        "lcub" | "lbrace" => "{",
        "verbar" | "vert" => "|",
        "rcub" | "rbrace" => "}",
        _ => return None,
    })
}

/// Names browsers decode even without a trailing semicolon.
const LEGACY: &[&str] = &[
    "amp", "lt", "gt", "quot", "nbsp", "copy", "reg", "AMP", "LT", "GT", "QUOT", "COPY", "REG",
];

fn cp1252(cp: u32) -> u32 {
    const TABLE: [u32; 32] = [
        0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160,
        0x2039, 0x0152, 0x8D, 0x017D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013,
        0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
    ];
    if (0x80..=0x9F).contains(&cp) {
        TABLE[(cp - 0x80) as usize]
    } else {
        cp
    }
}

/// Decode character references. `in_attribute` applies the attribute rule for
/// legacy semicolon-less names (not decoded when followed by `=` or an
/// alphanumeric, so query strings like `?a=1&copy=2` survive).
pub fn decode(s: &str, in_attribute: bool) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut last = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            i += 1;
            continue;
        }
        out.push_str(&s[last..i]);
        let rest = &s[i + 1..];
        if let Some(num) = rest.strip_prefix('#') {
            let (hex, digits_start) = if num.starts_with('x') || num.starts_with('X') {
                (true, 1)
            } else {
                (false, 0)
            };
            let digits: &str = &num[digits_start..];
            let len = digits
                .bytes()
                .take_while(|b| if hex { b.is_ascii_hexdigit() } else { b.is_ascii_digit() })
                .count();
            if len > 0 {
                let value = u32::from_str_radix(&digits[..len.min(8)], if hex { 16 } else { 10 })
                    .unwrap_or(0xFFFD);
                let cp = cp1252(value);
                let ch = match cp {
                    0 => '\u{FFFD}',
                    _ => char::from_u32(cp).unwrap_or('\u{FFFD}'),
                };
                out.push(ch);
                let mut consumed = 1 + 1 + digits_start + len;
                if digits.as_bytes().get(len) == Some(&b';') {
                    consumed += 1;
                }
                i += consumed;
                last = i;
                continue;
            }
            out.push('&');
            i += 1;
            last = i;
            continue;
        }
        // Named reference: longest alphanumeric run, then `;`.
        let name_len = rest
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric())
            .take(32)
            .count();
        let name = &rest[..name_len];
        if rest.as_bytes().get(name_len) == Some(&b';') {
            if let Some(rep) = named(name) {
                out.push_str(rep);
                i += 1 + name_len + 1;
                last = i;
                continue;
            }
        }
        // Legacy prefix without semicolon.
        let mut matched = false;
        for legacy in LEGACY {
            if name.starts_with(legacy) {
                let next = rest.as_bytes().get(legacy.len()).copied();
                if in_attribute
                    && next.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'=')
                {
                    break;
                }
                out.push_str(named(legacy).unwrap_or(""));
                i += 1 + legacy.len();
                last = i;
                matched = true;
                break;
            }
        }
        if !matched {
            out.push('&');
            i += 1;
            last = i;
        }
    }
    out.push_str(&s[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_named_numeric_and_legacy_forms() {
        assert_eq!(decode("a &amp; b &lt;c&gt;", false), "a & b <c>");
        assert_eq!(decode("&#8212;&#x2014;&#X2014", false), "———");
        assert_eq!(decode("&#150;", false), "–");
        assert_eq!(decode("R&D and Q&A", false), "R&D and Q&A");
        assert_eq!(decode("&unknown; x", false), "&unknown; x");
        assert_eq!(decode("&copy 2024", false), "© 2024");
        assert_eq!(decode("?a=1&copy=2", true), "?a=1&copy=2");
        assert_eq!(decode("&amp;amp;", false), "&amp;");
    }
}
