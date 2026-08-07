//! Alarm & SOE engine
//!
//! Computes alarm occurrences and SOE records from point value updates on the
//! Active node. The engine itself is IO-free: it emits [`OutEvent`]s that the
//! persister task writes to SQLite and broadcasts over WebSocket.

pub mod engine;
pub mod persist;
pub mod types;

pub use engine::AlarmEngine;
pub use types::{
    AlarmOccurrence, AlarmRule, AlarmStreamEvent, Condition, OccurrenceStatus, OutEvent,
    Severity, SoeRecord, StreamEventType,
};
