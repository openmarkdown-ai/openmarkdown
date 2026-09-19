//! Generated from knap 0.5.0 `engine.validate` by oracle/gen-validate.mjs.

use super::*;

fn codes(t: &str) -> Vec<String> {
    validate_template(t).into_iter().map(|d| d.code).collect()
}

#[test]
fn validate_0() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ title | upper }}"), expected, "{}", "{{ title | upper }}");
}

#[test]
fn validate_1() {
    let expected: Vec<String> = vec!["UNKNOWN_FILTER".to_string()];
    assert_eq!(codes("{{ title | uper }}"), expected, "{}", "{{ title | uper }}");
}

#[test]
fn validate_2() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | calc:\"%2\" }}"), expected, "{}", "{{ x | calc:\"%2\" }}");
}

#[test]
fn validate_3() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | calc }}"), expected, "{}", "{{ x | calc }}");
}

#[test]
fn validate_4() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | calc:\"+2\" }}"), expected, "{}", "{{ x | calc:\"+2\" }}");
}

#[test]
fn validate_5() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | date_modify:\"+1 fortnight\" }}"), expected, "{}", "{{ x | date_modify:\"+1 fortnight\" }}");
}

#[test]
fn validate_6() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | date_modify:\"+1 day\" }}"), expected, "{}", "{{ x | date_modify:\"+1 day\" }}");
}

#[test]
fn validate_7() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | replace:a:b }}"), expected, "{}", "{{ x | replace:a:b }}");
}

#[test]
fn validate_8() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | replace:\"a\":\"b\" }}"), expected, "{}", "{{ x | replace:\"a\":\"b\" }}");
}

#[test]
fn validate_9() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | slice:a,b }}"), expected, "{}", "{{ x | slice:a,b }}");
}

#[test]
fn validate_10() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | slice:1,2 }}"), expected, "{}", "{{ x | slice:1,2 }}");
}

#[test]
fn validate_11() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | sort:(\"n\",\"sideways\") }}"), expected, "{}", "{{ x | sort:(\"n\",\"sideways\") }}");
}

#[test]
fn validate_12() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | sort:desc }}"), expected, "{}", "{{ x | sort:desc }}");
}

#[test]
fn validate_13() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | nth:abc }}"), expected, "{}", "{{ x | nth:abc }}");
}

#[test]
fn validate_14() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | truncate }}"), expected, "{}", "{{ x | truncate }}");
}

#[test]
fn validate_15() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | truncate:limit }}"), expected, "{}", "{{ x | truncate:limit }}");
}

#[test]
fn validate_16() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | where:\"a\" }}"), expected, "{}", "{{ x | where:\"a\" }}");
}

#[test]
fn validate_17() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | object:entries }}"), expected, "{}", "{{ x | object:entries }}");
}

#[test]
fn validate_18() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | list:bullets }}"), expected, "{}", "{{ x | list:bullets }}");
}

#[test]
fn validate_19() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | highlight:pink }}"), expected, "{}", "{{ x | highlight:pink }}");
}

#[test]
fn validate_20() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | safe_name:dos }}"), expected, "{}", "{{ x | safe_name:dos }}");
}

#[test]
fn validate_21() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | map }}"), expected, "{}", "{{ x | map }}");
}

#[test]
fn validate_22() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | map:p => p.name }}"), expected, "{}", "{{ x | map:p => p.name }}");
}

#[test]
fn validate_23() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | template }}"), expected, "{}", "{{ x | template }}");
}

#[test]
fn validate_24() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | yaml:block }}"), expected, "{}", "{{ x | yaml:block }}");
}

#[test]
fn validate_25() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | yaml_property }}"), expected, "{}", "{{ x | yaml_property }}");
}

#[test]
fn validate_26() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | indent:-1 }}"), expected, "{}", "{{ x | indent:-1 }}");
}

#[test]
fn validate_27() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | round:-1 }}"), expected, "{}", "{{ x | round:-1 }}");
}

#[test]
fn validate_28() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | bold:\"~\" }}"), expected, "{}", "{{ x | bold:\"~\" }}");
}

#[test]
fn validate_29() {
    let expected: Vec<String> = vec!["PARSE_ERROR".to_string()];
    assert_eq!(codes("{% if x %}"), expected, "{}", "{% if x %}");
}

#[test]
fn validate_30() {
    let expected: Vec<String> = vec!["PARSE_ERROR".to_string(), "PARSE_ERROR".to_string()];
    assert_eq!(codes("{{ x "), expected, "{}", "{{ x ");
}

#[test]
fn validate_31() {
    let expected: Vec<String> = vec!["PARSE_ERROR".to_string(), "PARSE_ERROR".to_string()];
    assert_eq!(codes("{% for %}{% endfor %}"), expected, "{}", "{% for %}{% endfor %}");
}

#[test]
fn validate_32() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | hr:\"middle\" }}"), expected, "{}", "{{ x | hr:\"middle\" }}");
}

#[test]
fn validate_33() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | code:\"a`b\" }}"), expected, "{}", "{{ x | code:\"a`b\" }}");
}

#[test]
fn validate_34() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | nth:1,2:0 }}"), expected, "{}", "{{ x | nth:1,2:0 }}");
}

#[test]
fn validate_35() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | sum:\"a..b\" }}"), expected, "{}", "{{ x | sum:\"a..b\" }}");
}

#[test]
fn validate_36() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | where:(\"\", 1) }}"), expected, "{}", "{{ x | where:(\"\", 1) }}");
}

#[test]
fn validate_37() {
    let expected: Vec<String> = vec!["INVALID_FILTER_ARGUMENTS".to_string()];
    assert_eq!(codes("{{ x | truncatewords:(2,\"…\",\"x\") }}"), expected, "{}", "{{ x | truncatewords:(2,\"…\",\"x\") }}");
}

#[test]
fn validate_38() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | replace:(\"a\":\"b\",\"/c/g\":\"d\") }}"), expected, "{}", "{{ x | replace:(\"a\":\"b\",\"/c/g\":\"d\") }}");
}

#[test]
fn validate_39() {
    let expected: Vec<String> = vec!["UNKNOWN_FILTER".to_string()];
    assert_eq!(codes("{% if a %}{{ b | frob }}{% endif %}"), expected, "{}", "{% if a %}{{ b | frob }}{% endif %}");
}

#[test]
fn validate_40() {
    let expected: Vec<String> = vec![];
    assert_eq!(codes("{{ x | list }}"), expected, "{}", "{{ x | list }}");
}
