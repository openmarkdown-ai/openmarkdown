OpenMarkdown {{TAG}}. A release whose tag contains a hyphen (`-rc.1`) is a release candidate for testing. It is not the latest stable release.

Every file below is built from this tag by `.github/workflows/release.yml`. Nothing here is signed or listed in a browser store yet.

## Web app: `openmarkdown-web-{{TAG}}.zip`

A static site. It needs no server code, so any static host can serve it: GitHub Pages, Netlify, Cloudflare Pages, nginx or a folder on your own machine.

```sh
unzip openmarkdown-web-{{TAG}}.zip -d openmarkdown
npx serve openmarkdown          # then open the URL it prints
```

- Serve it over `http://localhost` or HTTPS. Opening `index.html` as a `file://` URL does not work, because service workers and WebAssembly need a real origin.
- Real folders on disk need a Chromium browser (Chrome, Edge, Brave, Arc). Other browsers use a vault stored in the browser.
- This build does not include sync. Sync is only in builds made with the OpenSync checkout (see the README).

## Companion extension: `openmarkdown-clipper-chrome-{{TAG}}.zip` / `openmarkdown-clipper-firefox-{{TAG}}.zip`

The web clipper, and the network bridge that lets plugins reach sites that block cross-origin requests.

**Chrome, Edge, Brave, Arc:** unzip `openmarkdown-clipper-chrome-{{TAG}}.zip` into a folder you will keep. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and pick the folder. `manifest.json` is at the top of the folder.

**Firefox (128 or later):** unzip `openmarkdown-clipper-firefox-{{TAG}}.zip`. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick the `manifest.json` inside. Firefox removes temporary add-ons when it restarts.

By default the extension talks to `http://localhost:5200`, `http://localhost` and `https://openmarkdown.ai` (the hosted app lives at `https://openmarkdown.ai/app/`). You can add another origin, such as your own host of the web zip, in the extension's settings.

## `vault` CLI and MCP server

| Platform | File |
|---|---|
| macOS, Apple silicon | `vault-{{TAG}}-macos-arm64.tar.gz` |
| macOS, Intel | `vault-{{TAG}}-macos-x86_64.tar.gz` |
| Linux x86_64 | `vault-{{TAG}}-linux-x86_64.tar.gz` |
| Windows x86_64 | `vault-{{TAG}}-windows-x86_64.zip` |

```sh
tar -xzf vault-{{TAG}}-macos-arm64.tar.gz
cd vault-{{TAG}}-macos-arm64
chmod +x vault
xattr -d com.apple.quarantine vault 2>/dev/null   # macOS only: the binary is not notarised
./vault --help
./vault --vault ~/Notes info     # or run `./vault info` from inside the vault folder
./vault mcp ~/Notes              # serve the vault to an AI agent over MCP (stdio)
```

On Windows, unzip the file and run `vault.exe --help` from a terminal.

To use the vault from Claude Code, give it the absolute paths to the binary and to the vault:

```sh
claude mcp add --transport stdio notes -- /absolute/path/to/vault mcp /absolute/path/to/Notes
```

Add `--read-only` at the end if the agent should only read. `mcp.md` in the archive covers Claude Desktop, other clients and the tool list.
