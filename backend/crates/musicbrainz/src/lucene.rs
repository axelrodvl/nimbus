/// Экранирует спецсимволы Lucene: `+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /`.
/// (`&` и `|` экранируются поодиночке — этого достаточно для `&&` и `||`.)
pub fn lucene_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if matches!(
            c,
            '+' | '-'
                | '&'
                | '|'
                | '!'
                | '('
                | ')'
                | '{'
                | '}'
                | '['
                | ']'
                | '^'
                | '"'
                | '~'
                | '*'
                | '?'
                | ':'
                | '\\'
                | '/'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Строит запрос для поиска «по мере ввода»: экранированные термы через пробел,
/// к последнему терму длиной ≥ 3 добавляется `*`. Пустой ввод → `None`.
pub fn search_query(input: &str) -> Option<String> {
    let terms: Vec<&str> = input.split_whitespace().collect();
    if terms.is_empty() {
        return None;
    }
    let last = terms.len() - 1;
    let parts: Vec<String> = terms
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let mut e = lucene_escape(t);
            if i == last && t.chars().count() >= 3 {
                e.push('*');
            }
            e
        })
        .collect();
    Some(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_all_specials() {
        assert_eq!(lucene_escape("AC/DC"), "AC\\/DC");
        assert_eq!(lucene_escape("a+b-c"), "a\\+b\\-c");
        assert_eq!(lucene_escape("(x) [y] {z}"), "\\(x\\) \\[y\\] \\{z\\}");
        assert_eq!(lucene_escape("a && b || !c"), "a \\&\\& b \\|\\| \\!c");
        assert_eq!(lucene_escape("^\"~*?:\\"), "\\^\\\"\\~\\*\\?\\:\\\\");
        assert_eq!(lucene_escape("plain text ёж"), "plain text ёж");
    }

    #[test]
    fn query_wildcard_on_last_term() {
        assert_eq!(search_query("radio").as_deref(), Some("radio*"));
        assert_eq!(search_query("  ok  comp ").as_deref(), Some("ok comp*"));
        assert_eq!(search_query("ok co").as_deref(), Some("ok co"));
        assert_eq!(search_query("AC/DC").as_deref(), Some("AC\\/DC*"));
        assert_eq!(search_query("   "), None);
    }
}
