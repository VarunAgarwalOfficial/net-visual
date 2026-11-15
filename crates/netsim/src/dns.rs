//! Naming: how a name becomes an address. DNS resolution, iterative and
//! recursive, with the caches and TTLs that make it fast (RFC 1034, RFC 1035,
//! RFC 2181, RFC 2308).
//!
//! - The name space is a tree of zones. Each zone is served by a name server
//!   that knows its own records and, for each child zone it delegates, the
//!   child's name servers (NS records) and their addresses (glue).
//! - A stub resolver in each client asks one recursive resolver. In
//!   iterative resolution (RFC 1034 Section 5.3.3) the resolver walks down
//!   from the root itself: each server answers or refers it to a server
//!   closer to the name, and the resolver caches every referral, so the next
//!   name in the same zone skips the servers above. In recursive resolution
//!   as textbooks draw it, each server asks the next on the asker's behalf;
//!   the resolver then learns only the final answer, and the root sees every
//!   name the resolver has not cached.
//! - Every record carries a TTL. A cache keeps a record for exactly its TTL
//!   from the moment the record arrives, and hands on only what remains, so
//!   no copy downstream outlives the owner's promise. A name that does not
//!   exist is cached too (RFC 2308), for the smaller of the SOA record's TTL
//!   and its MINIMUM field.
//!
//! The model is exact given the queries; the only randomness is an optional
//! Poisson stream of queries drawn from the seed. The steps are lettered;
//! the trace names the step behind each event and the page highlights it in
//! this source.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::sim::Rng;

const S: u64 = 1_000_000;
/// Longest CNAME chain or referral walk followed before giving up.
const HOPS: usize = 16;

// ---------------------------------------------------------------------------
// Zone data and parameters
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RType {
    A,
    NS,
    CNAME,
}

/// A resource record. Names are absolute, with the trailing dot.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub name: String,
    pub rtype: RType,
    pub value: String,
    pub ttl_s: u32,
}

/// One zone and the one server that is authoritative for it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Zone {
    /// The zone's apex, such as "." or "example.com.".
    pub origin: String,
    /// The server's host name, as the parent's NS record names it.
    pub server: String,
    /// The round trip to this server from whoever asks it.
    pub rtt_us: u64,
    /// The zone's records, including the NS and glue A records of every
    /// child it delegates.
    pub records: Vec<Record>,
    /// The SOA record's own TTL and its MINIMUM field, which together bound
    /// how long a negative answer may be cached (RFC 2308 Section 5).
    pub soa_ttl_s: u32,
    pub soa_minimum_s: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Client {
    pub name: String,
    /// The round trip between the client and the recursive resolver.
    pub rtt_us: u64,
    /// Whether the client's stub resolver keeps a cache of its own.
    #[serde(default)]
    pub stub_cache: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuerySpec {
    pub at_us: u64,
    pub client: usize,
    pub name: String,
}

/// Queries arriving as a Poisson stream, each for a name and from a client
/// chosen uniformly at random.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Poisson {
    pub rate_per_s: f64,
    pub names: Vec<String>,
    pub until_us: u64,
}

/// The owner changes a name's address (and TTL) at a moment.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Change {
    pub at_us: u64,
    pub name: String,
    pub value: String,
    pub ttl_s: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Iterative,
    Recursive,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DnsParams {
    pub mode: Mode,
    pub zones: Vec<Zone>,
    pub clients: Vec<Client>,
    #[serde(default)]
    pub queries: Vec<QuerySpec>,
    #[serde(default)]
    pub poisson: Option<Poisson>,
    #[serde(default)]
    pub changes: Vec<Change>,
    #[serde(default)]
    pub seed: u64,
    /// Run at least this long, so that expiries after the last query show.
    #[serde(default)]
    pub end_us: u64,
    /// Record events, messages and cache entries; off for long sweeps.
    #[serde(default = "yes")]
    pub trace: bool,
}

fn yes() -> bool {
    true
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/// What a cache entry holds: a record set, or the fact that a name does not
/// exist (NXDOMAIN) or has no address (NODATA).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
pub enum Kind {
    A,
    NS,
    CNAME,
    NXDOMAIN,
    NODATA,
}

impl Kind {
    fn negative(self) -> bool {
        matches!(self, Kind::NXDOMAIN | Kind::NODATA)
    }
}

/// One record set placed in one cache. Nodes are numbered clients first,
/// then the resolver, then one per zone server.
#[derive(Clone, Debug, Serialize)]
pub struct CacheEntry {
    pub cache: usize,
    pub name: String,
    pub kind: Kind,
    pub values: Vec<String>,
    /// The TTL the record arrived with.
    pub ttl_us: u64,
    pub from_us: u64,
    /// Always `from_us + ttl_us`.
    pub expires_us: u64,
    /// The query whose resolution brought it.
    pub res: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct Msg {
    pub res: usize,
    pub from: usize,
    pub to: usize,
    pub send_us: u64,
    pub arrive_us: u64,
    /// query, referral, answer, cname, nxdomain, nodata.
    pub kind: &'static str,
    pub name: String,
    pub records: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DnsEvent {
    pub t: u64,
    pub step: &'static str,
    pub what: &'static str,
    pub res: usize,
    pub node: usize,
    pub msg: Option<usize>,
    pub entry: Option<usize>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Resolution {
    pub client: usize,
    pub name: String,
    pub at_us: u64,
    /// When the answer reached the client.
    pub done_us: u64,
    /// stub (the client's own cache), cache (the resolver's), joined (a
    /// resolution already under way), resolved (servers were asked).
    pub outcome: &'static str,
    pub answer: Vec<String>,
    pub negative: bool,
    /// The answer differs from what the owner's zone said at that moment.
    pub stale: bool,
    /// Zones asked, in order.
    pub servers: Vec<usize>,
    /// From the query reaching the resolver to its reply leaving.
    pub resolver_us: u64,
    /// The TTL handed to the client with the answer.
    pub ttl_us: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct DnsStats {
    pub queries: u64,
    pub stub_hits: u64,
    /// Queries that reached the resolver.
    pub resolver_queries: u64,
    pub resolver_hits: u64,
    pub joined: u64,
    pub misses: u64,
    pub negative_answers: u64,
    pub stale: u64,
    pub mean_latency_us: f64,
    /// Mean resolver time of the queries it had to resolve.
    pub mean_miss_us: f64,
    /// Queries each zone's server received.
    pub server_queries: Vec<u64>,
    /// Resolver hits over queries that reached the resolver.
    pub hit_ratio: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct DnsRun {
    pub nodes: Vec<String>,
    pub resolver: usize,
    pub events: Vec<DnsEvent>,
    pub messages: Vec<Msg>,
    pub entries: Vec<CacheEntry>,
    pub resolutions: Vec<Resolution>,
    pub stats: DnsStats,
    pub end_us: u64,
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/// Whether `name` is `origin` or lies below it.
pub fn under(name: &str, origin: &str) -> bool {
    origin == "." || name == origin || name.ends_with(&format!(".{origin}"))
}

/// The name one label up: "www.example.com." to "example.com.", "com." to ".".
pub fn parent(name: &str) -> Option<&str> {
    if name == "." {
        return None;
    }
    match name.find('.') {
        Some(i) if i + 1 < name.len() => Some(&name[i + 1..]),
        _ => Some("."),
    }
}

fn absolute(name: &str) -> bool {
    name.ends_with('.') && !name.contains("..") && name.len() <= 80
}

/// A record set on its way to a cache, with the TTL it carries.
#[derive(Clone, Debug)]
struct Rrset {
    name: String,
    kind: Kind,
    values: Vec<String>,
    ttl_us: u64,
}

fn rrset(name: &str, kind: Kind, rs: &[&Record]) -> Rrset {
    Rrset {
        name: name.to_string(),
        kind,
        values: rs.iter().map(|r| r.value.clone()).collect(),
        // RFC 2181 Section 5.2: one TTL per set; take the least if they differ.
        ttl_us: rs.iter().map(|r| r.ttl_s as u64).min().unwrap_or(0) * S,
    }
}

fn secs(us: u64) -> String {
    let s = us as f64 / 1e6;
    if us % S == 0 {
        format!("{} s", us / S)
    } else if s >= 10.0 {
        format!("{s:.1} s")
    } else {
        format!("{s:.3} s")
    }
}

fn show(set: &Rrset) -> Vec<String> {
    if set.kind.negative() {
        return vec![format!(
            "{} {:?}, cache {} (SOA)",
            set.name,
            set.kind,
            secs(set.ttl_us)
        )];
    }
    set.values
        .iter()
        .map(|v| format!("{} {:?} {} ({})", set.name, set.kind, v, secs(set.ttl_us)))
        .collect()
}

enum Next {
    Answer,
    Cname(String),
    Referral(usize),
    Negative,
}

struct Reply {
    sets: Vec<Rrset>,
    next: Next,
}

fn reply_kind(r: &Reply) -> &'static str {
    match &r.next {
        Next::Answer => "answer",
        Next::Cname(_) => "cname",
        Next::Referral(_) => "referral",
        Next::Negative => match r.sets.last().map(|s| s.kind) {
            Some(Kind::NODATA) => "nodata",
            _ => "nxdomain",
        },
    }
}

// ---------------------------------------------------------------------------
// Checking the zone data
// ---------------------------------------------------------------------------

pub fn check(p: &DnsParams) -> Result<(), String> {
    let zs = &p.zones;
    if zs.iter().filter(|z| z.origin == ".").count() != 1 {
        return Err("there is exactly one root zone, \".\"".into());
    }
    for (i, z) in zs.iter().enumerate() {
        if !absolute(&z.origin) || !absolute(&z.server) {
            return Err("names end with a dot".into());
        }
        if zs[..i].iter().any(|y| y.origin == z.origin) {
            return Err(format!("two zones are both {}", z.origin));
        }
        if z.rtt_us == 0 {
            return Err("a round trip takes some time".into());
        }
        for r in &z.records {
            if !absolute(&r.name) || !under(&r.name, &z.origin) {
                return Err(format!("{} does not belong in zone {}", r.name, z.origin));
            }
            if r.rtype == RType::NS && r.name != z.origin {
                let child = zs.iter().find(|c| c.origin == r.name);
                if child.is_none_or(|c| c.server != r.value) {
                    return Err(format!(
                        "{} delegates {} to {}, which serves no such zone",
                        z.origin, r.name, r.value
                    ));
                }
                if !z
                    .records
                    .iter()
                    .any(|g| g.rtype == RType::A && g.name == r.value)
                {
                    return Err(format!("{} has no glue for {}", z.origin, r.value));
                }
            }
        }
    }
    // Every zone but the root is delegated by its parent.
    for c in zs.iter().filter(|c| c.origin != ".") {
        let delegated = zs.iter().any(|z| {
            z.records
                .iter()
                .any(|r| r.rtype == RType::NS && r.name == c.origin && z.origin != c.origin)
        });
        if !delegated {
            return Err(format!("no zone delegates {}", c.origin));
        }
    }
    // CNAME chains end.
    for r in zs.iter().flat_map(|z| &z.records) {
        if r.rtype == RType::CNAME {
            let mut name = r.value.clone();
            let mut n = 0;
            while let Some(next) = zs
                .iter()
                .flat_map(|z| &z.records)
                .find(|x| x.rtype == RType::CNAME && x.name == name)
            {
                name = next.value.clone();
                n += 1;
                if n > 8 {
                    return Err(format!("the CNAME chain from {} does not end", r.name));
                }
            }
        }
    }
    if p.clients.is_empty() {
        return Err("at least one client".into());
    }
    if p.clients.iter().any(|c| c.rtt_us == 0) {
        return Err("a round trip takes some time".into());
    }
    for q in &p.queries {
        if q.client >= p.clients.len() || !absolute(&q.name) {
            return Err("a query comes from a client and names an absolute name".into());
        }
    }
    if let Some(ps) = &p.poisson {
        if ps.names.is_empty() || ps.names.iter().any(|n| !absolute(n)) || ps.rate_per_s <= 0.0 {
            return Err("a Poisson stream needs a rate and names".into());
        }
    }
    for c in &p.changes {
        let z = auth_zone(zs, &c.name);
        if !zs[z]
            .records
            .iter()
            .any(|r| r.rtype == RType::A && r.name == c.name)
        {
            return Err(format!("{} has no address to change", c.name));
        }
    }
    Ok(())
}

/// The zone whose server is authoritative for `name`: the deepest one that
/// holds it.
fn auth_zone(zs: &[Zone], name: &str) -> usize {
    (0..zs.len())
        .filter(|&i| under(name, &zs[i].origin))
        .max_by_key(|&i| zs[i].origin.len())
        .expect("the root holds every name")
}

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

struct Sim<'a> {
    p: &'a DnsParams,
    nc: usize,
    root: usize,
    trace: bool,
    entries: Vec<CacheEntry>,
    /// Entries of each (cache, name, kind), sorted by arrival.
    index: HashMap<(usize, String, Kind), Vec<usize>>,
    messages: Vec<Msg>,
    events: Vec<DnsEvent>,
    server_queries: Vec<u64>,
    /// Names the resolver is resolving now, and when it will have them.
    inflight: HashMap<String, u64>,
}

impl<'a> Sim<'a> {
    fn resolver(&self) -> usize {
        self.nc
    }

    fn server(&self, z: usize) -> usize {
        self.nc + 1 + z
    }

    fn name(&self, node: usize) -> &str {
        if node < self.nc {
            &self.p.clients[node].name
        } else if node == self.nc {
            "the resolver"
        } else {
            &self.p.zones[node - self.nc - 1].server
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn log(
        &mut self,
        t: u64,
        step: &'static str,
        what: &'static str,
        (res, node): (usize, usize),
        msg: Option<usize>,
        entry: Option<usize>,
        text: impl FnOnce(&Self) -> String,
    ) {
        if self.trace {
            let text = text(self);
            self.events.push(DnsEvent {
                t,
                step,
                what,
                res,
                node,
                msg,
                entry,
                text,
            });
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn send(
        &mut self,
        res: usize,
        from: usize,
        to: usize,
        at: u64,
        oneway: u64,
        kind: &'static str,
        name: &str,
        sets: &[Rrset],
    ) -> Option<usize> {
        if !self.trace {
            return None;
        }
        self.messages.push(Msg {
            res,
            from,
            to,
            send_us: at,
            arrive_us: at + oneway,
            kind,
            name: name.to_string(),
            records: sets.iter().flat_map(show).collect(),
        });
        Some(self.messages.len() - 1)
    }

    /// The zone's records for a name at time t, after the owner's changes.
    fn records(&self, z: usize, name: &str, t: u64) -> Vec<Record> {
        let mut out: Vec<Record> = self.p.zones[z]
            .records
            .iter()
            .filter(|r| r.name == name)
            .cloned()
            .collect();
        let change = self
            .p
            .changes
            .iter()
            .filter(|c| c.at_us <= t && c.name == name && auth_zone(&self.p.zones, name) == z)
            .max_by_key(|c| c.at_us);
        if let Some(c) = change {
            out.retain(|r| r.rtype != RType::A);
            out.push(Record {
                name: name.to_string(),
                rtype: RType::A,
                value: c.value.clone(),
                ttl_s: c.ttl_s,
            });
        }
        out
    }

    /// A1. [Answer from the zone.] A server looks at its own data only
    /// (RFC 1034 Section 4.3.2). If the name lies in a child zone it has
    /// delegated, it returns a referral: the child's NS records and their
    /// glue addresses. Otherwise it is authoritative: it returns the
    /// address, or a CNAME (following it while the target stays in its own
    /// zone), or says the name does not exist, with its SOA so the answer
    /// can be cached.
    fn ask(&self, z: usize, qname: &str, t: u64) -> Reply {
        let zone = &self.p.zones[z];
        let mut sets = Vec::new();
        let mut q = qname.to_string();
        for _ in 0..HOPS {
            let cut = zone
                .records
                .iter()
                .filter(|r| r.rtype == RType::NS && r.name != zone.origin && under(&q, &r.name))
                .max_by_key(|r| r.name.len());
            if let Some(cut) = cut {
                let child = cut.name.clone();
                let ns: Vec<&Record> = zone
                    .records
                    .iter()
                    .filter(|r| r.rtype == RType::NS && r.name == child)
                    .collect();
                sets.push(rrset(&child, Kind::NS, &ns));
                for n in &ns {
                    let glue: Vec<&Record> = zone
                        .records
                        .iter()
                        .filter(|r| r.rtype == RType::A && r.name == n.value)
                        .collect();
                    sets.push(rrset(&n.value, Kind::A, &glue));
                }
                let cz = self
                    .p
                    .zones
                    .iter()
                    .position(|c| c.origin == child)
                    .expect("checked: every delegation has its zone");
                return Reply {
                    sets,
                    next: Next::Referral(cz),
                };
            }
            let here = self.records(z, &q, t);
            if let Some(c) = here.iter().find(|r| r.rtype == RType::CNAME) {
                sets.push(rrset(&q, Kind::CNAME, &[c]));
                let target = c.value.clone();
                if auth_zone(&self.p.zones, &target) == z {
                    q = target;
                    continue;
                }
                return Reply {
                    sets,
                    next: Next::Cname(target),
                };
            }
            let a: Vec<&Record> = here.iter().filter(|r| r.rtype == RType::A).collect();
            if !a.is_empty() {
                sets.push(rrset(&q, Kind::A, &a));
                return Reply {
                    sets,
                    next: Next::Answer,
                };
            }
            // RFC 2308 Section 5: a negative answer is cached for the
            // smaller of the SOA record's TTL and its MINIMUM field.
            let kind = if here.is_empty() {
                Kind::NXDOMAIN
            } else {
                Kind::NODATA
            };
            sets.push(Rrset {
                name: q.clone(),
                kind,
                values: vec![],
                ttl_us: zone.soa_ttl_s.min(zone.soa_minimum_s) as u64 * S,
            });
            return Reply {
                sets,
                next: Next::Negative,
            };
        }
        unreachable!("checked: CNAME chains end")
    }

    /// What the zones say about a name at time t, asked from the root with
    /// no caches: the truth that cached answers are compared against.
    fn truth(&self, name: &str, t: u64) -> (Vec<String>, bool) {
        let mut z = self.root;
        let mut q = name.to_string();
        for _ in 0..4 * HOPS {
            let r = self.ask(z, &q, t);
            match r.next {
                Next::Referral(c) => z = c,
                Next::Cname(target) => {
                    q = target;
                    z = self.root;
                }
                Next::Answer => return (r.sets.last().unwrap().values.clone(), false),
                Next::Negative => return (vec![], true),
            }
        }
        (vec![], true)
    }

    fn lookup(&self, cache: usize, name: &str, kind: Kind, t: u64) -> Option<usize> {
        let v = self.index.get(&(cache, name.to_string(), kind))?;
        let k = v.partition_point(|&i| self.entries[i].from_us <= t);
        let i = *v.get(k.checked_sub(1)?)?;
        (t < self.entries[i].expires_us).then_some(i)
    }

    fn insert(&mut self, cache: usize, set: &Rrset, t: u64, res: usize) -> usize {
        let i = self.entries.len();
        self.entries.push(CacheEntry {
            cache,
            name: set.name.clone(),
            kind: set.kind,
            values: set.values.clone(),
            ttl_us: set.ttl_us,
            from_us: t,
            expires_us: t + set.ttl_us,
            res,
        });
        let v = self
            .index
            .entry((cache, set.name.clone(), set.kind))
            .or_default();
        let k = v.partition_point(|&j| self.entries[j].from_us <= t);
        v.insert(k, i);
        i
    }

    fn held(&self, i: usize, t: u64) -> Rrset {
        let e = &self.entries[i];
        Rrset {
            name: e.name.clone(),
            kind: e.kind,
            values: e.values.clone(),
            ttl_us: e.expires_us - t,
        }
    }

    /// The final answer a cache holds for a name, following cached CNAMEs:
    /// the entries used and where they lead.
    fn cached_final(&self, cache: usize, name: &str, t: u64) -> Option<(Vec<usize>, Next)> {
        let mut q = name.to_string();
        let mut used = Vec::new();
        for _ in 0..HOPS {
            if let Some(i) = self.lookup(cache, &q, Kind::A, t) {
                used.push(i);
                return Some((used, Next::Answer));
            }
            if let Some(i) = self.lookup(cache, &q, Kind::CNAME, t) {
                used.push(i);
                q = self.entries[i].values[0].clone();
                continue;
            }
            let neg = self
                .lookup(cache, &q, Kind::NXDOMAIN, t)
                .or_else(|| self.lookup(cache, &q, Kind::NODATA, t));
            if let Some(i) = neg {
                used.push(i);
                return Some((used, Next::Negative));
            }
            break;
        }
        (!used.is_empty()).then_some((used, Next::Cname(q)))
    }

    /// The deepest zone above a name whose servers the resolver has cached,
    /// with an address to reach them; the root if none.
    fn closest(&self, name: &str, t: u64) -> usize {
        let r = self.resolver();
        let mut s = name;
        while s != "." {
            if let Some(i) = self.lookup(r, s, Kind::NS, t) {
                let reachable = self.entries[i]
                    .values
                    .iter()
                    .any(|n| self.lookup(r, n, Kind::A, t).is_some());
                if reachable {
                    if let Some(z) = self.p.zones.iter().position(|z| z.origin == s) {
                        return z;
                    }
                }
            }
            s = parent(s).unwrap_or(".");
        }
        self.root
    }

    /// Iterative resolution by the resolver, starting at time t. Returns
    /// when it has the answer, the cache entries that make it up, whether it
    /// is negative, and the zones asked.
    fn iterate(&mut self, res: usize, name: &str, t0: u64) -> (u64, Vec<usize>, bool, Vec<usize>) {
        let r = self.resolver();
        let mut t = t0;
        let mut q = name.to_string();
        let mut used = Vec::new();
        let mut asked = Vec::new();
        let mut referred: Option<usize> = None;
        for _ in 0..4 * HOPS {
            // R1. [Look in the cache.] An answer, a CNAME to follow, or a
            // cached "no such name" ends or shortens the work.
            if referred.is_none() {
                match self.cached_final(r, &q, t) {
                    Some((u, Next::Answer)) => {
                        let i = *u.last().unwrap();
                        used.extend(u);
                        self.log(t, "R1", "hit", (res, r), None, Some(i), |s| {
                            let e = &s.entries[i];
                            format!(
                                "The resolver has {} {:?} {} in its cache, {} left of its TTL: no server is asked.",
                                e.name,
                                e.kind,
                                e.values.join(", "),
                                secs(e.expires_us - t)
                            )
                        });
                        return (t, used, false, asked);
                    }
                    Some((u, Next::Negative)) => {
                        let i = *u.last().unwrap();
                        used.extend(u);
                        self.log(t, "R1", "negative hit", (res, r), None, Some(i), |s| {
                            let e = &s.entries[i];
                            format!(
                                "The resolver remembers that {} does not exist ({:?}), for {} more: no server is asked.",
                                e.name,
                                e.kind,
                                secs(e.expires_us - t)
                            )
                        });
                        return (t, used, true, asked);
                    }
                    Some((u, Next::Cname(target))) => {
                        used.extend(u);
                        let from = q.clone();
                        self.log(t, "R1", "cname hit", (res, r), None, used.last().copied(), |_| {
                            format!("The resolver has a cached CNAME: {from} is an alias for {target}, which it must now find.")
                        });
                        q = target;
                        continue;
                    }
                    _ => {}
                }
            }
            // R2. [Ask the closest known server.] Start from the deepest
            // zone whose servers are cached (or the one just referred to);
            // with a cold cache, that is the root.
            let z = referred.take().unwrap_or_else(|| self.closest(&q, t));
            let rtt = self.p.zones[z].rtt_us;
            let half = rtt / 2;
            self.server_queries[z] += 1;
            asked.push(z);
            let node = self.server(z);
            let m = self.send(res, r, node, t, half, "query", &q, &[]);
            let skipped = z != self.root && asked.len() == 1;
            self.log(t, "R2", "query", (res, r), m, None, |s| {
                format!(
                    "The resolver asks {} for {q}{}.",
                    s.name(node),
                    if skipped {
                        ", skipping the servers above it because their referral is cached"
                    } else {
                        ""
                    }
                )
            });
            let reply = self.ask(z, &q, t + half);
            let kind = reply_kind(&reply);
            let m2 = self.send(res, node, r, t + half, rtt - half, kind, &q, &reply.sets);
            self.log(t + half, "A1", kind, (res, node), m2, None, |s| {
                format!("{} replies with {}.", s.name(node), describe(&reply))
            });
            t += rtt;
            // R3. [Read the reply.] Cache every record set it carries, each
            // for its own TTL, then follow the referral or the CNAME, or stop.
            let ins: Vec<usize> = reply
                .sets
                .iter()
                .map(|s| self.insert(r, s, t, res))
                .collect();
            self.log(t, "R3", kind, (res, r), m2, ins.last().copied(), |_| {
                format!(
                    "The resolver caches {} and {}.",
                    plural(ins.len(), "record set"),
                    match &reply.next {
                        Next::Referral(_) => "follows the referral",
                        Next::Cname(_) => "starts again for the alias's target",
                        Next::Answer => "has its answer",
                        Next::Negative => "has its (negative) answer",
                    }
                )
            });
            match reply.next {
                Next::Referral(c) => referred = Some(c),
                Next::Cname(target) => {
                    used.extend(ins);
                    q = target;
                }
                Next::Answer => {
                    used.extend(ins);
                    return (t, used, false, asked);
                }
                Next::Negative => {
                    used.extend(ins);
                    return (t, used, true, asked);
                }
            }
        }
        (t, used, true, asked)
    }

    /// Recursive resolution as a chain: server z is asked, at time t, to
    /// resolve q on `from`'s behalf. Returns when the reply reaches `from`,
    /// the record sets it carries and where they lead.
    fn chain(
        &mut self,
        res: usize,
        from: usize,
        z: usize,
        q: &str,
        t: u64,
        asked: &mut Vec<usize>,
    ) -> (u64, Vec<Rrset>, Next) {
        let rtt = self.p.zones[z].rtt_us;
        let half = rtt / 2;
        self.server_queries[z] += 1;
        asked.push(z);
        let node = self.server(z);
        let m = self.send(res, from, node, t, half, "query", q, &[]);
        let qq = q.to_string();
        self.log(t, "R2", "query", (res, from), m, None, |s| {
            format!(
                "{} asks {} to resolve {qq} for it.",
                cap(s.name(from)),
                s.name(node)
            )
        });
        let a = t + half;
        // A2. [Ask on the asker's behalf.] A server in a recursive chain
        // first looks in its own cache; failing that, if the name lies in a
        // zone it delegates, it asks that zone's server itself and waits.
        let (sets, next, back) = if let Some((used, next)) = self.cached_final(node, q, a) {
            let sets: Vec<Rrset> = used.iter().map(|&i| self.held(i, a)).collect();
            self.log(
                a,
                "A2",
                "hit",
                (res, node),
                None,
                used.last().copied(),
                |s| format!("{} has the answer in its own cache.", cap(s.name(node))),
            );
            (sets, next, a)
        } else {
            let reply = self.ask(z, q, a);
            match reply.next {
                Next::Referral(child) => {
                    let cn = self.server(child);
                    self.log(a, "A2", "forward", (res, node), None, None, |s| {
                        format!(
                            "{} does not hold {qq} but delegates it, so it asks {} itself.",
                            cap(s.name(node)),
                            s.name(cn)
                        )
                    });
                    let (tb, sets, next) = self.chain(res, node, child, q, a, asked);
                    // A3. [Cache on the way back.] Each server in the chain
                    // keeps the final answer it passes back, for its TTL.
                    let ins: Vec<usize> =
                        sets.iter().map(|s| self.insert(node, s, tb, res)).collect();
                    self.log(
                        tb,
                        "A3",
                        "cache",
                        (res, node),
                        None,
                        ins.last().copied(),
                        |s| {
                            format!(
                                "{} caches the answer it is passing back.",
                                cap(s.name(node))
                            )
                        },
                    );
                    (sets, next, tb)
                }
                next => {
                    let r = Reply {
                        sets: reply.sets,
                        next,
                    };
                    self.log(a, "A1", reply_kind(&r), (res, node), None, None, |s| {
                        format!(
                            "{} is authoritative and answers with {}.",
                            cap(s.name(node)),
                            describe(&r)
                        )
                    });
                    (r.sets, r.next, a)
                }
            }
        };
        let r = Reply { sets, next };
        let kind = reply_kind(&r);
        let m2 = self.send(res, node, from, back, rtt - half, kind, q, &r.sets);
        self.log(back, "A1", kind, (res, node), m2, None, |s| {
            format!(
                "{} sends the answer back to {}.",
                cap(s.name(node)),
                s.name(from)
            )
        });
        (back + rtt - half, r.sets, r.next)
    }

    /// Resolution by the resolver through the recursive chain.
    fn recurse(&mut self, res: usize, name: &str, t0: u64) -> (u64, Vec<usize>, bool, Vec<usize>) {
        let r = self.resolver();
        let mut t = t0;
        let mut q = name.to_string();
        let mut used = Vec::new();
        let mut asked = Vec::new();
        for _ in 0..HOPS {
            match self.cached_final(r, &q, t) {
                Some((u, Next::Answer)) => {
                    let i = *u.last().unwrap();
                    used.extend(u);
                    self.log(t, "R1", "hit", (res, r), None, Some(i), |s| {
                        format!(
                            "The resolver has {} in its cache, {} left: no server is asked.",
                            s.entries[i].name,
                            secs(s.entries[i].expires_us - t)
                        )
                    });
                    return (t, used, false, asked);
                }
                Some((u, Next::Negative)) => {
                    let i = *u.last().unwrap();
                    used.extend(u);
                    self.log(t, "R1", "negative hit", (res, r), None, Some(i), |s| {
                        format!(
                            "The resolver remembers that {} does not exist, for {} more.",
                            s.entries[i].name,
                            secs(s.entries[i].expires_us - t)
                        )
                    });
                    return (t, used, true, asked);
                }
                Some((u, Next::Cname(target))) => {
                    used.extend(u);
                    q = target;
                    continue;
                }
                _ => {}
            }
            let root = self.root;
            let (tb, sets, next) = self.chain(res, r, root, &q, t, &mut asked);
            t = tb;
            let ins: Vec<usize> = sets.iter().map(|s| self.insert(r, s, t, res)).collect();
            self.log(
                t,
                "R3",
                "cache",
                (res, r),
                None,
                ins.last().copied(),
                |_| {
                    format!(
                        "The resolver caches {} it was handed.",
                        plural(ins.len(), "record set")
                    )
                },
            );
            used.extend(ins);
            match next {
                Next::Answer => return (t, used, false, asked),
                Next::Negative => return (t, used, true, asked),
                Next::Cname(target) => q = target,
                Next::Referral(_) => unreachable!("a chain returns answers"),
            }
        }
        (t, used, true, asked)
    }

    fn query(&mut self, res: usize, spec: &QuerySpec) -> Resolution {
        let c = spec.client;
        let client = &self.p.clients[c];
        let (rtt, stub) = (client.rtt_us, client.stub_cache);
        let half = rtt / 2;
        let t0 = spec.at_us;
        let name = spec.name.as_str();
        let r = self.resolver();
        // C1. [Ask the stub.] An application asks the client's stub
        // resolver, which answers from its own cache if it can and
        // otherwise asks the recursive resolver.
        if stub {
            if let Some((used, next)) = self.cached_final(c, name, t0) {
                if !matches!(next, Next::Cname(_)) {
                    let i = *used.last().unwrap();
                    let e = self.entries[i].clone();
                    self.log(t0, "C1", "stub hit", (res, c), None, Some(i), |s| {
                        format!(
                            "{} asks for {name}; its own cache has it, {} left: answered at once.",
                            cap(s.name(c)),
                            secs(e.expires_us - t0)
                        )
                    });
                    let (truth, tneg) = self.truth(name, t0);
                    return Resolution {
                        client: c,
                        name: name.to_string(),
                        at_us: t0,
                        done_us: t0,
                        outcome: "stub",
                        answer: e.values.clone(),
                        negative: e.kind.negative(),
                        stale: differs(&truth, &e.values, tneg, e.kind.negative()),
                        servers: vec![],
                        resolver_us: 0,
                        ttl_us: e.expires_us - t0,
                    };
                }
            }
        }
        let m = self.send(res, c, r, t0, half, "query", name, &[]);
        self.log(t0, "C1", "query", (res, c), m, None, |s| {
            format!(
                "{} asks for {name}{}; the stub sends the query to the resolver.",
                cap(s.name(c)),
                if stub { ", which its cache lacks" } else { "" }
            )
        });
        let tr = t0 + half;
        let joined = self
            .inflight
            .get(name)
            .copied()
            .filter(|&ta| ta > tr)
            .and_then(|ta| self.cached_final(r, name, ta).map(|f| (ta, f)));
        let (td, used, negative, servers, outcome) = if let Some((ta, (used, next))) = joined {
            self.log(tr, "R1", "join", (res, r), None, None, |_| {
                format!(
                    "The resolver is already resolving {name}; this query waits {} for that answer.",
                    secs(ta - tr)
                )
            });
            let neg = matches!(next, Next::Negative);
            (ta, used, neg, vec![], "joined")
        } else {
            let (td, used, neg, asked) = match self.p.mode {
                Mode::Iterative => self.iterate(res, name, tr),
                Mode::Recursive => self.recurse(res, name, tr),
            };
            if !asked.is_empty() {
                self.inflight.insert(name.to_string(), td);
            }
            let outcome = if asked.is_empty() {
                "cache"
            } else {
                "resolved"
            };
            (td, used, neg, asked, outcome)
        };
        // R4. [Answer the stub.] The answer goes back with the least TTL
        // that remains on any record it rests on, so no copy downstream can
        // outlive the records it came from.
        let ttl = used
            .iter()
            .map(|&i| self.entries[i].expires_us.saturating_sub(td))
            .min()
            .unwrap_or(0);
        let last = used.last().map(|&i| self.entries[i].clone());
        let (kind, values) = match &last {
            Some(e) if e.kind.negative() => (e.kind, vec![]),
            Some(e) => (Kind::A, e.values.clone()),
            None => (Kind::NXDOMAIN, vec![]),
        };
        let set = Rrset {
            name: name.to_string(),
            kind,
            values: values.clone(),
            ttl_us: ttl,
        };
        let back = rtt - half;
        let m2 = self.send(
            res,
            r,
            c,
            td,
            back,
            if negative { "nxdomain" } else { "answer" },
            name,
            std::slice::from_ref(&set),
        );
        self.log(td, "R4", "answer", (res, r), m2, None, |s| {
            format!(
                "The resolver answers {}: {}, TTL {}.",
                s.name(c),
                if negative {
                    "no such name".to_string()
                } else {
                    values.join(", ")
                },
                secs(ttl)
            )
        });
        let done = td + back;
        if stub {
            // C2. [Keep it.] The stub caches the answer for the TTL it was
            // given, counted from when it arrived.
            let i = self.insert(c, &set, done, res);
            self.log(done, "C2", "cache", (res, c), m2, Some(i), |s| {
                format!(
                    "{} gets the answer and keeps it for {}.",
                    cap(s.name(c)),
                    secs(ttl)
                )
            });
        }
        let (truth, tneg) = self.truth(name, done);
        Resolution {
            client: c,
            name: name.to_string(),
            at_us: t0,
            done_us: done,
            outcome,
            answer: values.clone(),
            negative,
            stale: differs(&truth, &values, tneg, negative),
            servers,
            resolver_us: td - tr,
            ttl_us: ttl,
        }
    }
}

/// Whether an answer differs from what the zones say: a stale answer.
fn differs(truth: &[String], got: &[String], tneg: bool, neg: bool) -> bool {
    let mut a = truth.to_vec();
    let mut b = got.to_vec();
    a.sort();
    b.sort();
    a != b || tneg != neg
}

fn cap(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn plural(n: usize, what: &str) -> String {
    if n == 1 {
        format!("1 {what}")
    } else {
        format!("{n} {what}s")
    }
}

fn describe(r: &Reply) -> String {
    match &r.next {
        Next::Referral(_) => {
            let ns = &r.sets[0];
            format!(
                "a referral: {} is served by {} (glue address {})",
                ns.name,
                ns.values.join(", "),
                r.sets[1..]
                    .iter()
                    .flat_map(|s| s.values.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        Next::Cname(t) => format!("a CNAME: the name is an alias for {t}"),
        Next::Answer => {
            let a = r.sets.last().unwrap();
            format!(
                "the answer {} A {} (TTL {}){}",
                a.name,
                a.values.join(", "),
                secs(a.ttl_us),
                if r.sets.len() > 1 {
                    ", by way of a CNAME it also holds"
                } else {
                    ""
                }
            )
        }
        Next::Negative => {
            let n = r.sets.last().unwrap();
            format!(
                "{:?} for {}, with its SOA: cache that for {}",
                n.kind,
                n.name,
                secs(n.ttl_us)
            )
        }
    }
}

/// Runs the queries in the order they reach the resolver.
pub fn dns_run(p: &DnsParams) -> Result<DnsRun, String> {
    check(p)?;
    let nc = p.clients.len();
    let mut queries = p.queries.clone();
    if let Some(ps) = &p.poisson {
        let mut rng = Rng::new(p.seed);
        let mut t = 0.0;
        loop {
            t += rng.exp(1e6 / ps.rate_per_s);
            if t >= ps.until_us as f64 {
                break;
            }
            let name = ps.names[rng.upto(ps.names.len() as u64 - 1) as usize].clone();
            let client = rng.upto(nc as u64 - 1) as usize;
            queries.push(QuerySpec {
                at_us: t as u64,
                client,
                name,
            });
        }
    }
    queries.sort_by_key(|q| q.at_us + p.clients[q.client].rtt_us / 2);
    let mut sim = Sim {
        p,
        nc,
        root: p.zones.iter().position(|z| z.origin == ".").unwrap(),
        trace: p.trace,
        entries: Vec::new(),
        index: HashMap::new(),
        messages: Vec::new(),
        events: Vec::new(),
        server_queries: vec![0; p.zones.len()],
        inflight: HashMap::new(),
    };
    for c in &p.changes {
        let z = auth_zone(&p.zones, &c.name);
        let node = sim.server(z);
        sim.log(c.at_us, "Z1", "change", (usize::MAX, node), None, None, |s| {
            format!(
                "The owner changes {} to {} (TTL {} s) on {}. Caches holding the old address keep it until it expires.",
                c.name,
                c.value,
                c.ttl_s,
                s.name(node)
            )
        });
    }
    let mut resolutions = Vec::with_capacity(queries.len());
    for (k, q) in queries.iter().enumerate() {
        let r = sim.query(k, q);
        resolutions.push(r);
    }
    let last = resolutions
        .iter()
        .map(|r| r.done_us)
        .chain(sim.events.iter().map(|e| e.t))
        .max()
        .unwrap_or(0);
    let end = p.end_us.max(last);
    if sim.trace {
        // E1. [Expire.] An entry not replaced before its TTL runs out is
        // gone at exactly the moment it arrived plus its TTL.
        let mut expiries = Vec::new();
        for v in sim.index.values() {
            for (k, &i) in v.iter().enumerate() {
                let e = &sim.entries[i];
                let refreshed = v[k + 1..]
                    .iter()
                    .any(|&j| sim.entries[j].from_us < e.expires_us);
                if e.ttl_us > 0 && !refreshed && e.expires_us <= end {
                    expiries.push(i);
                }
            }
        }
        expiries.sort();
        for i in expiries {
            let e = sim.entries[i].clone();
            sim.log(
                e.expires_us,
                "E1",
                "expire",
                (e.res, e.cache),
                None,
                Some(i),
                |s| {
                    format!(
                        "{}'s cached {} {:?} expires, {} after it arrived.",
                        cap(s.name(e.cache)),
                        e.name,
                        e.kind,
                        secs(e.ttl_us)
                    )
                },
            );
        }
        sim.events.sort_by_key(|e| e.t);
    }
    let mut st = DnsStats {
        queries: resolutions.len() as u64,
        server_queries: sim.server_queries.clone(),
        ..Default::default()
    };
    let mut miss_total = 0.0;
    let mut latency = 0.0;
    for r in &resolutions {
        match r.outcome {
            "stub" => st.stub_hits += 1,
            "cache" => st.resolver_hits += 1,
            "joined" => st.joined += 1,
            _ => {
                st.misses += 1;
                miss_total += r.resolver_us as f64;
            }
        }
        st.negative_answers += r.negative as u64;
        st.stale += r.stale as u64;
        latency += (r.done_us - r.at_us) as f64;
    }
    st.resolver_queries = st.queries - st.stub_hits;
    st.hit_ratio = st.resolver_hits as f64 / st.resolver_queries.max(1) as f64;
    st.mean_latency_us = latency / st.queries.max(1) as f64;
    st.mean_miss_us = miss_total / st.misses.max(1) as f64;
    let mut nodes: Vec<String> = p.clients.iter().map(|c| c.name.clone()).collect();
    nodes.push("resolver".into());
    nodes.extend(p.zones.iter().map(|z| z.server.clone()));
    Ok(DnsRun {
        nodes,
        resolver: nc,
        events: sim.events,
        messages: sim.messages,
        entries: if p.trace { sim.entries } else { Vec::new() },
        resolutions: if p.trace { resolutions } else { Vec::new() },
        stats: st,
        end_us: end,
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct HitPoint {
    pub rate_per_s: f64,
    pub queries: u64,
    pub hit_ratio: f64,
    pub joined: u64,
    pub mean_miss_us: f64,
}

/// The resolver's hit ratio against the query rate: the base's Poisson
/// stream at each rate, run for about `per_point` queries each.
pub fn hit_sweep(base: &DnsParams, rates: &[f64], per_point: u64) -> Result<Vec<HitPoint>, String> {
    let ps = base
        .poisson
        .as_ref()
        .ok_or("the sweep needs a Poisson stream")?;
    rates
        .iter()
        .map(|&rate| {
            let p = DnsParams {
                poisson: Some(Poisson {
                    rate_per_s: rate,
                    until_us: (per_point as f64 / rate * 1e6) as u64,
                    ..ps.clone()
                }),
                trace: false,
                queries: vec![],
                ..base.clone()
            };
            let r = dns_run(&p)?;
            Ok(HitPoint {
                rate_per_s: rate,
                queries: r.stats.resolver_queries,
                hit_ratio: r.stats.hit_ratio,
                joined: r.stats.joined,
                mean_miss_us: r.stats.mean_miss_us,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(name: &str, rtype: RType, value: &str, ttl_s: u32) -> Record {
        Record {
            name: name.into(),
            rtype,
            value: value.into(),
            ttl_s,
        }
    }

    fn zone(origin: &str, server: &str, rtt_ms: u64, records: Vec<Record>) -> Zone {
        Zone {
            origin: origin.into(),
            server: server.into(),
            rtt_us: rtt_ms * 1000,
            records,
            soa_ttl_s: 3600,
            soa_minimum_s: 300,
        }
    }

    /// Root (30 ms), com. (40 ms), example.com. (20 ms), net. (36 ms) and
    /// cdn.net. (12 ms). shop.example.com. is a CNAME into cdn.net.
    fn zones() -> Vec<Zone> {
        use RType::*;
        vec![
            zone(
                ".",
                "a.root-servers.net.",
                30,
                vec![
                    rec("com.", NS, "a.gtld-servers.net.", 172_800),
                    rec("a.gtld-servers.net.", A, "192.0.2.30", 172_800),
                    rec("net.", NS, "b.gtld-servers.net.", 172_800),
                    rec("b.gtld-servers.net.", A, "192.0.2.31", 172_800),
                ],
            ),
            zone(
                "com.",
                "a.gtld-servers.net.",
                40,
                vec![
                    rec("example.com.", NS, "ns1.example.com.", 172_800),
                    rec("ns1.example.com.", A, "198.51.100.53", 172_800),
                ],
            ),
            zone(
                "example.com.",
                "ns1.example.com.",
                20,
                vec![
                    rec("example.com.", NS, "ns1.example.com.", 86_400),
                    rec("www.example.com.", A, "203.0.113.10", 300),
                    rec("mail.example.com.", A, "203.0.113.25", 3600),
                    rec("shop.example.com.", CNAME, "shop.cdn.net.", 600),
                ],
            ),
            zone(
                "net.",
                "b.gtld-servers.net.",
                36,
                vec![
                    rec("cdn.net.", NS, "ns.cdn.net.", 172_800),
                    rec("ns.cdn.net.", A, "198.51.100.80", 172_800),
                ],
            ),
            zone(
                "cdn.net.",
                "ns.cdn.net.",
                12,
                vec![rec("shop.cdn.net.", A, "203.0.113.77", 60)],
            ),
        ]
    }

    fn params(mode: Mode, queries: &[(f64, &str)]) -> DnsParams {
        DnsParams {
            mode,
            zones: zones(),
            clients: vec![Client {
                name: "laptop".into(),
                rtt_us: 10_000,
                stub_cache: false,
            }],
            queries: queries
                .iter()
                .map(|&(s, n)| QuerySpec {
                    at_us: (s * 1e6) as u64,
                    client: 0,
                    name: n.into(),
                })
                .collect(),
            poisson: None,
            changes: vec![],
            seed: 1,
            end_us: 0,
            trace: true,
        }
    }

    /// The client's round trip plus the round trip to every server asked.
    fn hop_sum(p: &DnsParams, r: &Resolution) -> u64 {
        p.clients[r.client].rtt_us + r.servers.iter().map(|&z| p.zones[z].rtt_us).sum::<u64>()
    }

    #[test]
    fn latency_is_the_sum_of_the_round_trips_taken() {
        let qs = [
            (0.0, "www.example.com."),
            (1.0, "mail.example.com."),
            (2.0, "www.example.com."),
            (3.0, "shop.example.com."),
        ];
        let p = params(Mode::Iterative, &qs);
        let run = dns_run(&p).unwrap();
        let rs = &run.resolutions;
        for r in rs {
            assert_eq!(r.done_us - r.at_us, hop_sum(&p, r), "{}", r.name);
        }
        // Cold: root, com., example.com.: 10 + 30 + 40 + 20 ms.
        assert_eq!(rs[0].servers, vec![0, 1, 2]);
        assert_eq!(rs[0].done_us - rs[0].at_us, 100_000);
        // Warm referral: straight to example.com.'s server.
        assert_eq!(rs[1].servers, vec![2]);
        assert_eq!(rs[1].done_us - rs[1].at_us, 30_000);
        // Warm answer: the client's round trip only.
        assert_eq!(rs[2].outcome, "cache");
        assert_eq!(rs[2].done_us - rs[2].at_us, 10_000);
        // The CNAME leads to cdn.net.: example.com. again, then net. and
        // cdn.net., with com. and the root skipped for example.com.
        assert_eq!(rs[3].servers, vec![2, 0, 3, 4]);
        assert_eq!(rs[3].answer, vec!["203.0.113.77"]);
        // Every message's arrival is its send plus a one-way delay that,
        // with its partner, makes the hop's round trip.
        for m in &run.messages {
            assert!(m.arrive_us > m.send_us);
        }

        // The chain: the same cold total, but the resolver never learns the
        // referrals, so the second name goes through the root again.
        let p = params(Mode::Recursive, &qs);
        let run = dns_run(&p).unwrap();
        let rs = &run.resolutions;
        for r in rs {
            assert_eq!(r.done_us - r.at_us, hop_sum(&p, r), "{}", r.name);
        }
        assert_eq!(rs[0].done_us - rs[0].at_us, 100_000);
        assert_eq!(rs[1].servers, vec![0, 1, 2]);
        assert_eq!(rs[2].outcome, "cache");
    }

    #[test]
    fn a_cache_entry_lasts_exactly_its_ttl() {
        // www.example.com. has TTL 300 s. The first answer reaches the
        // resolver 95 ms after the query leaves the client (5 ms to the
        // resolver, then 90 ms of servers); later queries reach it 5 ms
        // after they leave.
        let arrive = 95_000u64;
        let exp = arrive + 300 * S;
        let mut p = params(Mode::Iterative, &[(0.0, "www.example.com.")]);
        for at in [exp - 1 - 5_000, exp - 5_000] {
            p.queries.push(QuerySpec {
                at_us: at,
                client: 0,
                name: "www.example.com.".into(),
            });
        }
        let run = dns_run(&p).unwrap();
        let rs = &run.resolutions;
        let e = run
            .entries
            .iter()
            .find(|e| e.cache == run.resolver && e.name == "www.example.com." && e.kind == Kind::A)
            .unwrap();
        assert_eq!((e.from_us, e.expires_us), (arrive, exp));
        assert!(run
            .entries
            .iter()
            .all(|e| e.expires_us == e.from_us + e.ttl_us));
        assert_eq!(rs[1].outcome, "cache", "one microsecond before expiry");
        assert_eq!(rs[2].outcome, "resolved", "at expiry");
        // The expiry event sits at exactly arrival plus TTL.
        let ei = run.entries.iter().position(|x| std::ptr::eq(x, e));
        assert!(run
            .events
            .iter()
            .any(|ev| ev.step == "E1" && ev.entry == ei && ev.t == exp));
        // The TTL handed to the client is what remained: one microsecond.
        assert_eq!(rs[1].ttl_us, 1);
    }

    #[test]
    fn a_stub_cache_keeps_the_ttl_it_was_handed() {
        let mut p = params(
            Mode::Iterative,
            &[
                (0.0, "www.example.com."),
                (100.0, "www.example.com."),
                (200.0, "www.example.com."),
            ],
        );
        p.clients[0].stub_cache = true;
        p.clients.push(Client {
            name: "phone".into(),
            rtt_us: 10_000,
            stub_cache: true,
        });
        p.queries[1].client = 1;
        let run = dns_run(&p).unwrap();
        let rs = &run.resolutions;
        assert_eq!(rs[1].outcome, "cache");
        assert_eq!(rs[2].outcome, "stub");
        assert_eq!(rs[2].done_us, rs[2].at_us);
        // The phone's copy expires when the resolver's does, plus the 5 ms
        // the answer took to reach it: it was handed only what remained.
        let res_exp = run
            .entries
            .iter()
            .find(|e| e.cache == run.resolver && e.kind == Kind::A && e.name == "www.example.com.")
            .unwrap()
            .expires_us;
        let phone = run.entries.iter().find(|e| e.cache == 1).unwrap();
        assert_eq!(phone.expires_us, res_exp + 5_000);
        assert_eq!(phone.from_us + phone.ttl_us, phone.expires_us);
    }

    #[test]
    fn negative_answers_are_cached_for_the_soa_bound() {
        // RFC 2308 Section 5: min(SOA TTL, SOA MINIMUM).
        for (soa_ttl, minimum, want) in [(3600, 300, 300), (60, 900, 60), (600, 600, 600)] {
            let mut p = params(
                Mode::Iterative,
                &[(0.0, "nope.example.com."), (1.0, "nope.example.com.")],
            );
            p.zones[2].soa_ttl_s = soa_ttl;
            p.zones[2].soa_minimum_s = minimum;
            let run = dns_run(&p).unwrap();
            let neg = run
                .entries
                .iter()
                .find(|e| e.cache == run.resolver && e.kind == Kind::NXDOMAIN)
                .unwrap();
            assert_eq!(neg.ttl_us, want * S);
            assert!(run.resolutions[0].negative);
            assert_eq!(run.resolutions[1].outcome, "cache");
            assert!(run.resolutions[1].negative);
        }
        // A name that exists without an address is NODATA, cached the same way.
        let p = params(Mode::Iterative, &[(0.0, "example.com.")]);
        let run = dns_run(&p).unwrap();
        assert!(run
            .entries
            .iter()
            .any(|e| e.kind == Kind::NODATA && e.ttl_us == 300 * S));
    }

    #[test]
    fn iterative_and_recursive_give_the_same_answers() {
        let names = [
            "www.example.com.",
            "mail.example.com.",
            "shop.example.com.",
            "nope.example.com.",
            "nothing.cdn.net.",
            "example.com.",
        ];
        let qs: Vec<(f64, &str)> = names
            .iter()
            .enumerate()
            .map(|(i, n)| (i as f64, *n))
            .collect();
        let a = dns_run(&params(Mode::Iterative, &qs)).unwrap();
        let b = dns_run(&params(Mode::Recursive, &qs)).unwrap();
        for (x, y) in a.resolutions.iter().zip(&b.resolutions) {
            assert_eq!(
                (&x.answer, x.negative),
                (&y.answer, y.negative),
                "{}",
                x.name
            );
            assert!(!x.stale && !y.stale);
        }
        // Cold, both take the same round trips for the first name.
        assert_eq!(a.resolutions[0].done_us, b.resolutions[0].done_us);
    }

    #[test]
    fn the_root_sees_every_miss_in_a_chain_but_few_when_iterating() {
        let names = [
            "www.example.com.",
            "mail.example.com.",
            "shop.example.com.",
            "nope.example.com.",
        ];
        let qs: Vec<(f64, &str)> = names
            .iter()
            .enumerate()
            .map(|(i, n)| (i as f64, *n))
            .collect();
        let a = dns_run(&params(Mode::Iterative, &qs)).unwrap();
        let b = dns_run(&params(Mode::Recursive, &qs)).unwrap();
        // Iterating: once for com., once for net. (the CNAME target).
        assert_eq!(a.stats.server_queries[0], 2);
        // The chain: every name, plus the CNAME's target.
        assert_eq!(b.stats.server_queries[0], 5);
    }

    #[test]
    fn a_changed_address_is_stale_in_caches_until_they_expire() {
        // www.example.com. changes at 100 s; the cached copy (TTL 300 s,
        // from 0.095 s) is served until 300.095 s.
        let mut p = params(
            Mode::Iterative,
            &[
                (0.0, "www.example.com."),
                (150.0, "www.example.com."),
                (301.0, "www.example.com."),
            ],
        );
        p.changes.push(Change {
            at_us: 100 * S,
            name: "www.example.com.".into(),
            value: "203.0.113.99".into(),
            ttl_s: 60,
        });
        let run = dns_run(&p).unwrap();
        let rs = &run.resolutions;
        assert!(!rs[0].stale);
        assert!(rs[1].stale && rs[1].answer == vec!["203.0.113.10"]);
        assert!(!rs[2].stale && rs[2].answer == vec!["203.0.113.99"]);
        assert_eq!(run.stats.stale, 1);
        assert!(run.events.iter().any(|e| e.step == "Z1" && e.t == 100 * S));
    }

    #[test]
    fn concurrent_queries_join_the_resolution_under_way() {
        let p = params(
            Mode::Iterative,
            &[(0.0, "www.example.com."), (0.05, "www.example.com.")],
        );
        let run = dns_run(&p).unwrap();
        let rs = &run.resolutions;
        assert_eq!(rs[1].outcome, "joined");
        // It reaches the resolver at 55 ms and waits for the answer at 95 ms.
        assert_eq!(rs[1].done_us, 100_000);
        assert_eq!(run.stats.server_queries.iter().sum::<u64>(), 3);
    }

    /// The hit-ratio stream: one name, TTL T, many clients 10 ms from the
    /// resolver, the delegations cached for days, so after the first miss
    /// every miss costs L = 20 ms at example.com.'s server.
    fn stream(rate: f64, ttl_s: u32, n: f64, seed: u64) -> DnsParams {
        let mut p = params(Mode::Iterative, &[]);
        // The runs last months of simulated time; keep the delegations for
        // longer than that so that L stays one hop.
        for z in &mut p.zones {
            for r in &mut z.records {
                r.ttl_s = 2_000_000_000;
            }
        }
        p.zones[2].records[1].ttl_s = ttl_s;
        p.clients = (0..8)
            .map(|i| Client {
                name: format!("c{i}"),
                rtt_us: 10_000,
                stub_cache: false,
            })
            .collect();
        p.poisson = Some(Poisson {
            rate_per_s: rate,
            names: vec!["www.example.com.".into()],
            until_us: (n / rate * 1e6) as u64,
        });
        p.trace = false;
        p.seed = seed;
        p
    }

    /// Renewal: each miss at the resolver starts a cycle of L in flight
    /// (queries then join), T cached (queries then hit), and an exponential
    /// wait for the next query. Hits over queries: λT / (1 + λL + λT).
    fn formula(rate: f64, ttl_s: f64, l_s: f64) -> f64 {
        rate * ttl_s / (1.0 + rate * l_s + rate * ttl_s)
    }

    // Tolerances: 200,000 queries per run; the spread of the hit ratio over
    // seeds 1 to 20 (see `hit_ratio_spread`) has a standard deviation of
    // 0.00091 at λT = 0.25, 0.00085 at λT = 1 and 0.00033 at λT = 5. Each
    // check allows four of them, rounded up.
    #[test]
    fn the_hit_ratio_matches_the_renewal_formula() {
        for (rate, ttl, tol) in [
            (0.25 / 60.0, 60, 0.004),
            (1.0 / 60.0, 60, 0.0035),
            (5.0 / 60.0, 60, 0.0014),
        ] {
            let r = dns_run(&stream(rate, ttl, 200_000.0, 1)).unwrap();
            let want = formula(rate, ttl as f64, 0.020);
            let got = r.stats.hit_ratio;
            assert!(
                (got - want).abs() < tol,
                "λT {}: {got} against {want}",
                rate * ttl as f64
            );
            // The first miss walks from the root (90 ms); every later one
            // goes straight to example.com. (20 ms).
            let m = r.stats.misses as f64;
            assert!((r.stats.mean_miss_us * m - (70_000.0 + 20_000.0 * m)).abs() < 1.0);
        }
        // Without the in-flight time, λT / (1 + λT) is the textbook form;
        // at these rates λL is below 0.002 and the two agree to 0.001.
        let rate = 5.0 / 60.0;
        assert!((formula(rate, 60.0, 0.020) - formula(rate, 60.0, 0.0)).abs() < 0.001);
    }

    /// Prints the spread behind the hit-ratio tolerances:
    /// `cargo test -p netsim hit_ratio_spread -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn hit_ratio_spread() {
        for lt in [0.25, 1.0, 5.0] {
            let rate = lt / 60.0;
            let xs: Vec<f64> = (1..=20)
                .map(|s| {
                    dns_run(&stream(rate, 60, 200_000.0, s))
                        .unwrap()
                        .stats
                        .hit_ratio
                })
                .collect();
            let m = xs.iter().sum::<f64>() / 20.0;
            let sd = (xs.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / 19.0).sqrt();
            println!(
                "λT {lt}: mean {m:.5}, sd {sd:.5}, formula {:.5}",
                formula(rate, 60.0, 0.02)
            );
        }
    }

    #[test]
    fn bad_zone_data_is_refused() {
        let mut p = params(Mode::Iterative, &[(0.0, "www.example.com.")]);
        p.zones[1].records.pop();
        assert!(dns_run(&p).unwrap_err().contains("glue"));
        let mut p = params(Mode::Iterative, &[]);
        p.zones[2].records.push(rec(
            "loop.example.com.",
            RType::CNAME,
            "loop.example.com.",
            60,
        ));
        assert!(dns_run(&p).is_err());
    }
}
