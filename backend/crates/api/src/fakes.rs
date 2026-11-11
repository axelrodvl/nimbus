//! Режим `NIMBUS_FAKE_EXTERNAL=true` (фича `test-fakes`, только для e2e): вместо внешних сервисов
//! поднимается локальный HTTP-сервер с фикстурами MusicBrainz и Torznab-выдачей из одной раздачи,
//! а раздачу отдаёт локальный сидер librqbit. Детерминированно и без сети.

use std::net::SocketAddr;
use std::path::Path;

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use nimbus_torrent::fake_swarm::{self, FakeSwarm};
use serde::Deserialize;

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../musicbrainz/tests/fixtures/",
            $name
        ))
    };
}

/// Треки фикстуры `release.json` (OK Computer).
const TRACKS: [&str; 4] = [
    "Airbag",
    "Paranoid Android",
    "Subterranean Homesick Alien",
    "Lift",
];

pub struct Fakes {
    /// База MusicBrainz API (`…/ws/2/`).
    pub mb_base: String,
    pub torznab_url: String,
    /// Адрес сидера — единственный пир для всех торрентов.
    pub peer: SocketAddr,
    _swarm: FakeSwarm,
}

/// Моно 16-bit PCM WAV с синусом 440 Гц.
pub fn sine_wav(seconds: u32) -> Vec<u8> {
    const RATE: u32 = 22_050;
    let samples = RATE * seconds;
    let data_len = samples * 2;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for i in 0..samples {
        let t = i as f32 / RATE as f32;
        let v = (t * 440.0 * std::f32::consts::TAU).sin() * 0.3;
        out.extend_from_slice(&((v * i16::MAX as f32) as i16).to_le_bytes());
    }
    out
}

pub async fn start(work_dir: &Path) -> anyhow::Result<Fakes> {
    let files: Vec<(String, Vec<u8>)> = TRACKS
        .iter()
        .enumerate()
        .map(|(i, t)| (format!("{:02} - {t}.wav", i + 1), sine_wav(8)))
        .collect();
    let swarm = fake_swarm::start(&work_dir.join("fake-swarm"), "OK Computer", &files).await?;

    let app = Router::new()
        .route("/ws/2/{*path}", get(mb))
        .route("/torznab/api", get(torznab))
        .with_state(swarm.magnet.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tracing::warn!(%addr, peer = %swarm.addr, "NIMBUS_FAKE_EXTERNAL: fake MusicBrainz/Torznab and local seeder are running");
    Ok(Fakes {
        mb_base: format!("http://{addr}/ws/2/"),
        torznab_url: format!("http://{addr}/torznab"),
        peer: swarm.addr,
        _swarm: swarm,
    })
}

fn json(body: &'static str) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

#[derive(Deserialize)]
struct MbQuery {
    #[serde(rename = "release-group")]
    release_group: Option<String>,
    artist: Option<String>,
}

async fn mb(UrlPath(path): UrlPath<String>, Query(q): Query<MbQuery>) -> Response {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    match parts.as_slice() {
        ["artist"] => json(fixture!("search_artist.json")),
        ["artist", _] => json(fixture!("artist.json")),
        ["release-group"] if q.artist.is_some() => json(fixture!("artist_release_groups_p1.json")),
        ["release-group"] => json(fixture!("search_release_group.json")),
        ["release-group", _] => json(fixture!("release_group.json")),
        ["recording"] => json(fixture!("search_recording.json")),
        ["recording", _] => json(fixture!("recording_lookup.json")),
        ["release"] if q.release_group.is_some() => json(fixture!("releases_browse.json")),
        ["release", _] => json(fixture!("release.json")),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn torznab(State(magnet): State<String>) -> Response {
    let magnet = magnet.replace('&', "&amp;");
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Fake</title>
    <item>
      <title>Radiohead - OK Computer (1997) [FLAC]</title>
      <guid>fake-ok-computer</guid>
      <link>{magnet}</link>
      <size>2000000</size>
      <torznab:attr name="category" value="3040"/>
      <torznab:attr name="seeders" value="50"/>
      <torznab:attr name="peers" value="55"/>
    </item>
  </channel>
</rss>"#
    );
    ([(header::CONTENT_TYPE, "application/xml")], xml).into_response()
}
