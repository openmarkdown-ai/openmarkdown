//! Generated from Defuddle 0.19.3 createMarkdownContent (Turndown 7.2.4 + domino)
//! by oracle/gen-markdown.mjs from oracle/markdown-cases.json. Each case must
//! convert byte-identically.

use super::super::*;

fn oracle(html: &str, expected: &str) {
    assert_eq!(clean_html_to_markdown(html), expected, "html: {html}");
}

#[test]
fn md_para_emphasis() {
    oracle("<p>Some <em>em</em>, <strong>strong</strong>, <i>i</i> and <b>b</b> text.</p><p>Second   paragraph\nwith newline.</p>", "Some *em*, **strong**, *i* and **b** text.\n\nSecond paragraph with newline.");
}

#[test]
fn md_escapes() {
    oracle("<p>2 * 3 = 6 and snake_case and [brackets] and `ticks` and back\\slash</p><p>- not a list</p><p># not heading</p><p>1. not ordered</p><p>&gt; not quote</p><p>+ plus</p><p>=== eq</p>", "2 \\* 3 = 6 and snake\\_case and \\[brackets\\] and \\`ticks\\` and back\\\\slash\n\n\\- not a list\n\n\\# not heading\n\n1\\. not ordered\n\n\\> not quote\n\n\\+ plus\n\n\\=== eq");
}

#[test]
fn md_tag_like_lt() {
    oracle("<p>Monte&lt;video&gt; and a &lt; b and &lt;/div&gt; and &lt;a@b.com&gt;</p>", "Monte\\<video> and a < b and \\</div> and <a@b.com>");
}

#[test]
fn md_headings() {
    oracle("<h1>Title</h1><h2>Two</h2><h3>Three <a href='/x'>link</a></h3><h6>Six</h6>", "## Two\n\n### Three [link](/x)\n\n###### Six");
}

#[test]
fn md_leading_h1_strip() {
    oracle("<h1>Title</h1><p>Body</p>", "Body");
}

#[test]
fn md_links() {
    oracle("<p><a href='https://e.com/a'>plain</a> <a href='https://e.com/a b'>space</a> <a href='https://e.com/(x)' title='T \"q\"'>paren</a> <a>nohref</a> <a href='https://e.com/'></a></p>", "[plain](https://e.com/a) [space](<https://e.com/a b>) [paren](https://e.com/\\(x\\) \"T \\\"q\\\"\") nohref");
}

#[test]
fn md_images() {
    oracle("<p><img src='https://e.com/a.png' alt='Alt *x*' title='Tip'> <img srcset='https://e.com/s.png 400w, https://e.com/l.png 1200w, https://e.com/m.png 800w' src='https://e.com/f.png'> <img src=''></p>", "![Alt *x*](https://e.com/a.png \"Tip\") ![](https://e.com/l.png)");
}

#[test]
fn md_srcset_commas() {
    oracle("<img srcset='https://substack.com/w_424,c_limit/a.png 424w, https://substack.com/w_848,c_limit/a.png 848w' src='x.png'>", "![](https://substack.com/w_848,c_limit/a.png)");
}

#[test]
fn md_bang_image() {
    oracle("<p>Yey!<img src='https://e.com/i.png' alt='IMG'></p>", "Yey! ![IMG](https://e.com/i.png)");
}

#[test]
// Departure from Defuddle: Defuddle indents the second nested sibling one tab too deep (nested_list_siblings_share_one_indent)
fn md_lists() {
    oracle("<ul><li>one</li><li>two<ul><li>two-a</li><li>two-b<ol><li>deep</li></ol></li></ul></li><li>three</li></ul>", "- one\n- two\n\t- two-a\n\t- two-b\n\t\t1. deep\n- three");
}

#[test]
fn md_ordered_start() {
    oracle("<ol start='5'><li>five</li><li>six</li></ol>", "5. five\n6. six");
}

#[test]
fn md_list_paragraphs() {
    oracle("<ul><li><p>para one</p><p>para two</p></li><li>next</li></ul>", "- para one\n\tpara two\n- next");
}

#[test]
fn md_task_list() {
    oracle("<ul class='contains-task-list'><li class='task-list-item'><input type='checkbox' disabled> todo</li><li class='task-list-item'><input type='checkbox' checked='checked' disabled> done</li></ul>", "- [ ] todo\n- [x] done");
}

#[test]
fn md_blockquote() {
    oracle("<blockquote><p>q1</p><p>q2 <em>em</em></p><blockquote><p>nested</p></blockquote></blockquote>", "> q1\n> \n> q2 *em*\n> \n> > nested");
}

#[test]
fn md_code_inline() {
    oracle("<p>Use <code>a_b*c</code> and <code>`tick`</code> and <code> spaced </code></p>", "Use `a_b*c` and `` `tick` `` and `  spaced  `");
}

#[test]
fn md_code_block() {
    oracle("<pre><code class='language-rust'>fn main() {\n    println!(\"hi `x`\");\n}\n</code></pre><pre><code data-lang='py'>x = 1</code></pre><pre><code>plain</code></pre>", "```rust\nfn main() {\n    println!(\"hi \\`x\\`\");\n}\n```\n```py\nx = 1\n```\n```\nplain\n```");
}

#[test]
fn md_pre_no_code() {
    oracle("<pre>line one\n  line *two*</pre>", "line one\n  line \\*two\\*");
}

#[test]
fn md_hr_br() {
    oracle("<p>a<br>b<br/>c</p><hr><p>d</p>", "a  \nb  \nc\n\n---\n\nd");
}

#[test]
fn md_mark_del() {
    oracle("<p><mark>hi</mark> <del>gone</del> <s>s</s> <strike>st</strike></p>", "==hi== ~~gone~~ ~~s~~ ~~st~~");
}

#[test]
fn md_sup_sub() {
    oracle("<p>E=mc<sup>2</sup> H<sub>2</sub>O</p>", "E=mc<sup>2</sup> H<sub>2</sub>O");
}

#[test]
fn md_table_simple() {
    oracle("<table><thead><tr><th>Name</th><th>Val|ue</th></tr></thead><tbody><tr><td>A</td><td><b>1</b><br>x</td></tr><tr><td>B</td></tr></tbody></table>", "| Name | Val\\|ue |\n| --- | --- |\n| A | **1**   x |\n| B |  |");
}

#[test]
fn md_table_complex() {
    oracle("<table class='wikitable' style='x'><tr><th colspan='2'>Head &amp; more</th></tr><tr><td>a</td><td data-x='1'>b</td></tr></table>", "<table style=\"x\"><tbody><tr><th colspan=\"2\">Head & more</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>");
}

#[test]
fn md_table_layout() {
    oracle("<table><tr><td><p>Only cell</p></td></tr></table><table><tr><td>A</td></tr><tr><td>B</td></tr></table>", "Only cell\n\n| A |\n| --- |\n| B |");
}

#[test]
fn md_table_nested() {
    oracle("<table><tr><td>left</td><td><table><tr><th>x</th><th>y</th></tr><tr><td>1</td><td>2</td></tr></table></td></tr></table>", "left\n\n| x | y |\n| --- | --- |\n| 1 | 2 |");
}

#[test]
fn md_iframe_youtube() {
    oracle("<p>Watch:</p><iframe src='https://www.youtube.com/embed/dQw4w9WgXcQ'></iframe><iframe src='https://player.vimeo.com/video/1'></iframe>", "Watch:\n\n![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n<iframe src=\"https://player.vimeo.com/video/1\"></iframe>");
}

#[test]
fn md_tweet_embed() {
    oracle("<iframe src='https://platform.twitter.com/embed/Tweet.html?dnt=false&id=123456'></iframe>", "![](https://x.com/i/status/123456)");
}

#[test]
fn md_figure() {
    oracle("<figure><img src='https://e.com/f.png' alt='F'><figcaption>Caption <em>here</em></figcaption></figure>", "![F](https://e.com/f.png)\n\nCaption *here*");
}

#[test]
fn md_figure_with_p() {
    oracle("<figure><p>Text para</p><img src='https://e.com/f.png'></figure>", "Text para\n\n![](https://e.com/f.png)");
}

#[test]
fn md_footnotes() {
    oracle("<p>Claim<sup id='fnref:1'><a href='#fn:1'>1</a></sup> and again<sup id='fnref:1-2'><a href='#fn:1'>1</a></sup>.</p><div id='footnotes'><ol><li class='footnote' id='fn:1'><p>Note text.&nbsp;<a href='#fnref:1' class='footnote-backref'>↩</a></p></li><li id='fn:b'><p>Second</p></li></ol></div>", "Claim[^1] and again[^1].\n\n[^1]: Note text.\n\n[^b]: Second");
}

#[test]
fn md_math_inline_block() {
    oracle("<p>Inline <math display='inline' data-latex='a \\neq 0'><mi>a</mi></math> here</p><p><math display='block' data-latex='x^2 + y^2 = z^2'></math></p><math display='block' data-latex='a &amp; b \\\\ c'></math>", "Inline $a \\neq 0$ here");
}

#[test]
fn md_math_annotation() {
    oracle("<p>x<math><semantics><mrow><mi>x</mi></mrow><annotation encoding='application/x-tex'>\\alpha</annotation></semantics></math>y</p>", "x$\\alpha$y");
}

#[test]
fn md_katex() {
    oracle("<p>K <span class='katex'><span class='katex-mathml'><math><semantics><annotation encoding='application/x-tex'>E=mc^2</annotation></semantics></math></span><span class='katex-html'>E=mc2</span></span></p><div class='math math-display'>\\int x</div>", "K $E=mc^2$\n\n$$\n\\int x\n$$");
}

#[test]
fn md_callout() {
    oracle("<div data-callout='warning' class='callout'><div class='callout-title'><div class='callout-title-inner'>Careful</div></div><div class='callout-content'><p>Line one</p><p>Line two</p></div></div><div data-callout='tip' data-callout-fold='-' class='callout'><div class='callout-content'><p>Tip body</p></div></div>", "> [!warning] Careful\n> Line one\n> \n> Line two\n\n> [!tip]- Tip\n> Tip body");
}

#[test]
fn md_complex_link() {
    oracle("<a href='https://e.com/post'><h2>Card title</h2><p>Card summary</p></a>", "## Card title\n\nCard summary\n\n[View original](https://e.com/post)");
}

#[test]
fn md_whitespace_inline() {
    oracle("<p>a <b> bold </b> b<i>x</i> <span> span </span>c</p><div>  lots   of    space  </div>", "a **bold** b*x* span c\n\nlots of space");
}

#[test]
fn md_nbsp_flank() {
    oracle("<p>a&nbsp;<b>&nbsp;b&nbsp;</b>&nbsp;c</p>", "a  **b**  c");
}

#[test]
fn md_empty_elements() {
    oracle("<p></p><div> </div><p>kept</p><span></span><a href='https://e.com/x'></a>", "kept");
}

#[test]
fn md_definition_list() {
    oracle("<dl><dt>Term</dt><dd>Definition <em>one</em></dd><dt>T2</dt><dd>D2</dd></dl>", "Term\n\nDefinition *one*\n\nT2\n\nD2");
}

#[test]
fn md_button_script_style() {
    oracle("<p><button>Click</button><script>var x=1;</script><style>.a{}</style>after</p>", "Clickafter");
}

#[test]
fn md_svg_video() {
    oracle("<p><svg><path d='M0'/></svg> <video src='https://e.com/v.mp4' controls></video></p><audio src='a.mp3'></audio>", "<video src=\"https://e.com/v.mp4\" controls=\"\"></video>\n\n<audio src=\"a.mp3\"></audio>");
}

#[test]
fn md_blank_quote_runs() {
    oracle("<blockquote><p>a</p><p><br></p><p><br></p><p>b</p></blockquote>", "> a\n> \n> b");
}

#[test]
fn md_many_newlines() {
    oracle("<p>a</p><div><div><p>b</p></div></div><br><br><br><p>c</p>", "a\n\nb\n\n  \n  \n  \n\nc");
}

#[test]
fn md_nested_inline_code_in_link() {
    oracle("<p><a href='https://e.com'><code>code_link</code></a></p>", "[`code_link`](https://e.com)");
}

#[test]
fn md_heading_with_formatting() {
    oracle("<h2><em>Em</em> and <code>code</code></h2>", "## *Em* and `code`");
}

#[test]
fn md_list_with_code_block() {
    oracle("<ol><li>Step<pre><code class='language-sh'>ls -la</code></pre></li><li>Next</li></ol>", "1. Step\n\t```sh\n\tls -la\n\t```\n2. Next");
}

#[test]
fn md_arxiv_enumerate() {
    oracle("<ol class='ltx_enumerate'><li><span class='ltx_tag ltx_tag_item'>1.</span><p>First</p></li><li><span class='ltx_tag ltx_tag_item'>2.</span><p>Second</p></li></ol>", "1. First\n\n2. Second");
}

#[test]
fn md_wiki_cite_note() {
    oracle("<div id='footnotes'><ol><li id='cite_note-Smith-3'><sup>Smith-3</sup> Smith 2020</li></ol></div>", "[^smith-3]: Smith 2020");
}

#[test]
fn md_entities() {
    oracle("<p>&copy; 2024 &mdash; caf&eacute; &amp; &quot;quotes&quot; &#x1F600;</p>", "© 2024 — café & \"quotes\" 😀");
}
