//! Bases: database-like views over a vault's notes, as defined by Obsidian's
//! core Bases plugin (1.9+).
//!
//! * [`parse_base`] / [`serialize_base`] — the `.base` YAML format (also the
//!   body of a ```` ```base ```` code block), unknown keys preserved.
//! * [`eval`] — the expression language used by filters, formulas and
//!   summaries.
//! * [`run_view`] — filter, compute formulas, sort, limit, group and summarise
//!   one view into a [`ViewResult`] the UI renders.
//!
//! Values follow the `Value` class hierarchy of `obsidian.d.ts` and serialise
//! with a `type` tag (see [`Value`]). Positions in errors are UTF-16 code
//! units. See `NOTES.md` for the research behind every behaviour.

pub mod datetime;
mod error;
mod eval;
pub mod expr;
mod record;
mod schema;
mod value;
mod view;

pub use error::{BaseError, ErrorKind};
pub use eval::{escape_html, eval, sort_cmp, EvalContext};
pub use expr::parse_expression;
pub use record::{json_to_value, link_value_from_text, split_link, FileRecord};
pub use schema::{
    parse_base, parse_yaml, serialize_base, stringify_yaml, validate_base, BaseFile, Direction,
    FilterNode, GroupBy, PropertyConfig, SortConfig, ViewConfig, YamlValue,
};
pub use value::{js_number_to_string, js_to_fixed, natural_cmp, OrderedMap, Value};
pub use view::{
    builtin_summary, default_display_name, display_name, normalize_property_id, parse_property_id,
    run_view, run_view_with, Column, Group, Row, RunOptions, ViewInfo, ViewResult,
};
