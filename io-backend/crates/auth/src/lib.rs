pub mod model;
pub mod seed;
pub mod service;

pub use model::{AuthError, AuthUser, Claims, LoginOutcome, Role, TokenPair};
pub use seed::ensure_admin_seeded;
pub use service::AuthService;
