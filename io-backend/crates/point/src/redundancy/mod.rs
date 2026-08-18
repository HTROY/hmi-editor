mod engine;
mod state;

pub use engine::{
    ClaimBody, ClaimResult, ConfigPushBody, HeartbeatInfo, RedundancyEngine, RoleCommand, SyncBody,
};
pub use hmi_io_config::NodeRole as Role;
pub use state::{
    decide_initial_state, required_stable_beats, should_promote_unhealthy, HeartbeatDecision,
    NodeState, PeerStatus, RedundancyEvent, RedundancyState, RedundancyStatus, SyncStats,
    MAX_EVENTS,
};
