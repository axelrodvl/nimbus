# Шаг 16 — Matcher: сопоставление файлов с треками

**Зависит от:** 03
**Оценка:** 1.5–2 дня

## Цель

Чистый (без I/O) крейт `matcher`: по списку файлов раздачи и треклисту альбома найти для каждого трека самый подходящий аудиофайл с оценкой уверенности. Плюс разбор CUE-файлов (используется в шаге 21). Качество этого крейта определяет, насколько часто треки будут `found`, поэтому — много тестов на реальных структурах раздач.

## Что сделать

### 1. Входы и выходы

```rust
pub struct FileInput { pub index: usize, pub path: String, pub size: u64 }     // path через '/'
pub struct TrackInput { pub id: i64, pub title: String, pub disc_no: i32, pub position: i32, pub duration_ms: Option<i32> }
pub struct AlbumInput<'a> { pub artist: &'a str, pub title: &'a str, pub year: Option<i32>, pub total_discs: i32, pub tracks: &'a [TrackInput] }

pub struct MatchResult { pub track_id: i64, pub file_index: usize, pub score: f32, pub needs_confirmation: bool }

pub struct MatchConfig { pub accept: f32 /*0.80*/, pub confirm: f32 /*0.65*/, pub prefer: FormatPrefs }

pub fn match_album(files: &[FileInput], album: &AlbumInput, cfg: &MatchConfig) -> MatchOutcome;

pub struct MatchOutcome {
    pub matches: Vec<MatchResult>,          // score >= confirm; needs_confirmation = score < accept
    pub unmatched_track_ids: Vec<i64>,
    pub cue_candidates: Vec<CueCandidate>,  // «образ + cue» — разберёт шаг 21
}
pub struct CueCandidate { pub cue_file_index: usize, pub image_file_index: usize, pub dir: String }
```

### 2. Алгоритм

1. **Фильтр аудио:** расширения `flac, mp3, m4a, aac, ogg, opus, ape, wv, wav, aiff, alac, dsf, dff`. Остальное (`jpg, log, cue, txt, nfo, m3u`) — игнорировать (но `.cue` запомнить для п. 6).
2. **Группировка по каталогам** (каталог = путь без имени файла). Для дискографий каталогов десятки — сначала выбираем **каталог альбома**:
   - `dir_score = sim(normalize(последние 1–2 компонента пути), normalize(album.title))` + бонус за год в имени + бонус, если число аудиофайлов в каталоге ≈ числу треков (±2);
   - многодисковые: каталоги вида `CD1`, `CD 2`, `Disc 1`, `Disk2` — объединяются с родительским каталогом, номер диска берётся из имени.
   - Рассматривать до 3 лучших каталогов-кандидатов (порог `dir_score ≥ 0.5`), а если альбомный торрент (все файлы в одном каталоге) — единственный каталог.
3. **Разбор имени файла** (без расширения) регулярками, по порядку:
   - `^(?P<disc>\d)[-.](?P<track>\d{1,2})[\s._-]+(?P<title>.+)$` → `1-01 Title`;
   - `^(?P<track>\d{1,3})[\s._-]+(?:(?P<artist>.+?)\s+-\s+)?(?P<title>.+)$` → `01 - Title`, `01. Title`, `01 Artist - Title`;
   - `^(?P<artist>.+?)\s+-\s+(?P<track>\d{1,3})\s+-\s+(?P<title>.+)$` → `Artist - 01 - Title`;
   - иначе `title = имя целиком`, `track = None`.
   Номер `track` > 100 вида `101` трактовать как диск 1 трек 01, если в альбоме несколько дисков.
4. **Нормализация** строк: нижний регистр, NFKD + удаление диакритики (`deunicode` для латиницы; кириллицу **не** транслитерировать, но сравнивать и вариант с транслитерацией — берём максимум), удалить содержимое скобок с ключевыми словами (`remaster`, `bonus`, `live`, `feat`, `ft.`, `explicit`, `version`, `mono`, `stereo`), `&`→`and`, пунктуацию → пробел, схлопнуть пробелы.
5. **Оценка пары (track, file):**
   ```
   score = 0.60 * title_sim
         + 0.20 * pos_match        // 1.0 если disc и track совпали; 0.5 если совпал только track при однодисковом
         + 0.10 * dir_score
         + 0.10 * format_pref       // из FormatPrefs, 0..1
   ```
   `title_sim = max(jaro_winkler, token_set_ratio)`. Если `title_sim < 0.5` и `pos_match == 1.0` при правильном числе файлов в каталоге — `score = max(score, 0.7)` (файлы без названий: `01.flac`, `Track01.flac`) с `needs_confirmation`.
   Длительность в файлах неизвестна; размер файла можно грубо проверить: для FLAC ~5–10 МБ/мин, для MP3 320 ~2.4 МБ/мин — штраф −0.1, если оценка длительности расходится с `duration_ms` более чем вдвое (опционально).
6. **Назначение:** жадно по убыванию score, каждый файл и каждый трек — не более одного раза (опционально — венгерский алгоритм, крейт `pathfinding::kuhn_munkres`, если жадный даёт ошибки на тестах). Если в каталоге несколько форматов одного альбома (FLAC и MP3) — за счёт `format_pref` выиграет предпочтительный.
7. **CUE:** если в выбранном каталоге 1–3 больших аудиофайла и `.cue` с тем же базовым именем (или единственный `.cue`), а треков в альбоме больше → добавить `CueCandidate`, треки оставить в `unmatched`.

### 3. Разбор CUE (`matcher::cue`)

```rust
pub struct CueSheet { pub performer: Option<String>, pub title: Option<String>, pub files: Vec<CueFile> }
pub struct CueFile { pub name: String, pub tracks: Vec<CueTrack> }
pub struct CueTrack { pub number: u32, pub title: Option<String>, pub performer: Option<String>, pub start_ms: u32 } // INDEX 01 mm:ss:ff (ff = 1/75 c)
pub fn parse_cue(bytes: &[u8]) -> Result<CueSheet, CueError>;   // UTF-8 с BOM, иначе cp1251 (частый случай для RU-раздач)
pub fn match_cue(sheet: &CueSheet, album: &AlbumInput) -> Vec<CueMatch>;  // track_id → (file name, start_ms, end_ms: Option)
```
`end_ms` трека = `start_ms` следующего в том же FILE, для последнего — `None` (до конца файла).

## Тесты (главное в этом шаге)

Фикстуры в `crates/matcher/tests/fixtures/*.json` — списки путей и треклисты. Минимум 12 сценариев:
1. Альбомная раздача FLAC: `Radiohead - OK Computer (1997) [FLAC]/01 - Airbag.flac` … + `cover.jpg`, `.log`, `.cue`.
2. То же, MP3 с `01. Radiohead - Airbag.mp3`.
3. Дискография: `Radiohead - Discography/1997 - OK Computer/…`, `/2000 - Kid A/…` — выбирается правильный каталог.
4. Дискография с вложенностью `Studio Albums/1997 - OK Computer [24bit]/` и `Singles/`.
5. Многодисковый: `CD1/01 …`, `CD2/01 …` и вариант `1-01 Title.flac`.
6. Файлы без названий: `01.flac … 12.flac`.
7. Кириллица: «Кино - Группа крови (1988)/01. Группа крови.flac».
8. Названия с `(Remastered 2009)`, `feat.`, разной пунктуацией/кавычками (`Don't` vs `Dont`).
9. В одном торренте FLAC и MP3 версии — выбирается FLAC по prefs.
10. Образ + CUE (`OK Computer.flac` + `OK Computer.cue`) → `CueCandidate`, треки не сопоставлены.
11. Чужой альбом (ничего не подходит) → все треки `unmatched`.
12. Делюкс-издание с бонус-треками в раздаче — основные треки сопоставлены, лишние файлы проигнорированы.
- Unit: регулярки разбора имени, нормализация, `parse_cue` (UTF-8 BOM и cp1251, `INDEX 01 04:32:45` → 272600 мс), `match_cue`.

## Критерии приёмки

- `cargo test -p matcher` — все сценарии проходят; precision на фикстурах 100% (ни одного неверного сопоставления с `score >= accept`).
- `just backend-check` проходит.

## Вне рамок шага

I/O, БД, librqbit — matcher остаётся чистым.
