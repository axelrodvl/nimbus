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

#[cfg(test)]
mod props {
    use super::*;
    use proptest::prelude::*;

    const SPECIAL: &str = "+-&|!(){}[]^\"~*?:\\/";

    proptest! {
        /// Каждый спецсимвол в результате предварён обратной косой чертой.
        #[test]
        fn no_unescaped_specials(s in ".{0,60}") {
            let out: Vec<char> = lucene_escape(&s).chars().collect();
            let mut i = 0;
            while i < out.len() {
                if out[i] == '\\' {
                    prop_assert!(i + 1 < out.len(), "dangling backslash");
                    prop_assert!(SPECIAL.contains(out[i + 1]));
                    i += 2;
                } else {
                    prop_assert!(!SPECIAL.contains(out[i]), "unescaped {:?}", out[i]);
                    i += 1;
                }
            }
        }

        /// Без спецсимволов строка не меняется; убрав экранирование, получаем исходную.
        #[test]
        fn unescape_restores_input(s in ".{0,60}") {
            let esc = lucene_escape(&s);
            let mut back = String::new();
            let mut it = esc.chars();
            while let Some(c) = it.next() {
                if c == '\\' { back.push(it.next().unwrap()); } else { back.push(c); }
            }
            prop_assert_eq!(back, s);
        }

        #[test]
        fn search_query_never_panics(s in ".{0,60}") {
            let q = search_query(&s);
            prop_assert_eq!(q.is_none(), s.split_whitespace().next().is_none());
        }
    }
}
