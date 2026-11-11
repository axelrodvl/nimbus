//! Доменные типы и конфигурация Nimbus.

pub mod activity;
pub mod config;
pub mod events;
pub mod jobs;
pub mod model;
pub mod settings;

pub use config::{Config, ConfigError};
pub use settings::Settings;
