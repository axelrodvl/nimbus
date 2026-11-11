use crate::types::SearchQuery;

/// Убирает хвостовые/внутренние скобочные суффиксы: `(Deluxe Edition)`, `[Remastered]`.
pub fn strip_brackets(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0u32;
    for ch in s.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn and(s: &str) -> String {
    s.replace(" & ", " and ").replace('&', " and ")
}

fn join(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.trim())
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Варианты поисковых строк для альбома (используется шагом 14). Без транслитерации.
pub fn build_queries(artist: &str, album: &str, year: Option<i32>) -> Vec<SearchQuery> {
    let album = strip_brackets(album);
    let artist = artist.trim();
    let structured = |text: String| SearchQuery {
        text,
        artist: Some(artist.to_string()),
        album: Some(album.clone()).filter(|a| !a.is_empty()),
        year,
        broad: false,
    };

    let mut out: Vec<SearchQuery> = Vec::new();
    let mut push = |q: SearchQuery| {
        if !q.text.is_empty() && !out.iter().any(|e| e.text.eq_ignore_ascii_case(&q.text)) {
            out.push(q);
        }
    };

    push(structured(join(&[artist, &album])));
    match year {
        // Во второй вариации «&» заменяется на «and».
        Some(y) => push(structured(and(&join(&[artist, &album, &y.to_string()])))),
        None => push(structured(and(&join(&[artist, &album])))),
    }
    push(SearchQuery {
        text: join(&[artist, "discography"]),
        artist: Some(artist.to_string()),
        ..SearchQuery::default()
    });
    push(SearchQuery {
        text: join(&[artist]),
        artist: Some(artist.to_string()),
        broad: true,
        ..SearchQuery::default()
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(q: &[SearchQuery]) -> Vec<&str> {
        q.iter().map(|q| q.text.as_str()).collect()
    }

    #[test]
    fn strips_brackets() {
        assert_eq!(
            strip_brackets("OK Computer (Deluxe Edition) [Remastered]"),
            "OK Computer"
        );
        assert_eq!(strip_brackets("A (b (c)) d"), "A d");
    }

    #[test]
    fn full_set() {
        let q = build_queries("Radiohead", "OK Computer [Remastered]", Some(1997));
        assert_eq!(
            texts(&q),
            [
                "Radiohead OK Computer",
                "Radiohead OK Computer 1997",
                "Radiohead discography",
                "Radiohead"
            ]
        );
        assert!(q[3].broad && !q[0].broad);
        assert_eq!(q[0].album.as_deref(), Some("OK Computer"));
    }

    #[test]
    fn ampersand_only_in_second_variation_and_no_year() {
        let q = build_queries("Simon & Garfunkel", "Bookends", Some(1968));
        assert_eq!(q[0].text, "Simon & Garfunkel Bookends");
        assert_eq!(q[1].text, "Simon and Garfunkel Bookends 1968");
        let q = build_queries("Simon & Garfunkel", "Bookends", None);
        assert_eq!(q[1].text, "Simon and Garfunkel Bookends");
        // Без & и без года вариации совпадают — дубликат не добавляется.
        let q = build_queries("Radiohead", "Kid A", None);
        assert_eq!(
            texts(&q),
            ["Radiohead Kid A", "Radiohead discography", "Radiohead"]
        );
    }

    #[test]
    fn keeps_cyrillic() {
        let q = build_queries("Кино", "Группа крови", Some(1988));
        assert_eq!(q[0].text, "Кино Группа крови");
    }
}
