import type { CorePluginDefinition } from "../obsidian/app-internals/internal-plugins";
import { globalSearch } from "./global-search/index";
import { backlink } from "./backlink/index";
import { outgoingLink } from "./outgoing-link/index";
import { tagPane } from "./tag-pane/index";
import { outline } from "./outline/index";
import { properties } from "./properties/index";
import { pagePreview } from "./page-preview/index";
import { footnotes } from "./footnotes/index";
import { trash } from "./trash/index";
import { periodicNotes } from "./periodic-notes/index";
import { calendar } from "./calendar/index";
import { naturalDates } from "./natural-dates/index";

/** Core plugins in the "knowledge" group. */
export const definitions: CorePluginDefinition[] = [globalSearch, backlink, outgoingLink, tagPane, outline, properties, pagePreview, footnotes, trash, periodicNotes, calendar, naturalDates];
