/**
 * Note text for a web clip, shared by the companion extension (apps/clipper)
 * and the app: Web Clipper's `sanitizeFileName` and `generateFrontmatter`
 * (obsidian-clipper, MIT). The app uses them when it fills a clip's prompt
 * variables and writes the frontmatter after the extension has built the rest.
 */

/** Web Clipper's `sanitizeFileName` (portable branch). */
export function sanitizeFileName(name: string): string {
  let s = name.replace(/[#|^[\]]/g, "");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "");
  if (s.startsWith(".")) s = `_${s.slice(1)}`;
  s = s.replace(/^\.+/, "").trim().slice(0, 245);
  return s || "Untitled";
}

function yamlDoubleQuoted(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

function splitMultitext(v: string): string[] {
  return v.split(/,(?![^[]*\]\])/).map((s) => s.trim());
}

/** Web Clipper's `generateFrontmatter`, over properties the user may have edited. */
export function generateFrontmatter(properties: { name: string; value: string; type: string }[], types: Record<string, string> = {}): string {
  let fm = "---\n";
  for (const p of properties) {
    const trimmed = p.name.trim();
    if (!trimmed) continue;
    const needsQuotes = /[:{}[\],&*#?|<>=!%@\\\- \t\n]/.test(trimmed) || /^\d/.test(trimmed) || /^(true|false|null|yes|no|on|off)$/i.test(trimmed);
    const key = needsQuotes ? (p.name.includes('"') ? `'${p.name.replace(/'/g, "''")}'` : `"${p.name}"`) : p.name;
    fm += `${key}:`;
    const type = types[p.name] ?? p.type ?? "text";
    const value = p.value ?? "";
    switch (type) {
      case "multitext": {
        let items: string[];
        const tv = value.trim();
        if (tv.startsWith('["') && tv.endsWith('"]')) {
          try {
            items = (JSON.parse(tv) as unknown[]).map(String);
          } catch {
            items = value.split(",").map((i) => i.trim());
          }
        } else items = splitMultitext(value);
        items = items.filter(Boolean);
        fm += "\n" + items.map((i) => `  - ${yamlDoubleQuoted(i)}\n`).join("");
        break;
      }
      case "number": {
        const numeric = value.replace(/[^\d.-]/g, "");
        fm += numeric ? ` ${String(parseFloat(numeric))}\n` : "\n";
        break;
      }
      case "checkbox":
        fm += value === "true" ? " true\n" : " false\n";
        break;
      case "date":
      case "datetime":
        fm += value.trim() ? ` ${value}\n` : "\n";
        break;
      default:
        fm += value.trim() ? ` ${yamlDoubleQuoted(value)}\n` : "\n";
    }
  }
  fm += "---\n";
  return fm === "---\n---\n" ? "" : fm;
}

export function joinPath(folder: string, name: string): string {
  const f = folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return f ? `${f}/${name}` : name;
}
