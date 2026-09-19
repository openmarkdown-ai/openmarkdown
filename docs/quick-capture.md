# Quick capture

Quick capture writes a thought into a vault without waiting for the vault to
load. The capture sheet appears as soon as the browser hands over the vault's
storage, and Save writes the file directly. The vault indexes the new text the
next time it opens.

## Where it goes

Settings → Quick capture (stored in `.obsidian/quick-capture.json`):

| Setting | Default | Effect |
|---|---|---|
| Destination | Today's daily note | `daily` (the Daily notes folder, format and template), `inbox` (one note), or `new` (a note named after the first line) |
| Inbox note | `Inbox.md` | The note used when the destination is Inbox |
| Folder for new notes | vault root | Where `new` captures are created |
| Under heading | none | Entries go at the end (or top) of this heading's section; the heading is created if missing |
| Position | At the end | `append` or `prepend` (after the properties) |
| Timestamp format | `HH:mm` | Moment.js tokens written before each entry; empty for none |
| Write entries as list items | on | `- 14:05 Call the plumber` |

Shared files are saved as attachments (Settings → Files and links → Default
location for new attachments) and linked from the entry: `![[photo.png]]`.

## Ways in

| From | How |
|---|---|
| Inside the app | Command **Quick capture: Open** (Mod+Alt+N), or the lightning-bolt ribbon button |
| A floating window | Command **Quick capture: Open in floating window**: an always-on-top Picture-in-Picture window in Chrome, Edge and Firefox 151+ |
| The app icon | Right-click (desktop) or long-press (Android) the installed app → **New quick note** |
| The share sheet | Android and ChromeOS, and Windows with the app installed: Share → OpenMarkdown |
| ChromeOS stylus / lock screen | The manifest's `note_taking.new_note_url` |
| Any link or automation | `https://<your app>/?capture=1` |

### The capture URL

```
https://<your app>/?capture=1&vault=<vault name or id>&text=<text>&dest=daily|inbox|new&save=1
```

- `vault`: the vault's name as shown in the vault list, or its id. Omit it to
  use the vault opened most recently.
- `text`: fills in the sheet (URL-encoded).
- `dest`: overrides the destination for this capture.
- `save=1`: saves `text` straight away instead of waiting for the Save button.
  The page then shows where it was saved.

The same page accepts `?share=1&title=…&text=…&url=…` (what a share would
send); a shared link becomes `[title](url)`.

A folder vault (a folder on disk) may need the browser's permission again.
The sheet still opens, and Save asks for access before writing.

## iOS and iPadOS: a Shortcuts recipe

iOS has no share target for web apps, so capture goes through Apple's
Shortcuts app. Safari deletes a site's data after seven days without a visit;
Home Screen web apps are exempt. Read the storage note at the end of the
recipe before choosing where the vault lives.

1. Open **Shortcuts** and tap **+**.
2. Add **Ask for Input**: Input Type *Text*, Prompt *Capture*.
3. Add **URL Encode**, encoding *Provided Input*.
4. Add **Text** containing
   `https://<your app>/?capture=1&vault=<Your vault>&save=1&text=` followed by
   the **URL Encoded Text** variable (tap the variable bar to insert it).
5. Add **Open URLs** with that Text.
6. Name the shortcut *Capture*. Add it to the Home Screen, the Lock Screen
   widget, the Action button (iPhone 15 Pro and later) or Back Tap
   (Settings → Accessibility → Touch → Back Tap).

To capture from other apps' share sheets, turn on **Show in Share Sheet** in
the shortcut's details, set it to receive *Text* and *URLs*, and use
**Shortcut Input** instead of **Ask for Input** in step 2.

Leave out `&save=1` to review the text in the capture sheet before saving.

**Check where the link opens.** On iOS a Home Screen web app and Safari keep
separate storage. If **Open URLs** opens Safari rather than the Home Screen
app, the capture page will not see a vault created in the Home Screen app
("No vault yet"). Either keep the vault in Safari (and visit it within seven
days), or sync the vault so both copies receive the capture. This has not been
verified on a device for every iOS version.

## Limits

- The first visit needs a connection; after that the app (and the capture
  page) start offline.
- A vault stored in the browser exists only in that browser profile: capture
  from the same browser (or installed app) where the vault lives.
- The demo vault is in memory, so captures to it disappear on reload.
