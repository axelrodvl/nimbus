//! `GET /api/tracks/{id}/audio-info`: формат и параметры исходного аудио (для строки качества в плеере).
//! Расширение известно всегда; остальное определяет `ffmpeg -i` (если он есть).

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use nimbus_core::model::TrackStatus;
use nimbus_db::repo::{torrents, track_sources, tracks};
use serde::Serialize;
use tokio::process::Command;
use utoipa::ToSchema;

use crate::auth::authorize;
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Default, Clone, PartialEq, Serialize, ToSchema)]
pub struct AudioInfo {
    /// Расширение исходного файла (`flac`, `mp3`, …).
    pub ext: String,
    /// Кодек (`flac`, `mp3`, `aac`, `alac`, `pcm_s24le`, …).
    pub codec: Option<String>,
    /// Частота дискретизации, Гц.
    pub sample_rate: Option<u32>,
    /// Разрядность (только для lossless/PCM).
    pub bit_depth: Option<u32>,
    /// Каналы: `mono`, `stereo`, `5.1`, …
    pub channels: Option<String>,
    /// Битрейт, кбит/с.
    pub bitrate_kbps: Option<u32>,
    /// Играет через перекодирование на лету (в браузер уходит FLAC).
    pub transcoded: bool,
}

/// Разбор stderr `ffmpeg -i`: строка `Stream #0:0: Audio: flac, 44100 Hz, stereo, s16 (24 bit), 900 kb/s`.
pub fn parse_ffmpeg_info(stderr: &str) -> AudioInfo {
    let mut info = AudioInfo::default();
    let container_kbps = stderr.lines().find_map(|l| {
        let (_, rest) = l.split_once("bitrate: ")?;
        rest.split_whitespace().next()?.parse::<u32>().ok()
    });
    let Some(line) = stderr.lines().find(|l| l.contains("Audio: ")) else {
        return info;
    };
    let after = line.split_once("Audio: ").map(|x| x.1).unwrap_or("");
    let parts: Vec<&str> = after.split(", ").map(str::trim).collect();
    info.codec = parts
        .first()
        .and_then(|c| c.split([' ', '(']).next())
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    for p in &parts[1..] {
        if let Some(hz) = p.strip_suffix(" Hz") {
            info.sample_rate = hz.parse().ok();
        } else if let Some(k) = p.strip_suffix(" kb/s") {
            info.bitrate_kbps = k.parse().ok();
        } else if matches!(*p, "mono" | "stereo") || p.contains("channels") || p.contains('.') {
            let ch = p
                .split('(')
                .next()
                .unwrap_or(p)
                .trim()
                .replace(" channels", "");
            info.channels = Some(ch);
        } else if p.starts_with('s')
            || p.starts_with('u')
            || p.starts_with("flt")
            || p.starts_with("dbl")
        {
            // s16, s32 (24 bit), fltp, s16p…
            info.bit_depth = p
                .split_once('(')
                .and_then(|(_, r)| r.split_whitespace().next()?.parse().ok())
                .or_else(|| {
                    let digits: String = p
                        .trim_start_matches(|c: char| c.is_ascii_alphabetic())
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect();
                    if p.starts_with("flt") || p.starts_with("dbl") {
                        None
                    } else {
                        digits.parse().ok()
                    }
                });
        }
    }
    if info.bitrate_kbps.is_none() {
        info.bitrate_kbps = container_kbps;
    }
    info
}

#[utoipa::path(
    get,
    path = "/api/tracks/{id}/audio-info",
    tag = "library",
    params(("id" = i64, Path, description = "ID трека")),
    responses(
        (status = 200, description = "Параметры исходного аудио", body = AudioInfo),
        (status = 404, description = "Нет такого трека", body = crate::error::ErrorResponse),
        (status = 409, description = "Трек не играбелен (`track_not_playable`)", body = crate::error::ErrorResponse),
    )
)]
pub async fn audio_info(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<AudioInfo>, ApiError> {
    authorize(&state, &headers)?;
    let track = tracks::get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("track not found"))?;
    let playable = matches!(track.status, TrackStatus::Found | TrackStatus::Ready);
    let source = if playable {
        track_sources::primary_for_track(&state.db, id).await?
    } else {
        None
    };
    let Some(source) = source else {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "track_not_playable",
            "no playable source",
        ));
    };
    let torrent = torrents::get(&state.db, source.torrent_id)
        .await?
        .ok_or_else(ApiError::internal)?;
    let file = torrents::files(&state.db, source.torrent_id)
        .await?
        .into_iter()
        .find(|f| f.file_index == source.file_index)
        .ok_or_else(ApiError::internal)?;
    let ext = file
        .ext
        .clone()
        .or_else(|| {
            file.path
                .rsplit_once('.')
                .map(|(_, e)| e.to_ascii_lowercase())
        })
        .unwrap_or_default();
    let transcoded = crate::stream::direct_mime(&ext).is_none() || source.cue_start_ms.is_some();

    let mut info = AudioInfo::default();
    let tc = &state.transcoder;
    if tc.available {
        let size = file.size_bytes.max(0) as u64;
        if let Ok(input) = crate::transcode::resolve_input(&state, &source, &torrent, size).await {
            let out = tokio::time::timeout(
                Duration::from_secs(15),
                Command::new(&tc.ffmpeg)
                    .args(["-hide_banner", "-nostdin", "-i", &input])
                    .kill_on_drop(true)
                    .output(),
            )
            .await;
            if let Ok(Ok(out)) = out {
                info = parse_ffmpeg_info(&String::from_utf8_lossy(&out.stderr));
            }
        }
    }
    info.ext = ext;
    info.transcoded = transcoded;
    Ok(Json(info))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flac_24bit() {
        let s = "  Duration: 00:04:10.00, start: 0.000000, bitrate: 1011 kb/s\n  Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)\n";
        let i = parse_ffmpeg_info(s);
        assert_eq!(i.codec.as_deref(), Some("flac"));
        assert_eq!(i.sample_rate, Some(96000));
        assert_eq!(i.bit_depth, Some(24));
        assert_eq!(i.channels.as_deref(), Some("stereo"));
        assert_eq!(i.bitrate_kbps, Some(1011));
    }

    #[test]
    fn parses_mp3() {
        let s = "  Duration: 00:03:00.00, start: 0.025057, bitrate: 322 kb/s\n  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s\n";
        let i = parse_ffmpeg_info(s);
        assert_eq!(i.codec.as_deref(), Some("mp3"));
        assert_eq!(i.sample_rate, Some(44100));
        assert_eq!(i.bit_depth, None);
        assert_eq!(i.bitrate_kbps, Some(320));
    }

    #[test]
    fn parses_16bit_and_surround() {
        let s = "  Stream #0:0: Audio: flac, 44100 Hz, 5.1(side), s16\n";
        let i = parse_ffmpeg_info(s);
        assert_eq!(i.bit_depth, Some(16));
        assert_eq!(i.channels.as_deref(), Some("5.1"));
    }

    #[test]
    fn no_audio_line() {
        assert_eq!(parse_ffmpeg_info("garbage"), AudioInfo::default());
    }
}
