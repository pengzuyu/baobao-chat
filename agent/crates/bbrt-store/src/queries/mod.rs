//! 按域拆分的查询模块（D11 §2.8 queries/）。
//!
//! 行结构体在各域文件定义并在此统一 re-export 到 crate 根；
//! Store 的分域方法（`impl Store`）也挂在各域文件，本模块只做聚合。

mod context;
mod event;
mod grant;
mod run;
mod search;
mod session;
mod violation;
mod workspace;

pub use context::ContextRow;
pub use event::EventRow;
pub use grant::GrantRow;
pub use run::RunRow;
pub use search::{EventHit, EventWindow, SessionBrief, SessionMeta};
pub use session::{SessionListRow, SessionRow};
pub use violation::ViolationRow;
pub use workspace::Workspace;
