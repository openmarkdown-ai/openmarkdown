/**
 * `tokenClassNodeProp`: the token classes of a node in the editor's token
 * tree ("formatting formatting-math keyword math").
 *
 * Older `@codemirror/language` versions exported this from the stream parser,
 * and Obsidian's bundled copy still does; plugins such as Dataview and Iconize
 * read it from `require("@codemirror/language")`. Current versions dropped
 * it, so the app defines it here and adds it to the module plugins receive.
 */
import { NodeProp } from "@lezer/common";

export const tokenClassNodeProp = new NodeProp<string>();
