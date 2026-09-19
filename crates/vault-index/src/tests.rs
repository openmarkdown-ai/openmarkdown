//! Behavioural tests over small vaults built from strings.

use crate::testkit;
use crate::*;

fn vault(files: &[(&str, &str)]) -> VaultIndex {
    let mut v = VaultIndex::new();
    for (i, (path, text)) in files.iter().enumerate() {
        v.upsert_file(FileEntry {
            path: path.to_string(),
            size: text.len() as u64,
            ctime: i as f64,
            mtime: (100 - i) as f64,
        });
        if path.ends_with(".md") {
            v.set_note(path, text.to_string(), testkit::parse(text));
        }
    }
    v
}

fn paths(out: &SearchOutput) -> Vec<&str> {
    out.results.iter().map(|r| r.path.as_str()).collect()
}

fn search(v: &VaultIndex, q: &str) -> Vec<String> {
    let out = v.search(q, &SearchOptions::default());
    assert!(out.error.is_none(), "{q}: {:?}", out.error);
    paths(&out).into_iter().map(str::to_string).collect()
}

// ---------------------------------------------------------------- testkit

mod metadata_helper {
    use super::*;

    #[test]
    fn parses_links_tags_headings_tasks_with_utf16_positions() {
        let text = "---\ntags: [a, b]\nrel: \"[[Other]]\"\n---\n# 😀 Title\nSee [[Note#H|alias]] and ![[img.png]] #tag\n- [ ] todo [x](Doc%20A.md)\n- [x] done\n";
        let m = testkit::parse(text);
        let links = m.links.unwrap();
        assert_eq!(links[0].link, "Note#H");
        assert_eq!(links[0].display_text.as_deref(), Some("alias"));
        assert_eq!(links[1].link, "Doc A.md");
        let start = text.find("[[Note").unwrap();
        // One emoji (2 UTF-16 units, 4 bytes) precedes the link.
        assert_eq!(links[0].position.start.offset as usize, start - 2);
        assert_eq!(m.embeds.unwrap()[0].link, "img.png");
        assert_eq!(m.tags.unwrap()[0].tag, "#tag");
        assert_eq!(m.headings.unwrap()[0].heading, "😀 Title");
        let items = m.list_items.unwrap();
        assert_eq!(items[0].task.as_deref(), Some(" "));
        assert_eq!(items[1].task.as_deref(), Some("x"));
        assert_eq!(m.frontmatter_links.unwrap()[0].link, "Other");
    }
}

// ---------------------------------------------------------------- links

mod links {
    use super::*;

    fn sample() -> VaultIndex {
        vault(&[
            ("Home.md", "---\nrelated: \"[[Projects/Alpha]]\"\n---\n[[Alpha]] [[alpha#Goals]] ![[diagram.png]] [[Missing]] [[missing.md]] [[#Local]]\n"),
            ("Projects/Alpha.md", "Back to [[Home]]. Also [Beta](Beta.md) and [[Nowhere|x]]"),
            ("Projects/Beta.md", "no links here"),
            ("assets/diagram.png", ""),
        ])
    }

    #[test]
    fn resolved_links_shape_counts_embeds_frontmatter_and_self() {
        let v = sample();
        let r = v.resolved_links();
        let home = &r["Home.md"];
        assert_eq!(home["Projects/Alpha.md"], 3);
        assert_eq!(home["assets/diagram.png"], 1);
        assert_eq!(home["Home.md"], 1, "[[#Local]] resolves to the source");
        assert_eq!(r["Projects/Alpha.md"]["Home.md"], 1);
        assert_eq!(r["Projects/Alpha.md"]["Projects/Beta.md"], 1);
        assert!(r["Projects/Beta.md"].is_empty(), "every note has an entry");
        assert!(
            !r.contains_key("assets/diagram.png"),
            "attachments have no entry"
        );
    }

    #[test]
    fn unresolved_keys_drop_subpath_and_md() {
        let v = sample();
        let u = v.unresolved_links();
        assert_eq!(u["Home.md"]["Missing"], 1);
        assert_eq!(u["Home.md"]["missing"], 1);
        assert_eq!(u["Projects/Alpha.md"]["Nowhere"], 1);
    }

    #[test]
    fn cache_updates_on_set_note_and_file_changes() {
        let mut v = sample();
        assert_eq!(v.unresolved_links()["Home.md"].get("Missing"), Some(&1));
        v.upsert_file(FileEntry {
            path: "Missing.md".into(),
            ..Default::default()
        });
        assert_eq!(
            v.resolved_links()["Home.md"]["Missing.md"],
            2,
            "both spellings resolve now"
        );
        v.set_note(
            "Projects/Beta.md",
            "[[Home]]".into(),
            testkit::parse("[[Home]]"),
        );
        assert_eq!(v.resolved_links()["Projects/Beta.md"]["Home.md"], 1);
        v.remove_file("Missing.md");
        assert!(!v.resolved_links()["Home.md"].contains_key("Missing.md"));
    }

    #[test]
    fn resolve_link_strips_subpath() {
        let v = sample();
        assert_eq!(
            v.resolve_link("Alpha#Goals", "Home.md").as_deref(),
            Some("Projects/Alpha.md")
        );
        assert_eq!(
            v.resolve_link("#Goals", "Home.md").as_deref(),
            Some("Home.md")
        );
        assert_eq!(
            v.resolve_link("diagram.png", "Home.md").as_deref(),
            Some("assets/diagram.png")
        );
        assert_eq!(v.resolve_link("diagram", "Home.md"), None);
        assert_eq!(
            v.linkpath_dest("Alpha#Goals", "Home.md"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn backlinks_with_positions_and_context() {
        let v = sample();
        let b = v.backlinks("Projects/Alpha.md");
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].source, "Home.md");
        let kinds: Vec<RefKind> = b[0].refs.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            vec![RefKind::Frontmatter, RefKind::Link, RefKind::Link]
        );
        assert_eq!(b[0].refs[0].key.as_deref(), Some("related"));
        let second = &b[0].refs[2];
        assert_eq!(second.link, "alpha#Goals");
        let ctx = second.context.as_ref().unwrap();
        assert!(ctx.text.starts_with("[[Alpha]] [[alpha#Goals]]"));
        assert_eq!(
            &ctx.text[ctx.start as usize..ctx.end as usize],
            "[[alpha#Goals]]"
        );
        // Self links do not count as backlinks.
        assert!(v.backlinks("Home.md").iter().all(|b| b.source != "Home.md"));
    }

    #[test]
    fn backlink_positions_are_utf16_after_emoji() {
        let v = vault(&[("T.md", ""), ("S.md", "😀😀 x [[T]]")]);
        let b = v.backlinks("T.md");
        let r = &b[0].refs[0];
        assert_eq!(r.position.unwrap().start.offset, 7);
        assert_eq!(r.position.unwrap().start.col, 7);
        let ctx = r.context.as_ref().unwrap();
        assert_eq!((ctx.start, ctx.end), (7, 12));
    }

    #[test]
    fn backlinks_sorted_by_file_name() {
        let v = vault(&[
            ("T.md", ""),
            ("z/b.md", "[[T]]"),
            ("a.md", "[[T]]"),
            ("c/B 10.md", "[[T]]"),
            ("B 9.md", "[[T]]"),
        ]);
        let order: Vec<String> = v.backlinks("T.md").into_iter().map(|b| b.source).collect();
        assert_eq!(order, vec!["a.md", "z/b.md", "B 9.md", "c/B 10.md"]);
    }

    #[test]
    fn duplicate_basenames_resolve_per_source_folder() {
        let v = vault(&[
            ("a/Dup.md", ""),
            ("b/Dup.md", ""),
            ("a/src.md", "[[Dup]]"),
            ("b/src.md", "[[Dup]]"),
            ("c/src.md", "[[Dup]] [[b/Dup]]"),
        ]);
        let r = v.resolved_links();
        assert!(r["a/src.md"].contains_key("a/Dup.md"));
        assert!(r["b/src.md"].contains_key("b/Dup.md"));
        assert_eq!(
            r["c/src.md"]["a/Dup.md"], 1,
            "equal length: first added wins"
        );
        assert_eq!(r["c/src.md"]["b/Dup.md"], 1);
    }

    #[test]
    fn relative_markdown_links() {
        let v = vault(&[
            ("x/y/Target.md", ""),
            (
                "x/Other.md",
                "[t](y/Target.md) [u](./y/Target.md) [w](../x/y/Target.md)",
            ),
        ]);
        assert_eq!(v.resolved_links()["x/Other.md"]["x/y/Target.md"], 3);
    }
}

// ---------------------------------------------------------------- mentions

mod mentions {
    use super::*;

    #[test]
    fn unlinked_mentions_whole_word_case_insensitive_with_aliases() {
        let v = vault(&[
            ("Rust Lang.md", "---\naliases: [Ferris, rustlang]\n---\n"),
            (
                "a.md",
                "I like rust lang. RUST LANG! [[Rust Lang]] rust language ferris",
            ),
            ("b.md", "---\ntitle: Rust Lang\n---\nnothing"),
            ("c.md", "trustlang rustlang"),
        ]);
        let m = v.unlinked_mentions("Rust Lang.md");
        let sources: Vec<&str> = m.iter().map(|x| x.source.as_str()).collect();
        assert_eq!(sources, vec!["a.md", "c.md"]);
        let a = &m[0];
        let found: Vec<String> = a.matches.iter().map(|x| a.matches_text(x)).collect();
        assert_eq!(found, vec!["rust lang", "RUST LANG", "ferris"]);
        assert_eq!(m[1].matches.len(), 1);
        assert_eq!(m[1].matches[0].start, 10);
    }

    trait MatchText {
        fn matches_text(&self, m: &ContentMatch) -> String;
    }
    impl MatchText for Mention {
        fn matches_text(&self, m: &ContentMatch) -> String {
            m.context
                .text
                .encode_utf16()
                .skip(m.context.start as usize)
                .take((m.context.end - m.context.start) as usize)
                .map(|u| char::from_u32(u as u32).unwrap())
                .collect()
        }
    }

    #[test]
    fn mention_offsets_after_emoji() {
        let v = vault(&[("Cat.md", ""), ("n.md", "line one\n🐈 cat here")]);
        let m = v.unlinked_mentions("Cat.md");
        let x = &m[0].matches[0];
        assert_eq!((x.line, x.col, x.start, x.end), (1, 3, 12, 15));
    }

    #[test]
    fn long_lines_are_windowed() {
        let long = format!("{} needle {}", "a".repeat(500), "b".repeat(500));
        let v = vault(&[("needle.md", ""), ("n.md", &long)]);
        let m = &v.unlinked_mentions("needle.md")[0].matches[0];
        assert!(m.context.text.len() <= 2 * 80 + 6);
        assert_eq!(m.context.offset + m.context.start, m.start);
        assert_eq!(
            &m.context.text[m.context.start as usize..m.context.end as usize],
            "needle"
        );
    }
}

// ---------------------------------------------------------------- tags

mod tag_counts {
    use super::*;

    #[test]
    fn get_tags_over_the_vault() {
        let v = vault(&[
            ("a.md", "---\ntags: [project/alpha, Work]\n---\n#work #todo"),
            ("b.md", "#project/beta #Todo `#notatag` #123"),
            ("c.md", "---\ntags: solo\n---\n```\n#incode\n```"),
        ]);
        let t = v.tags();
        assert_eq!(t.get("#project"), Some(&2));
        assert_eq!(t.get("#project/alpha"), Some(&1));
        assert_eq!(t.get("#project/beta"), Some(&1));
        assert_eq!(t.get("#Work").or(t.get("#work")), Some(&2));
        assert_eq!(t.get("#todo").or(t.get("#Todo")), Some(&2));
        assert_eq!(t.get("#solo"), Some(&1));
        assert!(
            !t.contains_key("#notatag") && !t.contains_key("#incode") && !t.contains_key("#123")
        );
    }
}

// ---------------------------------------------------------------- linktext

mod linktext {
    use super::*;

    #[test]
    fn three_formats_and_markdown_links() {
        let v = vault(&[
            ("notes/deep/Target.md", ""),
            ("notes/Other.md", ""),
            ("x/Target.md", ""),
            ("img/Pic 1.png", ""),
        ]);
        assert_eq!(
            v.linktext(
                "notes/deep/Target.md",
                "notes/Other.md",
                LinkFormat::Shortest
            ),
            "notes/deep/Target"
        );
        assert_eq!(
            v.linktext("notes/Other.md", "x/Target.md", LinkFormat::Shortest),
            "Other"
        );
        assert_eq!(
            v.linktext(
                "notes/deep/Target.md",
                "notes/Other.md",
                LinkFormat::Relative
            ),
            "deep/Target"
        );
        assert_eq!(
            v.linktext("notes/deep/Target.md", "x/Target.md", LinkFormat::Relative),
            "../notes/deep/Target"
        );
        assert_eq!(
            v.linktext("notes/deep/Target.md", "x/Target.md", LinkFormat::Absolute),
            "notes/deep/Target"
        );
        assert_eq!(
            v.generate_markdown_link(
                "img/Pic 1.png",
                "notes/Other.md",
                None,
                None,
                LinkFormat::Shortest,
                true
            ),
            "[](Pic%201.png)"
        );
        assert_eq!(
            v.generate_markdown_link(
                "notes/Other.md",
                "x/Target.md",
                Some("#Sec"),
                None,
                LinkFormat::Shortest,
                true
            ),
            "[Other](Other.md#Sec)"
        );
        assert_eq!(
            v.generate_markdown_link(
                "notes/Other.md",
                "x/Target.md",
                None,
                Some("other"),
                LinkFormat::Shortest,
                false
            ),
            "[[other]]"
        );
        assert_eq!(
            v.generate_markdown_link(
                "notes/Other.md",
                "x/Target.md",
                None,
                Some("Alias"),
                LinkFormat::Shortest,
                false
            ),
            "[[Other|Alias]]"
        );
        assert_eq!(
            v.generate_markdown_link(
                "x/Target.md",
                "x/Target.md",
                Some("#H"),
                None,
                LinkFormat::Shortest,
                false
            ),
            "[[#H]]"
        );
    }
}

// ---------------------------------------------------------------- rename

mod rename_links {
    use super::*;

    fn run(
        v: &VaultIndex,
        old: &str,
        new: &str,
        fmt: LinkFormat,
    ) -> std::collections::BTreeMap<String, String> {
        let edits = v.rename_edits(old, new, &RenameOptions { link_format: fmt });
        edits
            .into_iter()
            .map(|fe| {
                let text = &v.note(&fe.original_path).unwrap().text;
                (fe.path.clone(), apply_edits(text, &fe.edits))
            })
            .collect()
    }

    #[test]
    fn wikilinks_keep_alias_subpath_and_embed() {
        let v = vault(&[
            ("Old.md", "self [[#H]]"),
            (
                "a.md",
                "[[Old]] [[Old#Heading|Alias]] ![[Old#^block]] [[old]] [[Other]]",
            ),
            ("Other.md", ""),
        ]);
        let out = run(&v, "Old.md", "New.md", LinkFormat::Shortest);
        assert_eq!(
            out["a.md"],
            "[[New]] [[New#Heading|Alias]] ![[New#^block]] [[New]] [[Other]]"
        );
        assert!(
            !out.contains_key("New.md"),
            "subpath-only self links need no edit"
        );
    }

    #[test]
    fn move_to_folder_with_collision_uses_path() {
        let v = vault(&[
            ("Note.md", ""),
            ("archive/Note2.md", ""),
            ("other/Note.md", ""),
            ("a.md", "[[Note]]"),
            ("other/b.md", "[[Note]]"),
        ]);
        // Root Note.md wins bare [[Note]] from anywhere (exact path). Moving it
        // away makes [[Note]] ambiguous, so a.md gets the full new path.
        let out = run(&v, "Note.md", "archive/Note.md", LinkFormat::Shortest);
        assert_eq!(out["a.md"], "[[archive/Note]]");
        assert_eq!(out["other/b.md"], "[[archive/Note]]");
    }

    #[test]
    fn links_to_a_third_file_made_ambiguous_are_rewritten() {
        let v = vault(&[
            ("x/Topic.md", ""),
            ("y/Draft.md", ""),
            ("a.md", "[[Topic]]"),
        ]);
        // Renaming Draft to Topic makes [[Topic]] from a.md ambiguous; its
        // candidate list changes, so it is pinned to x/Topic.
        let out = run(&v, "y/Draft.md", "y/Topic.md", LinkFormat::Shortest);
        assert_eq!(out["a.md"], "[[x/Topic]]");
    }

    #[test]
    fn markdown_links_keep_md_encoding_text_and_title() {
        let v = vault(&[
            ("Old Name.md", ""),
            (
                "a.md",
                "[Old Name](Old%20Name.md) [label](<Old Name.md#Sec> \"title\") ![](Old%20Name.md)",
            ),
        ]);
        let out = run(&v, "Old Name.md", "dir/New Name.md", LinkFormat::Shortest);
        assert_eq!(
            out["a.md"],
            "[New Name](New%20Name.md) [label](<New Name.md#Sec> \"title\") ![](New%20Name.md)"
        );
    }

    #[test]
    fn path_alias_follows_rename() {
        let v = vault(&[
            ("f/Old.md", ""),
            ("g/Old.md", ""),
            ("a.md", "[[f/Old|Old]] [[f/Old|Custom]] | [[f/Old\\|Old]] |"),
        ]);
        let out = run(&v, "f/Old.md", "f/Fresh.md", LinkFormat::Shortest);
        // In `[[f/Old\\|Old]]` the link part is `f/Old\\`, whose basename is
        // not `Old`, so the app leaves that alias alone.
        assert_eq!(
            out["a.md"],
            "[[Fresh|Fresh]] [[Fresh|Custom]] | [[Fresh\\|Old]] |"
        );
    }

    #[test]
    fn formats_relative_and_absolute() {
        let v = vault(&[("p/q/T.md", ""), ("p/r/S.md", "[[T]]")]);
        assert_eq!(
            run(&v, "p/q/T.md", "p/z/T.md", LinkFormat::Relative)["p/r/S.md"],
            "[[../z/T]]"
        );
        assert_eq!(
            run(&v, "p/q/T.md", "p/z/U.md", LinkFormat::Absolute)["p/r/S.md"],
            "[[p/z/U]]"
        );
    }

    #[test]
    fn folder_rename_moves_sources_and_targets() {
        let v = vault(&[
            ("proj/A.md", "[[./B]] [[B]] [[../Root]]"),
            ("proj/B.md", "[[A]]"),
            ("Root.md", "[[proj/A]] [[A]] [[proj/B#x]]"),
        ]);
        let out = run(&v, "proj", "work/project", LinkFormat::Shortest);
        assert_eq!(out["Root.md"], "[[A]] [[A]] [[B#x]]");
        // Every link from or to a moved file resolves to a different path
        // string now, so each is regenerated in the configured format.
        assert_eq!(out["work/project/A.md"], "[[B]] [[B]] [[Root]]");
        assert!(!out.contains_key("work/project/B.md"));
        let fe = v.rename_edits("proj", "work/project", &RenameOptions::default());
        assert!(fe
            .iter()
            .any(|f| f.original_path == "proj/A.md" && f.path == "work/project/A.md"));
    }

    #[test]
    fn frontmatter_links_are_edited_in_place() {
        let v = vault(&[
            ("Old.md", ""),
            (
                "a.md",
                "---\nup: \"[[Old]]\"\nlist:\n  - \"[[Old]]\"\n---\n[[Old]]",
            ),
        ]);
        let out = run(&v, "Old.md", "New.md", LinkFormat::Shortest);
        assert_eq!(
            out["a.md"],
            "---\nup: \"[[New]]\"\nlist:\n  - \"[[New]]\"\n---\n[[New]]"
        );
    }

    #[test]
    fn edits_are_utf16() {
        let v = vault(&[("Old.md", ""), ("a.md", "🎉 [[Old]] é [[Old]]")]);
        let edits = v.rename_edits("Old.md", "New.md", &RenameOptions::default());
        assert_eq!(
            edits[0].edits[0],
            TextEdit {
                start: 3,
                end: 10,
                text: "[[New]]".into()
            }
        );
        assert_eq!(edits[0].edits[1].start, 13);
        assert_eq!(
            apply_edits("🎉 [[Old]] é [[Old]]", &edits[0].edits),
            "🎉 [[New]] é [[New]]"
        );
    }

    #[test]
    fn unknown_path_gives_no_edits() {
        let v = vault(&[("a.md", "[[b]]")]);
        assert!(v
            .rename_edits("nope.md", "x.md", &RenameOptions::default())
            .is_empty());
    }

    #[test]
    fn rename_file_updates_index() {
        let mut v = vault(&[("Old.md", "body"), ("a.md", "[[Old]]")]);
        v.rename_file("Old.md", "d/New.md");
        assert!(v.note("d/New.md").is_some());
        assert_eq!(v.unresolved_links()["a.md"]["Old"], 1);
        let mut w = vault(&[("f/x.md", ""), ("f/y.png", "")]);
        w.rename_file("f", "g");
        assert!(
            w.file("g/y.png").is_some() && w.note("g/x.md").is_some() && w.file("f/x.md").is_none()
        );
    }

    #[test]
    fn rewrite_link_edge_cases() {
        assert_eq!(
            rename::rewrite_link("[x](Old.md)", "Old.md", "New.md"),
            "[x](New.md)"
        );
        assert_eq!(
            rename::rewrite_link("[a/Old](a/Old.md)", "a/Old.md", "b/New.md"),
            "[b/New](b/New.md)"
        );
        assert_eq!(rename::rewrite_link("weird", "Old", "New"), "[](New)");
        assert_eq!(rename::rewrite_link("!weird", "Old", "New"), "![](New)");
        assert_eq!(
            rename::encode_markdown_destination("a b\\c\u{e}\u{1}"),
            "a%20b%5Cc%0E\u{1}"
        );
    }
}

// ---------------------------------------------------------------- search

mod search_ops {
    use super::*;

    fn sample() -> VaultIndex {
        vault(&[
            (
                "Meetings/Work meeting.md",
                "---\nstatus: Draft\nduration: 3\ntags: [work, Project/Alpha]\naliases:\nempty:\nflag: true\n---\n# Agenda\nDiscuss the budget with Alice.\n## Notes\nHappyCat said hello\n- [ ] call Bob\n- [x] email Carol\n",
            ),
            ("Personal/Meetup.md", "---\nstatus: Published\nduration: 10\n---\nA personal meetup about cats and dogs.\n\nDog cat in one block.\n\n#personal #work/remote\n"),
            ("Daily/2024-01-15.md", "Today: meeting work. Star Wars marathon. catalog\n"),
            ("assets/meeting-photo.png", ""),
            ("Board.canvas", "{}"),
        ])
    }

    #[test]
    fn terms_are_and_ed_and_case_insensitive() {
        let v = sample();
        assert_eq!(
            search(&v, "meeting work"),
            vec!["Daily/2024-01-15.md", "Meetings/Work meeting.md"]
        );
        assert_eq!(search(&v, "ALICE"), vec!["Meetings/Work meeting.md"]);
    }

    #[test]
    fn or_and_grouping() {
        let v = sample();
        assert_eq!(
            search(&v, "alice OR dogs"),
            vec!["Personal/Meetup.md", "Meetings/Work meeting.md"]
        );
        assert_eq!(
            search(&v, "meeting (alice OR marathon)"),
            vec!["Daily/2024-01-15.md", "Meetings/Work meeting.md"]
        );
        assert_eq!(
            search(&v, "meeting work OR meetup personal"),
            vec![
                "Daily/2024-01-15.md",
                "Personal/Meetup.md",
                "Meetings/Work meeting.md"
            ]
        );
    }

    #[test]
    fn negation() {
        let v = sample();
        assert_eq!(search(&v, "meeting -alice"), vec!["Daily/2024-01-15.md"]);
        // A lone exclusion lists every searchable file without the term,
        // including attachments (nothing to exclude them on).
        let all = search(&v, "-alice");
        assert!(all.contains(&"assets/meeting-photo.png".to_string()));
        assert!(!all.contains(&"Meetings/Work meeting.md".to_string()));
        assert_eq!(search(&v, "meeting -work"), Vec::<String>::new());
        assert_eq!(search(&v, "meeting -alice -marathon"), Vec::<String>::new());
        assert_eq!(search(&v, "cats -dogs"), Vec::<String>::new());
        assert_eq!(
            search(&v, "cat -dogs"),
            vec!["Daily/2024-01-15.md", "Meetings/Work meeting.md"]
        );
    }

    #[test]
    fn negated_group_requires_both() {
        let v = sample();
        // "meeting" appears in Work meeting.md (file name + content? no —
        // content has no "meeting"; file name does) and the daily note.
        assert_eq!(
            search(&v, "meeting -(budget alice)"),
            vec!["Daily/2024-01-15.md"]
        );
        assert_eq!(
            search(&v, "meeting -(budget zebra)"),
            vec!["Daily/2024-01-15.md", "Meetings/Work meeting.md"]
        );
    }

    #[test]
    fn quoted_phrase_is_whole_word_in_content_substring_in_names() {
        let v = sample();
        assert_eq!(search(&v, "\"star wars\""), vec!["Daily/2024-01-15.md"]);
        assert_eq!(
            search(&v, "cat"),
            vec![
                "Daily/2024-01-15.md",
                "Personal/Meetup.md",
                "Meetings/Work meeting.md"
            ]
        );
        assert_eq!(search(&v, "\"cat\""), vec!["Personal/Meetup.md"]);
        assert_eq!(
            search(&v, "\"meet\""),
            vec!["Personal/Meetup.md", "Meetings/Work meeting.md"],
            "file names match partially"
        );
    }

    #[test]
    fn plain_terms_match_note_file_names_with_extension() {
        let v = sample();
        assert!(search(&v, ".md").len() == 3);
        assert_eq!(search(&v, "board"), vec!["Board.canvas"]);
        assert!(
            search(&v, "photo").is_empty(),
            "attachments are not matched by plain terms"
        );
    }

    #[test]
    fn file_and_path_reach_every_file() {
        let v = sample();
        assert_eq!(search(&v, "file:photo"), vec!["assets/meeting-photo.png"]);
        assert_eq!(search(&v, "file:.png"), vec!["assets/meeting-photo.png"]);
        assert_eq!(
            search(&v, "path:Meetings"),
            vec!["Meetings/Work meeting.md"]
        );
        assert_eq!(
            search(&v, "path:\"Daily/2024\""),
            vec!["Daily/2024-01-15.md"]
        );
        assert_eq!(
            search(&v, "file:meet -path:assets"),
            vec!["Personal/Meetup.md", "Meetings/Work meeting.md"]
        );
    }

    #[test]
    fn content_operator_ignores_file_names() {
        let v = sample();
        assert_eq!(search(&v, "content:meeting"), vec!["Daily/2024-01-15.md"]);
        assert_eq!(search(&v, "content:\"happy cat\""), Vec::<String>::new());
    }

    #[test]
    fn match_case_and_ignore_case() {
        let v = sample();
        assert_eq!(
            search(&v, "match-case:HappyCat"),
            vec!["Meetings/Work meeting.md"]
        );
        assert!(search(&v, "match-case:happycat").is_empty());
        let out = v.search(
            "happycat",
            &SearchOptions {
                case_sensitive: true,
                ..Default::default()
            },
        );
        assert!(out.results.is_empty());
        let out = v.search(
            "ignore-case:happycat",
            &SearchOptions {
                case_sensitive: true,
                ..Default::default()
            },
        );
        assert_eq!(paths(&out), vec!["Meetings/Work meeting.md"]);
    }

    #[test]
    fn tag_operator() {
        let v = sample();
        assert_eq!(
            search(&v, "tag:work"),
            vec!["Personal/Meetup.md", "Meetings/Work meeting.md"]
        );
        assert_eq!(search(&v, "tag:#project"), vec!["Meetings/Work meeting.md"]);
        assert!(search(&v, "tag:wor").is_empty());
        assert_eq!(search(&v, "tag:PERSONAL"), vec!["Personal/Meetup.md"]);
        let out = v.search("tag:work", &SearchOptions::default());
        let meetup = out
            .results
            .iter()
            .find(|r| r.path == "Personal/Meetup.md")
            .unwrap();
        assert_eq!(meetup.content_matches.len(), 1);
        let work = out
            .results
            .iter()
            .find(|r| r.path.starts_with("Meetings"))
            .unwrap();
        assert_eq!(
            work.properties,
            vec![PropertyHit {
                key: "tags".into(),
                subkey: None,
                pos: None
            }]
        );
    }

    #[test]
    fn line_operator() {
        let v = sample();
        assert_eq!(
            search(&v, "line:(budget alice)"),
            vec!["Meetings/Work meeting.md"]
        );
        assert!(search(&v, "line:(budget hello)").is_empty());
        assert_eq!(search(&v, "budget hello"), vec!["Meetings/Work meeting.md"]);
        // -line: no line matches.
        assert!(
            !search(&v, "-line:(budget alice)").contains(&"Meetings/Work meeting.md".to_string())
        );
    }

    #[test]
    fn block_operator() {
        let v = sample();
        assert_eq!(search(&v, "block:(dog cat)"), vec!["Personal/Meetup.md"]);
        assert!(search(&v, "block:(dogs personal)").contains(&"Personal/Meetup.md".to_string()));
        assert!(search(&v, "block:(meetup block)").is_empty());
        assert_eq!(search(&v, "block:(call)"), vec!["Meetings/Work meeting.md"]);
    }

    #[test]
    fn section_operator_and_nesting() {
        let v = sample();
        assert_eq!(
            search(&v, "section:(budget alice)"),
            vec!["Meetings/Work meeting.md"]
        );
        assert!(
            search(&v, "section:(budget hello)").is_empty(),
            "sections end at the next heading of any level"
        );
        assert_eq!(
            search(&v, "section:(agenda section:hello)"),
            vec!["Meetings/Work meeting.md"]
        );
        assert!(
            search(&v, "section:(notes section:hello)").is_empty(),
            "## Notes has no subsections"
        );
        // A note without headings is one section.
        assert_eq!(
            search(&v, "section:(dog personal)"),
            vec!["Personal/Meetup.md"]
        );
    }

    #[test]
    fn task_operators() {
        let v = sample();
        assert_eq!(search(&v, "task:call"), vec!["Meetings/Work meeting.md"]);
        assert_eq!(
            search(&v, "task-todo:call"),
            vec!["Meetings/Work meeting.md"]
        );
        assert!(search(&v, "task-todo:email").is_empty());
        assert_eq!(
            search(&v, "task-done:email"),
            vec!["Meetings/Work meeting.md"]
        );
        assert_eq!(
            search(&v, "task:(call OR email)"),
            vec!["Meetings/Work meeting.md"]
        );
        assert!(search(&v, "task:budget").is_empty());
        let out = v.search("task-todo:\"\"", &SearchOptions::default());
        assert_eq!(paths(&out), vec!["Meetings/Work meeting.md"]);
        assert_eq!(out.results[0].content_matches.len(), 1);
        assert!(search(&v, "task:").is_empty());
    }

    #[test]
    fn property_existence_and_values() {
        let v = sample();
        assert_eq!(
            search(&v, "[status]"),
            vec!["Personal/Meetup.md", "Meetings/Work meeting.md"]
        );
        assert_eq!(
            search(&v, "[stat]"),
            vec!["Personal/Meetup.md", "Meetings/Work meeting.md"],
            "bare key is a substring"
        );
        assert!(search(&v, "[\"stat\"]").is_empty(), "quoted key is exact");
        assert_eq!(
            search(&v, "[status:draft]"),
            vec!["Meetings/Work meeting.md"]
        );
        assert_eq!(
            search(&v, "[status:Draft OR Published]"),
            vec!["Personal/Meetup.md", "Meetings/Work meeting.md"]
        );
        assert_eq!(search(&v, "[tags:alpha]"), vec!["Meetings/Work meeting.md"]);
        assert_eq!(
            search(&v, "[aliases:null]"),
            vec!["Meetings/Work meeting.md"]
        );
        assert_eq!(
            search(&v, "[empty:EMPTY]"),
            vec!["Meetings/Work meeting.md"]
        );
        assert_eq!(search(&v, "[flag:TRUE]"), vec!["Meetings/Work meeting.md"]);
        assert!(search(&v, "[flag:FALSE]").is_empty());
    }

    #[test]
    fn property_comparisons_use_js_semantics() {
        let v = sample();
        assert_eq!(
            search(&v, "[duration:<5]"),
            vec!["Meetings/Work meeting.md"]
        );
        assert_eq!(search(&v, "[duration:>5]"), vec!["Personal/Meetup.md"]);
        // String vs string compares code units: "Draft" < "E".
        assert_eq!(search(&v, "[status:<E]"), vec!["Meetings/Work meeting.md"]);
        assert!(
            search(&v, "[duration:>abc]").is_empty(),
            "NaN compares false"
        );
    }

    #[test]
    fn property_hit_shape() {
        let v = sample();
        let out = v.search("[tags:alpha]", &SearchOptions::default());
        assert_eq!(
            out.results[0].properties,
            vec![PropertyHit {
                key: "tags".into(),
                subkey: Some(vec![1]),
                pos: Some([8, 13])
            }]
        );
        assert_eq!(out.match_count, 1);
    }

    #[test]
    fn regex_terms() {
        let v = sample();
        assert_eq!(
            search(&v, r"/\d{4}-\d{2}-\d{2}/"),
            vec!["Daily/2024-01-15.md"]
        );
        assert_eq!(
            search(&v, r"path:/\d{4}-\d{2}/"),
            vec!["Daily/2024-01-15.md"]
        );
        assert_eq!(
            search(&v, "/^## notes$/"),
            vec!["Meetings/Work meeting.md"],
            "multiline and case-insensitive"
        );
        assert!(search(&v, "match-case:/^## notes$/").is_empty());
        let all = search(&v, "//");
        assert_eq!(
            all.len(),
            5,
            "an empty regex is not applicable, so everything matches"
        );
    }

    #[test]
    fn malformed_queries_report_errors() {
        let v = sample();
        for (q, err) in [
            ("foo:bar", "Operator \"foo\" not recognized"),
            (
                "line:(task:x)",
                "Operator \"task\" cannot be nested within \"line\"",
            ),
            (
                "tag:(a OR b)",
                "Operator \"tag\" can only be followed by text",
            ),
            ("[a:[b]]", "Property cannot be nested within a property."),
        ] {
            let out = v.search(q, &SearchOptions::default());
            assert_eq!(out.error.as_deref(), Some(err), "{q}");
            assert!(out.results.is_empty());
        }
        let out = v.search("/[unclosed/", &SearchOptions::default());
        assert!(out
            .error
            .unwrap()
            .starts_with("Failed to parse regular expression."));
        let empty = v.search("", &SearchOptions::default());
        assert!(empty.error.is_none() && empty.results.is_empty());
    }

    #[test]
    fn result_ranges_counts_and_lines() {
        let v = vault(&[("Cat notes.md", "a cat\n😀 cat CAT")]);
        let out = v.search("cat", &SearchOptions::default());
        let r = &out.results[0];
        assert_eq!(r.filename_matches, vec![[0, 3]]);
        let spans: Vec<(u32, u32, u32, u32)> = r
            .content_matches
            .iter()
            .map(|m| (m.start, m.end, m.line, m.col))
            .collect();
        assert_eq!(spans, vec![(2, 5, 0, 2), (9, 12, 1, 3), (13, 16, 1, 7)]);
        assert_eq!(r.match_count, 4);
        assert_eq!(out.match_count, 4);
        assert_eq!(out.file_count, 1);
        let ctx = &r.content_matches[1].context;
        assert_eq!(
            (ctx.text.as_str(), ctx.offset, ctx.start, ctx.end),
            ("😀 cat CAT", 6, 3, 6)
        );
    }

    #[test]
    fn adjacent_ranges_merge() {
        let v = vault(&[("n.md", "abab")]);
        let out = v.search("ab", &SearchOptions::default());
        assert_eq!(out.results[0].content_matches.len(), 1);
        assert_eq!(out.results[0].content_matches[0].end, 4);
    }

    #[test]
    fn sort_orders_and_limit() {
        let v = vault(&[
            ("b.md", "x"),
            ("A 10.md", "x"),
            ("A 9.md", "x"),
            ("c.md", "x"),
        ]);
        let order = |s: SortOrder| {
            paths(&v.search(
                "x",
                &SearchOptions {
                    sort: s,
                    ..Default::default()
                },
            ))
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        };
        assert_eq!(
            order(SortOrder::Alphabetical),
            vec!["A 9.md", "A 10.md", "b.md", "c.md"]
        );
        assert_eq!(
            order(SortOrder::AlphabeticalReverse),
            vec!["c.md", "b.md", "A 10.md", "A 9.md"]
        );
        // mtime = 100 - insertion index; ctime = insertion index.
        assert_eq!(
            order(SortOrder::ByModifiedTime),
            vec!["b.md", "A 10.md", "A 9.md", "c.md"]
        );
        assert_eq!(
            order(SortOrder::ByModifiedTimeReverse),
            vec!["c.md", "A 9.md", "A 10.md", "b.md"]
        );
        assert_eq!(
            order(SortOrder::ByCreatedTime),
            vec!["c.md", "A 9.md", "A 10.md", "b.md"]
        );
        assert_eq!(
            order(SortOrder::ByCreatedTimeReverse),
            vec!["b.md", "A 10.md", "A 9.md", "c.md"]
        );
        let limited = v.search(
            "x",
            &SearchOptions {
                limit: Some(2),
                ..Default::default()
            },
        );
        assert_eq!(limited.results.len(), 2);
        assert_eq!(limited.file_count, 4);
    }

    #[test]
    fn explain_in_output() {
        let v = sample();
        let out = v.search(
            "a OR b",
            &SearchOptions {
                explain: true,
                ..Default::default()
            },
        );
        assert_eq!(
            out.explanation.unwrap().to_text(),
            "Match any of:\n  Matches text: \"a\"\n  Matches text: \"b\"\n"
        );
    }

    #[test]
    fn unicode_case_folding_in_content() {
        let v = vault(&[("n.md", "Ärger über ÉCOLE")]);
        assert_eq!(search(&v, "ärger école"), vec!["n.md"]);
        assert_eq!(search(&v, "\"über\""), vec!["n.md"]);
    }

    #[test]
    fn unsupported_files_are_skipped_unless_asked() {
        let v = vault(&[("data.csv", ""), ("n.md", "")]);
        assert!(search(&v, "file:data").is_empty());
        let out = v.search(
            "file:data",
            &SearchOptions {
                include_unsupported: true,
                ..Default::default()
            },
        );
        assert_eq!(paths(&out), vec!["data.csv"]);
    }

    #[test]
    fn serialises_camel_case() {
        let v = vault(&[("n.md", "x")]);
        let json = serde_json::to_string(&v.search("x", &SearchOptions::default())).unwrap();
        assert!(
            json.contains("\"filenameMatches\"")
                && json.contains("\"contentMatches\"")
                && json.contains("\"matchCount\""),
            "{json}"
        );
        let opts: SearchOptions =
            serde_json::from_str(r#"{"caseSensitive":true,"sort":"byModifiedTime"}"#).unwrap();
        assert!(opts.case_sensitive);
        assert_eq!(opts.sort, SortOrder::ByModifiedTime);
    }
}

// ---------------------------------------------------------------- graph

mod graph_data {
    use super::*;

    fn sample() -> VaultIndex {
        vault(&[
            ("Hub.md", "[[A]] [[B]] [[Ghost]] ![[pic.png]] #topic"),
            ("A.md", "[[C]] #Topic"),
            ("B.md", "[[Hub]]"),
            ("C.md", "[[D]]"),
            ("D.md", ""),
            ("Lonely.md", "nothing"),
            ("pic.png", ""),
        ])
    }

    fn ids(g: &GraphData) -> Vec<&str> {
        let mut v: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
        v.sort();
        v
    }

    fn has_link(g: &GraphData, a: &str, b: &str) -> bool {
        let idx = |id: &str| g.nodes.iter().position(|n| n.id == id).unwrap() as u32;
        g.links
            .iter()
            .any(|l| l.source == idx(a) && l.target == idx(b))
    }

    #[test]
    fn global_defaults() {
        let v = sample();
        let g = v.graph(&GraphOptions::default());
        assert_eq!(
            ids(&g),
            vec![
                "A.md",
                "B.md",
                "C.md",
                "D.md",
                "Ghost",
                "Hub.md",
                "Lonely.md"
            ]
        );
        assert!(has_link(&g, "Hub.md", "Ghost"));
        assert!(has_link(&g, "B.md", "Hub.md"));
        let ghost = g.nodes.iter().find(|n| n.id == "Ghost").unwrap();
        assert_eq!(ghost.kind, NodeKind::Unresolved);
        let hub = g.nodes.iter().find(|n| n.id == "Hub.md").unwrap();
        assert_eq!(hub.weight, 4, "A, B, Ghost out; B in");
        assert_eq!(hub.label, "Hub");
    }

    #[test]
    fn toggles_attachments_tags_existing_orphans() {
        let v = sample();
        let g = v.graph(&GraphOptions {
            show_attachments: true,
            show_tags: true,
            hide_unresolved: true,
            show_orphans: false,
            ..Default::default()
        });
        let ids = ids(&g);
        assert!(ids.contains(&"pic.png") && !ids.contains(&"Ghost") && !ids.contains(&"Lonely.md"));
        // #topic and #Topic are one node, spelled as getTags() settled.
        let tag_nodes: Vec<&GraphNode> =
            g.nodes.iter().filter(|n| n.kind == NodeKind::Tag).collect();
        assert_eq!(tag_nodes.len(), 1);
        let tag = tag_nodes[0].id.clone();
        assert!(has_link(&g, "A.md", &tag) && has_link(&g, "Hub.md", &tag));
        assert_eq!(
            g.nodes.iter().find(|n| n.id == "pic.png").unwrap().kind,
            NodeKind::Attachment
        );
    }

    #[test]
    fn filter_and_color_groups() {
        let v = sample();
        let g = v.graph(&GraphOptions {
            search: "-file:Lonely".into(),
            color_groups: vec![
                ColorGroup {
                    query: "path:C".into(),
                    color: serde_json::json!({"a":1,"rgb":255}),
                },
                ColorGroup {
                    query: "file:D.md OR file:C.md".into(),
                    color: serde_json::Value::Null,
                },
            ],
            hide_unresolved: true,
            ..Default::default()
        });
        assert!(!ids(&g).contains(&"Lonely.md"));
        let group = |id: &str| g.nodes.iter().find(|n| n.id == id).unwrap().group;
        assert_eq!(group("C.md"), Some(0), "first matching group wins");
        assert_eq!(group("D.md"), Some(1));
        assert_eq!(group("A.md"), None);
        let bad = v.graph(&GraphOptions {
            search: "nope:x".into(),
            ..Default::default()
        });
        assert_eq!(bad.errors.len(), 1);
    }

    #[test]
    fn local_graph_depth_and_directions() {
        let v = sample();
        let base = GraphOptions {
            local_file: Some("A.md".into()),
            hide_unresolved: true,
            ..Default::default()
        };
        let g1 = v.graph(&base);
        assert_eq!(ids(&g1), vec!["A.md", "C.md", "Hub.md"]);
        let g2 = v.graph(&GraphOptions {
            local_jumps: 2,
            ..base.clone()
        });
        assert_eq!(ids(&g2), vec!["A.md", "B.md", "C.md", "D.md", "Hub.md"]);
        let depth = |g: &GraphData, id: &str| g.nodes.iter().find(|n| n.id == id).unwrap().depth;
        assert_eq!(depth(&g2, "A.md"), Some(0));
        assert_eq!(depth(&g2, "D.md"), Some(2));
        let out_only = v.graph(&GraphOptions {
            local_backlinks: false,
            local_jumps: 3,
            ..base.clone()
        });
        assert_eq!(ids(&out_only), vec!["A.md", "C.md", "D.md"]);
        let in_only = v.graph(&GraphOptions {
            local_forelinks: false,
            local_jumps: 2,
            ..base.clone()
        });
        assert_eq!(ids(&in_only), vec!["A.md", "B.md", "Hub.md"]);
        assert!(has_link(&g2, "B.md", "Hub.md") && has_link(&g2, "Hub.md", "B.md"));
        // Neighbor links: P and Q are both reached from X in one round, so
        // P→Q is only drawn with "Neighbor links" on.
        let w = vault(&[("X.md", "[[P]] [[Q]]"), ("P.md", "[[Q]]"), ("Q.md", "")]);
        let local = GraphOptions {
            local_file: Some("X.md".into()),
            ..Default::default()
        };
        assert!(!has_link(&w.graph(&local), "P.md", "Q.md"));
        assert!(has_link(
            &w.graph(&GraphOptions {
                local_interlinks: true,
                ..local
            }),
            "P.md",
            "Q.md"
        ));
    }

    #[test]
    fn local_graph_of_unknown_file_is_just_the_center() {
        let v = sample();
        let g = v.graph(&GraphOptions {
            local_file: Some("Nope.md".into()),
            ..Default::default()
        });
        assert_eq!(ids(&g), vec!["Nope.md"]);
    }

    #[test]
    fn graph_serialises() {
        let v = sample();
        let json = serde_json::to_value(v.graph(&GraphOptions::default())).unwrap();
        assert!(json["nodes"][0]["kind"].is_string());
        assert!(json["links"][0]["source"].is_number());
        let opts: GraphOptions = serde_json::from_str(r#"{"showTags":true,"localJumps":3,"colorGroups":[{"query":"x","color":{"a":1,"rgb":1}}]}"#).unwrap();
        assert!(opts.show_tags && opts.show_orphans);
        assert_eq!(opts.local_jumps, 3);
    }

    #[test]
    fn layout_from_graph() {
        let v = sample();
        let g = v.graph(&GraphOptions::default());
        let edges: Vec<(u32, u32)> = g.links.iter().map(|l| (l.source, l.target)).collect();
        let mut layout = ForceLayout::with_ids(
            g.nodes.iter().map(|n| n.id.clone()).collect(),
            &edges,
            ForceParams::default(),
        );
        layout.step(50);
        assert_eq!(layout.positions().len(), g.nodes.len() * 2);
    }
}

// ---------------------------------------------------------------- odds and ends

mod extra {
    use super::*;
    use std::borrow::Cow;

    #[test]
    fn whole_word_prefix_consumes_previous_character() {
        let s = "c++c++ x";
        // The needle ends with a non-word character, so there is no
        // lookahead; the second occurrence starts where the first ended and
        // has no character of its own to consume, so the app misses it.
        assert_eq!(
            util::find_whole_word(s, || Cow::Owned(util::fold(s)), "c++", false, true),
            vec![[0, 3]]
        );
        let t = "cat\ncat";
        assert_eq!(
            util::find_whole_word(t, || Cow::Owned(util::fold(t)), "cat", false, true),
            vec![[0, 3], [4, 7]]
        );
    }

    #[test]
    fn apply_edits_skips_overlaps_and_handles_unsorted() {
        let edits = vec![
            TextEdit {
                start: 4,
                end: 5,
                text: "E".into(),
            },
            TextEdit {
                start: 0,
                end: 2,
                text: "AB".into(),
            },
            TextEdit {
                start: 1,
                end: 3,
                text: "zz".into(),
            },
        ];
        assert_eq!(apply_edits("abcdef", &edits), "ABcdEf");
    }

    #[test]
    fn orphans_off_keeps_linked_and_linked_to() {
        let v = vault(&[
            ("a.md", "[[b]]"),
            ("b.md", ""),
            ("c.md", ""),
            ("d.md", "[[#self]]"),
        ]);
        let g = v.graph(&GraphOptions {
            show_orphans: false,
            ..Default::default()
        });
        let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["a.md", "b.md"]);
    }

    #[test]
    fn number_list_items_and_subkeys() {
        let v = vault(&[("n.md", "---\nlist: [a, b, 12]\n---\n")]);
        let out = v.search("[list:12]", &SearchOptions::default());
        assert_eq!(
            out.results[0].properties,
            vec![PropertyHit {
                key: "list".into(),
                subkey: Some(vec![2]),
                pos: Some([0, 2])
            }]
        );
        assert_eq!(
            search(&v, "[list:<5]").len(),
            0,
            "12 < \"5\" numerically is false; \"a\" < \"5\" as strings is false"
        );
        assert_eq!(search(&v, "[list:>5]"), vec!["n.md"]);
    }

    #[test]
    fn path_ranges_are_utf16() {
        let v = vault(&[("😀 dir/Café note.md", "")]);
        let out = v.search("path:café", &SearchOptions::default());
        assert_eq!(out.results[0].filepath_matches, vec![[7, 11]]);
        let out = v.search("file:note", &SearchOptions::default());
        assert_eq!(out.results[0].filename_matches, vec![[5, 9]]);
    }

    #[test]
    fn query_helpers_for_graph_and_canvas() {
        let q = parse_query("tag:project").unwrap();
        assert!(q.matches_tag("#project/alpha", false));
        // As in the app, `tag:` on a non-matching tag falls through to "not
        // applicable", which counts as a match: it never hides tag nodes.
        assert!(q.matches_tag("#projects", false));
        assert!(!parse_query("proj").unwrap().matches_tag("#other", false));
        assert!(parse_query("proj")
            .unwrap()
            .matches_tag("#myproject", false));
        let p = parse_query("photo").unwrap();
        assert!(p.matches_filepath("img/photo.png", false));
        assert!(parse_query("hello")
            .unwrap()
            .matches_content("say HELLO", false));
        assert!(!parse_query("match-case:hello")
            .unwrap()
            .matches_content("say HELLO", false));
        assert!(!parse_query("path:x file:y").unwrap().needs_content());
        assert!(parse_query("path:x y").unwrap().needs_content());
    }

    #[test]
    fn sort_results_is_stable() {
        let mut v = vec![
            (
                "a",
                SearchResult {
                    score: -1.0,
                    matches: vec![],
                },
            ),
            (
                "b",
                SearchResult {
                    score: 0.0,
                    matches: vec![],
                },
            ),
            (
                "c",
                SearchResult {
                    score: -1.0,
                    matches: vec![],
                },
            ),
        ];
        fuzzy::sort_results(&mut v);
        assert_eq!(
            v.iter().map(|x| x.0).collect::<Vec<_>>(),
            vec!["b", "a", "c"]
        );
    }

    #[test]
    fn empty_layout_is_harmless() {
        let mut l = ForceLayout::new(0, &[], ForceParams::default());
        assert!(!l.step(5) || l.positions().is_empty());
        l.set_graph(vec!["x".into()], &[(0, 5)]);
        assert_eq!(l.positions().len(), 2);
        l.step(3);
        assert!(l.positions().iter().all(|v| v.is_finite()));
    }

    #[test]
    fn wire_shapes_are_camel_case() {
        let e: FileEntry = serde_json::from_str(r#"{"path":"a.md","mtime":5}"#).unwrap();
        assert_eq!(e.mtime, 5.0);
        let opts: RenameOptions = serde_json::from_str(r#"{"linkFormat":"relative"}"#).unwrap();
        assert_eq!(opts.link_format, LinkFormat::Relative);
        let fp: ForceParams =
            serde_json::from_str(r#"{"repelStrength":5,"linkDistance":100}"#).unwrap();
        assert_eq!(
            (fp.repel_strength, fp.link_distance, fp.link_strength),
            (5.0, 100.0, 1.0)
        );
        let v = vault(&[("T.md", ""), ("S.md", "[[T]]")]);
        let json = serde_json::to_string(&v.backlinks("T.md")).unwrap();
        assert!(
            json.contains("\"displayText\"") && json.contains("\"kind\":\"link\""),
            "{json}"
        );
    }

    #[test]
    fn tags_key_keeps_spelling() {
        let fm = serde_json::json!({"TAGS": ["x"]});
        assert_eq!(tags::tags_key(fm.as_object().unwrap()), "TAGS");
        let v = vault(&[("n.md", "---\nTAGS: [x]\n---\n")]);
        let out = v.search("tag:x", &SearchOptions::default());
        assert_eq!(out.results[0].properties[0].key, "TAGS");
    }

    #[test]
    fn empty_headings_list_counts_as_no_headings() {
        let text = "alpha beta";
        let mut meta = testkit::parse(text);
        meta.headings = Some(Vec::new());
        let mut v = VaultIndex::new();
        v.set_note("n.md", text.into(), meta);
        assert_eq!(search(&v, "section:(alpha beta)"), vec!["n.md"]);
    }
}
