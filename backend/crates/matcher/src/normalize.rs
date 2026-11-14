//! Нормализация строк и сходство названий.

use std::sync::OnceLock;

use regex::Regex;

/// Две нормализованные формы: без транслитерации кириллицы и полностью транслитерированная.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Norm {
    pub plain: String,
    pub translit: String,
}

impl Norm {
    pub fn is_empty(&self) -> bool {
        self.plain.is_empty()
    }
}

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("valid regex"))
}

fn is_cyrillic(c: char) -> bool {
    ('\u{0400}'..='\u{04FF}').contains(&c)
}

/// Нижний регистр, без «шумовых» скобок (remaster, bonus, live, feat…), `&` → `and`,
/// без апострофов (`don't` → `dont`).
fn strip_noise(s: &str) -> String {
    static BRACKETS: OnceLock<Regex> = OnceLock::new();
    static FEAT: OnceLock<Regex> = OnceLock::new();
    let lower = s.to_lowercase();
    let t = re(
        &BRACKETS,
        r"[\(\[][^\)\]]*?(remaster|bonus|live|feat|ft\.|explicit|version|mono|stereo)[^\)\]]*[\)\]]",
    )
    .replace_all(&lower, " ");
    let t = re(&FEAT, r"\s(feat\.?|ft\.|featuring)\s.*$").replace(&t, "");
    t.replace('&', " and ")
        .chars()
        .filter(|c| !matches!(c, '\'' | '’' | '‘' | '`' | '´'))
        .collect()
}

fn squash(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn norm(s: &str) -> Norm {
    let t = strip_noise(s);
    let plain: String = t
        .chars()
        .map(|c| {
            if is_cyrillic(c) {
                if c == 'ё' {
                    'е'.to_string()
                } else {
                    c.to_string()
                }
            } else if c.is_ascii() {
                c.to_string()
            } else {
                deunicode::deunicode_char(c).unwrap_or(" ").to_lowercase()
            }
        })
        .collect();
    Norm {
        plain: squash(&plain),
        translit: squash(&deunicode::deunicode(&t).to_lowercase()),
    }
}

fn token_set(a: &str, b: &str) -> f32 {
    let ta: Vec<&str> = a.split(' ').collect();
    let tb: Vec<&str> = b.split(' ').collect();
    let inter = ta.iter().filter(|t| tb.contains(t)).count();
    if inter == 0 {
        return strsim::normalized_levenshtein(a, b) as f32;
    }
    let (small, large) = if ta.len() <= tb.len() {
        (&ta, &tb)
    } else {
        (&tb, &ta)
    };
    if small.iter().all(|t| large.contains(t)) {
        // Одно название — часть другого («airbag» ↔ «radiohead airbag»).
        return 0.6 + 0.4 * small.len() as f32 / large.len() as f32;
    }
    let mut common: Vec<&str> = ta.iter().copied().filter(|t| tb.contains(t)).collect();
    common.sort_unstable();
    let mut d1: Vec<&str> = ta.iter().copied().filter(|t| !tb.contains(t)).collect();
    let mut d2: Vec<&str> = tb.iter().copied().filter(|t| !ta.contains(t)).collect();
    d1.sort_unstable();
    d2.sort_unstable();
    let t1 = [common.clone(), d1].concat().join(" ");
    let t2 = [common, d2].concat().join(" ");
    strsim::normalized_levenshtein(&t1, &t2) as f32
}

fn sim_str(a: &str, b: &str) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    // Jaro–Winkler даёт ~0.5–0.6 даже для несвязанных слов: растягиваем [0.6, 1] в [0, 1].
    let jw = ((strsim::jaro_winkler(a, b) as f32 - 0.6) / 0.4).clamp(0.0, 1.0);
    jw.max(token_set(a, b))
}

/// Сходство двух названий: максимум по обычной и транслитерированной формам.
pub fn similarity(a: &Norm, b: &Norm) -> f32 {
    sim_str(&a.plain, &b.plain).max(sim_str(&a.translit, &b.translit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization() {
        assert_eq!(norm("Don't Stop (Remastered 2009)").plain, "dont stop");
        assert_eq!(norm("Dont Stop").plain, "dont stop");
        assert_eq!(norm("Song feat. Someone Else").plain, "song");
        assert_eq!(norm("Song (feat. X) [Bonus Track]").plain, "song");
        assert_eq!(norm("Simon & Garfunkel").plain, "simon and garfunkel");
        assert_eq!(norm("Beyoncé – Déjà Vu").plain, "beyonce deja vu");
        assert_eq!(norm("  AC/DC!!  ").plain, "ac dc");
        // Кириллица не транслитерируется, но вариант с транслитерацией есть.
        let n = norm("Группа Крови (Remastered)");
        assert_eq!(n.plain, "группа крови");
        assert_eq!(n.translit, "gruppa krovi");
        assert_eq!(norm("Ёлки").plain, "елки");
    }

    #[test]
    fn similarity_cases() {
        let s = |a: &str, b: &str| similarity(&norm(a), &norm(b));
        assert!(s("Airbag", "airbag") > 0.99);
        assert!(s("Don't Stop", "Dont Stop") > 0.99);
        assert!(s("Airbag", "Radiohead - Airbag") >= 0.8);
        assert!(s("Airbag", "Paranoid Android") < 0.6);
        // Один и тот же текст кириллицей и латиницей.
        assert!(s("Группа крови", "Gruppa krovi") > 0.95);
        assert_eq!(s("", "x"), 0.0);
    }
}

#[cfg(test)]
mod props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        /// Нормализованная строка нормализуется в себя же.
        #[test]
        fn norm_is_idempotent(s in ".{0,60}") {
            let n = norm(&s);
            prop_assert_eq!(norm(&n.plain).plain, n.plain.clone());
            prop_assert_eq!(norm(&n.translit).translit, n.translit.clone());
        }
    }
}
