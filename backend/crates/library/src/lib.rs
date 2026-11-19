//! Сервис библиотеки: добавление артистов/альбомов/треков по MBID, удаление, импорт дискографии.
//!
//! Логика вынесена из HTTP-хендлеров, чтобы её могли использовать и API, и фоновые задачи.

mod error;
pub mod retry;
mod service;

pub use error::LibraryError;
pub use service::{
    enqueue_artist_image_in, enqueue_import_in, AddOutcome, ImportSummary, LibraryService,
    LibraryType, PlayOutcome, EXCLUDED_SECONDARY_TYPES,
};
