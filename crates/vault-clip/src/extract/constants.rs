//! Defuddle's `constants.ts`: entry points, clutter selectors, the partial
//! class/id patterns, footnote selectors and the attribute allowlist.

pub const ENTRY_POINT_ELEMENTS: &[&str] = &[
    "#post",
    ".post-content",
    ".post-body",
    ".article-content",
    "#article-content",
    ".js-article-content",
    ".article_post",
    ".article-wrapper",
    ".entry-content",
    ".content-article",
    ".instapaper_body",
    ".post",
    ".markdown-body",
    "article",
    "[role=\"article\"]",
    "main",
    "[role=\"main\"]",
    ".article-body",
    "#content",
    "body",
];

pub const BLOCK_ELEMENTS: &[&str] =
    &["div", "section", "article", "main", "aside", "header", "footer", "nav", "content"];
pub const BLOCK_ELEMENTS_SELECTOR: &str = "div,section,article,main,aside,header,footer,nav,content";

pub fn is_block_element(tag: &str) -> bool {
    BLOCK_ELEMENTS.contains(&tag)
}

pub fn is_block_level(tag: &str) -> bool {
    is_block_element(tag)
        || matches!(
            tag,
            "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "li" | "dl" | "dt"
                | "dd" | "pre" | "blockquote" | "figure" | "figcaption" | "table" | "thead"
                | "tbody" | "tfoot" | "tr" | "td" | "th" | "details" | "summary" | "address"
                | "hr" | "form" | "fieldset"
        )
}

pub fn is_preserve(tag: &str) -> bool {
    matches!(
        tag,
        "pre" | "code" | "table" | "thead" | "tbody" | "tr" | "td" | "th" | "ul" | "ol" | "li"
            | "dl" | "dt" | "dd" | "figure" | "figcaption" | "picture" | "details" | "summary"
            | "blockquote" | "form" | "fieldset"
    )
}

pub fn is_inline(tag: &str) -> bool {
    matches!(
        tag,
        "a" | "span" | "strong" | "em" | "i" | "b" | "u" | "code" | "br" | "small" | "sub"
            | "sup" | "mark" | "date" | "del" | "ins" | "q" | "abbr" | "cite" | "relative-time"
            | "time" | "font"
    )
}

pub fn is_heading(tag: &str) -> bool {
    matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}

pub const CONTENT_ELEMENT_SELECTOR: &str = "math, [data-mathml], .katex, .katex-mathml, .katex-display, .MathJax, .MathJax_Display, .MathJax_SVG, mjx-container, pre, code, table, img, picture, video, blockquote, figure";
pub const CONTENT_ELEMENT_NO_IMG_SELECTOR: &str = "math, [data-mathml], .katex, .katex-mathml, .katex-display, .MathJax, .MathJax_Display, .MathJax_SVG, mjx-container, pre, code, table, video, blockquote, figure";

pub const HIDDEN_EXACT_SKIP_SELECTOR: &str = "[hidden],[aria-hidden=\"true\"],.hidden,.invisible";
pub const HIDDEN_EXACT_SELECTOR: &str = "[hidden],[aria-hidden=\"true\"]:not([class*=\"math\"]):not(svg):not([class*=\"paywall\"]),.hidden,.invisible";

pub const EXACT_SELECTORS: &[&str] = &[
    "noscript",
    "script:not([type^=\"math/\"])",
    "style",
    "meta",
    "link",
    "audio:not([src]):not(:has(source))",
    "video:not([src]):not(:has(source))",
    ".jwplayer",
    ".ad:not([class*=\"gradient\"])",
    "[class^=\"ad-\" i]",
    "[class$=\"-ad\" i]",
    "[data-ad-wrapper]",
    "[id^=\"ad-\" i]",
    "[id$=\"-ad\" i]",
    "[role=\"banner\" i]",
    "[alt*=\"advert\" i]",
    ".promo",
    ".Promo",
    "#barrier-page",
    ".alert",
    "[rel=\"sponsored\" i]",
    "[href*=\"source=promotion\" i]",
    "[id=\"comments\" i]",
    "[id=\"comment\" i]",
    "div[class*=\"cover-\"]",
    "div[id*=\"cover-\"]",
    "ads-breadcrumbs",
    "header:not(:has(p + p)):not(:has(img))",
    "header[class~=\"fixed\"]",
    "header[class~=\"sticky\"]",
    ".header:not(.banner)",
    "#header",
    "#Header",
    "#banner",
    "#Banner",
    "nav",
    ".navigation",
    "#navigation",
    "[role=\"navigation\" i]",
    "[role=\"dialog\" i]",
    "[role=\"alertdialog\" i]",
    "[role*=\"complementary\" i]",
    "[class*=\"pagination\" i]",
    ".menu",
    "#siteSub",
    ".previous",
    ".author",
    ".Author",
    "[class$=\"_bio\"]",
    "#categories",
    ".contributor",
    ".date",
    "#date",
    "[data-date]",
    ".entry-meta",
    ".meta",
    ".tags",
    "#tags",
    "[rel=\"tag\"]",
    ".headline",
    "#headline",
    "#title",
    "#Title",
    "#articleTag",
    "[href*=\"/author/\"]",
    "[href*=\"/author?\"]",
    "[href$=\"/author\"]",
    "a[href*=\"copyright.com\"]",
    "a[href*=\"google.com/preferences\"]",
    "[href=\"#top\"]",
    "[href=\"#Top\"]",
    "[href=\"#page-header\"]",
    "[href=\"#content\"]",
    "[href=\"#site-content\"]",
    "[href=\"#main-content\"]",
    "[href^=\"#main\"]",
    "[src*=\"author\"]",
    ".toc",
    ".Toc",
    "#toc",
    "[href*=\"#toc\"]",
    "footer",
    "ignore",
    ".aside",
    "aside:not([class*=\"callout\"])",
    "button",
    "canvas",
    "date",
    "dialog",
    "fieldset",
    "form",
    "input:not([type=\"checkbox\"])",
    "input[type=\"checkbox\"][class*=\"sidebar\" i]",
    "input[type=\"checkbox\"][id*=\"sidebar\" i]",
    "input[type=\"checkbox\"][class*=\"drawer\" i]",
    "input[type=\"checkbox\"][id*=\"drawer\" i]",
    "input[type=\"checkbox\"][class*=\"hamburger\" i]",
    "input[type=\"checkbox\"][id*=\"hamburger\" i]",
    "input[type=\"checkbox\"][class*=\"toggle\" i]",
    "input[type=\"checkbox\"][id*=\"toggle\" i]",
    "input[type=\"checkbox\"][class*=\"trigger\" i]",
    "input[type=\"checkbox\"][id*=\"trigger\" i]",
    "label",
    "option",
    "select",
    "[role=\"listbox\"]",
    "[role=\"option\"]",
    "textarea",
    "[hidden]",
    "[aria-hidden=\"true\"]:not([class*=\"math\"]):not(svg):not([class*=\"paywall\"])",
    ".hidden",
    ".invisible",
    "instaread-player",
    "iframe:not([src])",
    "iframe[src*=\"blink.net\"]",
    "iframe[src*=\"giscus.app\"]",
    "iframe[src*=\"tinypass.com\"]",
    "iframe[src*=\"trinitymedia.ai\"]",
    "[class=\"logo\" i]",
    "#logo",
    "#Logo",
    "#newsletter",
    "#Newsletter",
    ".subscribe",
    "[data-component-name=\"ButtonCreateButton\"]",
    "[data-component-name=\"DigestPostEmbed\"]",
    "[data-component-name=\"SubscribeWidgetToDOM\"]",
    "[class*=\"digestPostEmbed\"]",
    ".noprint",
    "[data-print-layout=\"hide\" i]",
    "[data-block=\"donotprint\" i]",
    "[class*=\"clickable-icon\" i]",
    "li span[class*=\"ltx_tag\" i][class*=\"ltx_tag_item\" i]",
    "a[href^=\"#\"][class*=\"anchor\" i]",
    "a[href^=\"#\"][class*=\"ref\" i]:not(.ltx_ref):not(.footnote-backref)",
    "[data-container*=\"most-viewed\" i]",
    ".sidebar",
    ".Sidebar",
    "#sidebar",
    "#Sidebar",
    "#side-bar",
    "#secondary",
    "#sitesub",
    "[href*=\"/sitemap/sitemap.xml\"]",
    "[data-link-name*=\"skip\" i]",
    "[aria-label*=\"skip\" i]",
    "[title^=\"Share on\" i]",
    "[aria-label=\"Dismiss\" i]",
    "[aria-label=\"Close\" i]",
    "svg[data-icon]",
    "[data-testid=\"load-more-posts\"] + div",
    ".copyright",
    "#copyright",
    ".licensebox",
    "#page-info",
    "#rss",
    "#feed",
    ".gutter",
    "#primaryaudio",
    "#NYT_ABOVE_MAIN_CONTENT_REGION",
    "[data-testid=\"photoviewer-children-figure\"] > span",
    "table.infobox",
    "[data-optimizely=\"related-articles-section\" i]",
    "[data-orientation=\"vertical\"]",
    ".gh-header-sticky",
    "[data-testid=\"issue-metadata-sticky\"]",
];

pub const PARTIAL_SELECTORS: &[&str] = &[
    "a-statement", "(?<!main-)access-wall", "activitypub", "actioncall", "adcontainer",
    "addcomment", "addtoany", "advert", "adlayout", "ad-tldr", "ad-placement", "adplacehold",
    "ads-container", "_ad_", "AdBlock_", "AdUnit", "after_content", "after_main_article",
    "afterpost", "allterms", "-alert-", "alert-box", "_archive", "around-the-web",
    "aroundpages", "article-author", "article-badges", "article-banner",
    "article-bottom-section", "article-bottom", "article-category", "article-card",
    "article-citation", "article-continues", "article__copy", "article_date", "article-date",
    "article-end ", "articleheader", "article_header", "article-header", "article__header",
    "article__hero", "article__info", "article-info", "article-meta", "article_meta",
    "article__meta", "articlename", "article-subject", "article_subject", "article-snippet",
    "article-separator", "article--share", "article-share", "article--topics", "article-tools",
    "articletags", "article-tags", "article_tags", "articletitle", "article-title",
    "article_title", "articletopics", "article-topics", "article-actions", "article--lede",
    "articlewell", "associated-people", "ambient-video__button", "audio-card", "beyondwords",
    "about-author", "author-bio", "author-box", "author-info", "author_info", "authorm",
    "author-mini-bio", "author-name", "author-publish-info", "authored-by", "avatar",
    "back-to-top", "backlink_container", "backlinks-section", "bio-block", "biobox",
    "blog-pager", "bookmark-", "-bookmark", "bottominfo", "bottomnav", "bottom-of-article",
    "bottom-wrapper", "brand-bar", "bcrumb", "breadcrumb", "brdcrumb", "crumbs",
    "bubblewrapper", "button-wrapper", "buttons-container", "btn-", "-btn", "byline",
    "captcha", "card-text", "card-media", "card-post", "carouselcontainer",
    "carousel-container", "cat_header", "cat-overlay", "catlinks", "_categories",
    "card-author", "card-content", "chapter-list", "collections", "comments", "-comment\\b",
    "commentbox", "comment-button", "commentcomp", "comment-content", "comment-count",
    "comment-form", "comment-number", "comment-respond", "comment-thread", "comment-wrap",
    "complementary", "consent", "contact-", "contactus", "cookie.law", "content-card",
    "copycontent", "copy-tooltip", "content-topics", "contentpromo", "context-bar",
    "context-widget", "core-collateral", "cover-image", "cover-photo", "cover-wrap",
    "created-date", "creative-commons_", "c-subscribe", "_cta", "-cta", "cta-", "cta_",
    "current-issue", "custom-list-number", "dateline", "dateheader", "date-header",
    "date-pub", "disclaimer", "disclosure", "discussion", "discuss_", "-dismiss", "disqus",
    "donate", "donation", "dropdown", "editorial_contact", "editorial-contact",
    "element-invisible", "elementor-shortcode", "eletters", "emailsignup", "emoji-bar",
    "engagement-widget", "enhancement-", "entry-author-info", "entry-categories",
    "entry-date", "entry-title", "entry-utility", "-error", "error-", "eyebrow",
    "expand-reduce", "external-anchor", "externallinkembedwrapper", "extra-services",
    "extra-title", "facebook", "fancy-box", "favorite", "featured-content", "feature_feed",
    "feedback", "feed-links", "field-site-sections", "filed", "fixheader", "floating-vid",
    "follower", "footer", "footnote-back", "footnoteback", "form-group", "for-you",
    "frontmatter", "further-reading", "fullbleedheader", "gallery-count", "gated-popup",
    "gh-feed", "gist-meta", "goog-", "graph-view", "hamburger", "hawk-", "header-pattern",
    "hero[_\\-a-z]", "hide-for-print", "hide-print", "hide-when-no-script", "hidden-print",
    "hidden-sidenote", "hidden-accessibility", "home-link", "icon-sidebar", "inarticle-ad",
    "infoline", "inline-topic", "instacartIntegration", "interlude", "interaction",
    "itemendrow", "intro-date", "invisible", "jp-no-solution", "jp-relatedposts",
    "jswarning", "js-warning", "jumplink", "jumpto", "jump-to-", "js-skip-to-content",
    "keepreading", "keep-reading", "keep_reading", "keyword_wrap", "kicker", "labstab",
    "-labels", "language-name", "lastupdated", "latest-content", "-ledes-", "-license",
    "license-", "lightbox-popup", "like-button", "link-box", "links-grid", "links-title",
    "listing-dynamic-terms", "list-tags", "live-blog-header-live-label", "listinks",
    "loading", "loa-info", "(?:(?<![\\w-])logo|logo(?![\\w-]))", "ltx_role_refnum",
    "ltx_tag_bibitem", "ltx_error", "masthead", "marketing", "media-card", "media-inquiry",
    "-menu", "menu-", "metadata", "meta-bottom", "meta-date", "meta-row", "might-like",
    "minibio", "more-about", "mod-paywall", "_modal", "-modal", "more-", "morenews",
    "morestories", "more_wrapper", "most-read", "move-helper", "mw-editsection",
    "mw-cite-backlink", "mw-indicators", "mw-jump-link", "nav-", "nav_", "navcontainer",
    "navigation-post", "next-", "next_prev", "no-script", "newsgallery", "news-story-title",
    "newsletter_", "newsletterbanner", "newslettercontainer", "newsletter-form",
    "newsletter-signup", "newslettersignup", "newsletterwidget", "newsletterwrapper",
    "not-found", "notessection", "nomobile", "noprint", "onward-journey", "open-slideshow",
    "originally-published", "osano-cm", "other-blogs", "outline-view", "pagefoot",
    "pagehead", "page-header", "page-title", "paywall_message", "-partners", "permission-",
    "plea", "popular", "popup_links", "pop_stories", "pop-up", "post__author", "post-author",
    "post-bottom", "post__category", "postcomment", "postdate", "post-date", "post_date",
    "post-details", "post-feeds", "postinfo", "post-info", "post_info", "post-inline-date",
    "post-links", "postlist", "post_list", "post_meta", "post-meta", "postmeta", "post_more",
    "postnavi", "post-navigation", "postpath", "post-preview", "postsnippet", "post_snippet",
    "post-snippet", "post-subject", "posttax", "post-tax", "post_tax", "posttag", "post-tag",
    "post_time", "posttitle", "post-title", "post_title", "post__title", "post-ufi-button",
    "prev-post", "prevnext", "prev_next", "prev-next", "previousnext", "press-inquiries",
    "print-none", "print-header", "print:hidden", "privacy-notice", "privacy-settings",
    "profile", "promo_article", "promo-bar", "promo-box", "pubdate", "pub_date", "pub-date",
    "publish_date", "publish-date", "publication-date", "publicationName", "qr-code",
    "qr_code", "quick_up", "_rail", "ratingscontainer", "ratingssection", "reactions",
    "read_also", "readmore", "read-next", "read_next", "read_time", "read-time",
    "reading_time", "reading-time", "reading-list", "recent-", "recent-articles",
    "recentpost", "recent_post", "recent-post", "recommend", "redirectedfrom", "recirc",
    "register", "(?<!h[1-6]-)related", "-relance", "relevant", "relposts", "reversefootnote",
    "rightcol", "\\bnocontent\\b", "_rss", "rss-link", "rubricwrapper", "screen-reader-text",
    "scroll_to", "scroll-to", "_search", "-search", "section-nav", "series-banner",
    "share-box", "sharedaddy", "share-icons", "sharelinks", "share-links", "share-post",
    "share-print", "share-section", "share-text", "sharing_", "shariff-", "shortcode-id",
    "show-for-print", "sidebartitle", "sidebar-content", "sidebar-element",
    "sidebar-wrapper", "sideitems", "sidebar-author", "sidebar-item", "side-box",
    "sign-in-gate", "similar-", "similar_", "similars-", "site-index", "site-header",
    "siteheader", "site-name", "site-wordpress", "skip-content", "skip-to-content",
    "skip-link", "c-skip-link", "_skip-link", "-slider", "slug-wrap", "social-author",
    "social-button", "social-shar", "social-date", "speechify-ignore", "speedbump", "sponsor",
    "springercitation", "sr-only", "_stats", "sticky-social", "story-date",
    "story-navigation", "storyreadtime", "storysmall", "storypublishdate", "subject-label",
    "submenu", "-subscribe-", "subscriber-drive", "subscription-", "_tags", "tags__item",
    "tag_list", "tag-list", "tag-module", "takeaways", "taxonomy", "table-of-contents",
    "tblc", "tabs-", "terminaltout", "time-rubric", "timestamp", "time-read", "time-to-read",
    "tip_off", "-ticker", "tiptout", "-tout-", "toc-container", "toggle-caption",
    "tooltip-content", "topbar", "subnavbar", "topic-authors", "topic-footer", "topic-list",
    "topic-subnav", "top-wrapper", "tree-item", "trending", "trust-feat", "trust-badge",
    "trust-project", "chakra-badge", "twiblock", "u-hide", "upsell", "vid_carousel",
    "viewbottom", "view-language", "yarpp-related", "visually-hidden", "welcomebox",
    "widget_pages", "window__widget", "w-form-done", "w-form-fail",
];

/// The seven patterns that need more than a substring test.
#[derive(Clone, Copy)]
enum Special {
    AccessWall,
    CommentWord,
    CookieLaw,
    Hero,
    Logo,
    Related,
    NoContent,
}

pub struct PartialMatcher {
    /// Lowercased literal patterns bucketed by first byte.
    buckets: Vec<Vec<&'static str>>,
    literals: std::collections::HashSet<String>,
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

impl PartialMatcher {
    fn new() -> PartialMatcher {
        let mut buckets: Vec<Vec<&'static str>> = vec![Vec::new(); 256];
        let mut literals = std::collections::HashSet::new();
        for p in PARTIAL_SELECTORS {
            if Self::special_of(p).is_some() {
                continue;
            }
            let lower: &'static str = Box::leak(p.to_ascii_lowercase().into_boxed_str());
            buckets[lower.as_bytes()[0] as usize].push(lower);
            literals.insert(lower.to_string());
        }
        PartialMatcher { buckets, literals }
    }

    fn special_of(p: &str) -> Option<Special> {
        Some(match p {
            "(?<!main-)access-wall" => Special::AccessWall,
            "-comment\\b" => Special::CommentWord,
            "cookie.law" => Special::CookieLaw,
            "hero[_\\-a-z]" => Special::Hero,
            "(?:(?<![\\w-])logo|logo(?![\\w-]))" => Special::Logo,
            "(?<!h[1-6]-)related" => Special::Related,
            "\\bnocontent\\b" => Special::NoContent,
            _ => return None,
        })
    }

    /// `PARTIAL_SELECTORS_REGEX.test(hay)` on an already-lowercased string.
    pub fn test(&self, hay: &str) -> bool {
        let b = hay.as_bytes();
        for i in 0..b.len() {
            for p in &self.buckets[b[i] as usize] {
                if b[i..].starts_with(p.as_bytes()) {
                    return true;
                }
            }
        }
        Self::specials_match(b)
    }

    fn specials_match(b: &[u8]) -> bool {
        let find_all = |needle: &[u8]| -> Vec<usize> {
            let mut v = Vec::new();
            if needle.len() <= b.len() {
                for i in 0..=b.len() - needle.len() {
                    if &b[i..i + needle.len()] == needle {
                        v.push(i);
                    }
                }
            }
            v
        };
        for i in find_all(b"access-wall") {
            if !(i >= 5 && &b[i - 5..i] == b"main-") {
                return true;
            }
        }
        for i in find_all(b"-comment") {
            let next = b.get(i + 8).copied();
            if !next.is_some_and(is_word_byte) {
                return true;
            }
        }
        for i in find_all(b"cookie") {
            if b.len() >= i + 10 && b[i + 6] != b'\n' && &b[i + 7..i + 10] == b"law" {
                return true;
            }
        }
        for i in find_all(b"hero") {
            if b.get(i + 4).is_some_and(|c| *c == b'_' || *c == b'-' || c.is_ascii_lowercase()) {
                return true;
            }
        }
        for i in find_all(b"logo") {
            let prev_ok = i == 0 || !(is_word_byte(b[i - 1]) || b[i - 1] == b'-');
            let next_ok = b.get(i + 4).is_none_or(|c| !(is_word_byte(*c) || *c == b'-'));
            if prev_ok || next_ok {
                return true;
            }
        }
        for i in find_all(b"related") {
            let blocked = i >= 3 && b[i - 3] == b'h' && (b'1'..=b'6').contains(&b[i - 2]) && b[i - 1] == b'-';
            if !blocked {
                return true;
            }
        }
        for i in find_all(b"nocontent") {
            let prev_ok = i == 0 || !is_word_byte(b[i - 1]);
            let next_ok = b.get(i + 9).is_none_or(|c| !is_word_byte(*c));
            if prev_ok && next_ok {
                return true;
            }
        }
        false
    }

    /// `PARTIAL_SELECTORS_ANCHORED_REGEX.test(hay)`: the whole string is one token.
    pub fn test_anchored(&self, hay: &str) -> bool {
        if self.literals.contains(hay) {
            return true;
        }
        let b = hay.as_bytes();
        match b {
            b"access-wall" | b"-comment" | b"logo" | b"related" | b"nocontent" => true,
            _ if b.len() == 10 && b.starts_with(b"cookie") && b.ends_with(b"law") && b[6] != b'\n' => true,
            _ if b.len() == 5 && b.starts_with(b"hero") && (b[4] == b'_' || b[4] == b'-' || b[4].is_ascii_lowercase()) => true,
            _ => false,
        }
    }
}

pub fn partial_matcher() -> &'static PartialMatcher {
    static M: std::sync::OnceLock<PartialMatcher> = std::sync::OnceLock::new();
    M.get_or_init(PartialMatcher::new)
}

pub const FOOTNOTE_INLINE_REFERENCES: &str = "sup.reference,cite.ltx_cite,sup[id^=\"fnr\"],span[id^=\"fnr\"],span[class*=\"footnote_ref\"],span[class*=\"footnote-ref\"],span.footnote-link,a.citation,a[id^=\"ref-link\"],a[href^=\"#fn\"],a[href^=\"#cite\"],a[href^=\"#reference\"],a[href^=\"#footnote\"],a[href^=\"#r\"],a[href^=\"#b\"],a[href*=\"cite_note\"],a[href*=\"cite_ref\"],a.footnote-anchor,span.footnote-hovercard-target a,a[role=\"doc-biblioref\"],a[id^=\"fnref\"],a[id^=\"ref-link\"],sup.footnoteref,sup.footnote-reference,sup[data-fn] > a[href^=\"#\"],sup[id^=\"ftnt_ref\"] a[href^=\"#ftnt\"],span.easy-footnote > a[href^=\"#easy-footnote-bottom-\"],a.footnote[href^=\"#\"],a[data-type=\"noteref\"]";

pub const FOOTNOTE_LIST_SELECTORS: &str = "div.footnote ol,div.footnotes ol,div[role=\"doc-endnotes\"],div[role=\"doc-footnotes\"],ol.footnotes-list,ol.footnotes,ol.references,ol[class*=\"article-references\"],section.footnotes ol,section[role=\"doc-endnotes\"],section[role=\"doc-footnotes\"],section[role=\"doc-bibliography\"],ul.footnotes-list,ul.ltx_biblist,div.footnote[data-component-name=\"FootnoteToDOM\"],div.footnotes-footer,div.footnote-definitions,div.footnote-definition,ol.wp-block-footnotes,ol.easy-footnotes-wrapper,div.footnotes-segment,#footnotes";

pub fn is_allowed_empty(tag: &str) -> bool {
    matches!(
        tag,
        "area" | "audio" | "base" | "br" | "circle" | "col" | "defs" | "ellipse" | "embed"
            | "figure" | "g" | "hr" | "iframe" | "img" | "input" | "line" | "link" | "mask"
            | "meta" | "object" | "param" | "path" | "pattern" | "picture" | "polygon"
            | "polyline" | "rect" | "source" | "stop" | "svg" | "td" | "th" | "track" | "use"
            | "video" | "wbr"
    )
}

pub fn is_allowed_attribute(name: &str) -> bool {
    matches!(
        name,
        "alt" | "allow" | "allowfullscreen" | "aria-label" | "checked" | "colspan" | "controls"
            | "data-latex" | "data-src" | "data-srcset" | "data-callout" | "data-callout-fold"
            | "data-callout-title" | "data-lang" | "dir" | "display" | "frameborder" | "headers"
            | "height" | "href" | "kind" | "label" | "lang" | "role" | "rowspan" | "sandbox"
            | "src" | "srclang" | "srcset" | "start" | "title" | "type" | "width" | "accent"
            | "accentunder" | "align" | "columnalign" | "columnlines" | "columnspacing"
            | "columnspan" | "data-mjx-texclass" | "depth" | "displaystyle" | "fence" | "frame"
            | "framespacing" | "linethickness" | "lspace" | "mathsize" | "mathvariant"
            | "maxsize" | "minsize" | "movablelimits" | "notation" | "rowalign" | "rowlines"
            | "rowspacing" | "rspace" | "scriptlevel" | "separator" | "stretchy" | "symmetric"
            | "voffset" | "xmlns"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_patterns_honour_lookarounds() {
        let m = partial_matcher();
        assert!(m.test("site-footer"));
        assert!(m.test("adblock_x"));
        assert!(!m.test("main-access-wall"));
        assert!(m.test("access-wall"));
        assert!(m.test("post-comment x"));
        assert!(!m.test("rt-commentedtext"));
        assert!(m.test("cookie-law"));
        assert!(m.test("hero-image"));
        assert!(!m.test("heroic"[..4].to_string().as_str()));
        assert!(m.test("site-logo"));
        assert!(!m.test("mylogos"));
        assert!(!m.test("h2-related"));
        assert!(m.test("related-posts"));
        assert!(m.test("x nocontent"));
        assert!(!m.test("mw-content-text"));
        assert!(m.test_anchored("comments"));
        assert!(!m.test_anchored("theroleofthings"));
        assert!(m.test("theroleofthings"));
    }
}
