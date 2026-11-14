//! Deterministic, seeded models of network protocols for teaching.
//!
//! Every model is a pure function from parameters (including a seed and any
//! edits the learner made to individual packets) to a full trace. The page
//! scrubs through the trace, so stepping back is exact and a shared link
//! reproduces the same run on any machine.

pub mod rdt;
pub mod sim;
