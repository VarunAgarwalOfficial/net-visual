// The article for the naming modes: how a name becomes an address, what the
// caches buy, and how long they may be wrong, in the site's five layers.
import { useMemo, type ReactNode } from "react"

import { Tex, texNum } from "../../components/Tex"
import { PRESETS, ZONES, hitRatio, negativeTtl, runDns } from "../../core/dns"
import type { Netsim } from "../../core/netsim"
import { Exercise, Layer } from "../rdt/RdtArticle"

function Try({ id, onLoad, children }: { id: string; onLoad(id: string): void; children: ReactNode }) {
  return (
    <button type="button" className="font-sans text-sm text-link underline underline-offset-2" onClick={() => onLoad(id)}>
      {children}
    </button>
  )
}

export function DnsIntro({ onLoad }: { onLoad(id: string): void }) {
  return (
    <Layer id="dns-intuition" layer="Intuition" title="Turning a name into an address, and remembering the answer">
      <p>
        People remember names; packets need addresses. The Domain Name System keeps the mapping, not in one place but split along the dots
        of the name. The root knows who runs each top-level domain such as com.; the com. servers know who runs example.com.; and
        example.com.'s own server, the <em>authoritative</em> one, knows the address of www.example.com. Nobody holds the whole map, and
        nobody needs to: each server need only know the next step down.
      </p>
      <p>
        Your laptop does almost none of the work. Its <em>stub resolver</em> hands the question to a <em>recursive resolver</em>, run by
        your network or a public service, which walks down from the root, server by server, until it has the answer. Each server it asks
        either answers or refers it further down, naming the next server and, so the resolver can reach it, its address (the <em>glue</em>).
      </p>
      <p>
        That walk would be slow and would crush the root if it happened on every lookup. It does not, because every answer, including every
        referral, comes with a <em>time to live</em> and the resolver keeps it that long. The first lookup pays for the walk; everyone
        behind the same resolver then gets the answer in one round trip until it expires. The price is that a changed record is not seen
        until the old copies run out.
      </p>

      <h3 className="pt-2 text-lg">Misconceptions this tool is built to correct</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>“Each server passes the question to the next one down.”</b> That chain is how many figures draw it, and the protocol allows it,
          but root and top-level servers refuse to recurse. The resolver iterates: it asks each server itself and follows the referrals, so
          it learns, and keeps, every step of the way.{" "}
          <Try id="cold-warm" onLoad={onLoad}>
            The iterative walk.
          </Try>{" "}
          <Try id="chain" onLoad={onLoad}>
            The chain, for comparison.
          </Try>
        </li>
        <li>
          <b>“Every lookup starts at the root.”</b> Only a resolver with an empty cache starts there. Referrals to com. and net. last two
          days, so after the first lookup under a top-level domain the root is not asked again for days.{" "}
          <Try id="root-load" onLoad={onLoad}>
            Count the root's queries.
          </Try>
        </li>
        <li>
          <b>“A DNS change propagates across the Internet.”</b> Nothing is sent anywhere. Each cache keeps its copy until the TTL it was
          given runs out, then asks again. Until then it answers, by the rules, with the old address.{" "}
          <Try id="ttl-change" onLoad={onLoad}>
            Watch the stale answers.
          </Try>
        </li>
        <li>
          <b>“To move a site quickly, lower the TTL when you move it.”</b> The copies already out there carry the old TTL. The lowering has
          to be published at least one old TTL before the move.{" "}
          <Try id="lower-first" onLoad={onLoad}>
            Lower it first.
          </Try>
        </li>
        <li>
          <b>“A name that does not exist costs a full lookup every time.”</b> Denials are cached too, for the smaller of the zone's SOA TTL
          and its MINIMUM field (RFC 2308).{" "}
          <Try id="nxdomain" onLoad={onLoad}>
            A typo, twice.
          </Try>
        </li>
        <li>
          <b>“Double the TTL, double the hits.”</b> The hit ratio is λT / (1 + λT): it saturates. Once a name is asked several times per
          TTL, a longer TTL buys almost nothing and costs agility.{" "}
          <Try id="hit-ratio" onLoad={onLoad}>
            Many hosts, one resolver.
          </Try>
        </li>
        <li>
          <b>“A thousand clients asking for a cold name send a thousand walks upstream.”</b> A resolver keeps one query in flight per
          question; the rest wait for its answer.{" "}
          <Try id="burst" onLoad={onLoad}>
            A burst of eight.
          </Try>
        </li>
        <li>
          <b>“An alias is just another name for the same lookup.”</b> A CNAME into another zone means a second walk, and each link of the
          chain expires on its own TTL.{" "}
          <Try id="cname" onLoad={onLoad}>
            An alias into a content network.
          </Try>
        </li>
      </ul>
    </Layer>
  )
}

export function DnsMechanics() {
  return (
    <Layer id="dns-mechanics" layer="Mechanics" title="Queries, referrals and caches, step by step">
      <p>
        The ladder above draws one lookup at a time: one column per machine, time running down, each message a line from its sending to its
        arrival. Light brown lines are queries, blue are referrals, green are answers, and a red line is a denial. Small squares mark where
        a record set was cached. The trace names each event by the step of the model that produced it; the program under Go deeper shows
        that step's code.
      </p>
      <dl className="space-y-2">
        <div>
          <dt className="font-semibold">C1, C2. The stub.</dt>
          <dd>
            The application's question goes to the stub. With a stub cache it is answered there if a live copy exists; otherwise it goes to
            the resolver, and the answer is cached on the way back (C2) for the TTL the resolver handed down, which is what remained of the
            resolver's own copy.
          </dd>
        </div>
        <div>
          <dt className="font-semibold">R1. The resolver's cache.</dt>
          <dd>
            A live answer, or a live denial, ends the lookup at once: the client waits only its own round trip. If the same question is
            already being resolved, the new query waits for that answer instead of starting a second walk.
          </dd>
        </div>
        <div>
          <dt className="font-semibold">R2, A1. Asking a server.</dt>
          <dd>
            The resolver picks the closest zone it holds a live referral for (the root if none) and asks that zone's server. The server
            answers from its zone: an answer, a CNAME, NXDOMAIN or NODATA with its SOA, or a referral carrying the child zone's NS record
            and the glue address of its server.
          </dd>
        </div>
        <div>
          <dt className="font-semibold">R3. Reading the reply.</dt>
          <dd>
            Every record set in the reply is cached for its own TTL. A referral is followed; a CNAME restarts the walk for its target from
            the closest known servers; a denial is cached for min(SOA TTL, MINIMUM).
          </dd>
        </div>
        <div>
          <dt className="font-semibold">A2, A3. The recursive chain.</dt>
          <dd>
            With the switch in Setup on, each server instead forwards the question down the delegation and passes the answer back (A2),
            caching what it learns on the way (A3). The resolver then sees only the final answer, never the referrals.
          </dd>
        </div>
        <div>
          <dt className="font-semibold">R4, E1, Z1.</dt>
          <dd>
            R4 is the answer reaching the client. E1 marks an entry expiring, at exactly the time it was cached plus its TTL. Z1 is the
            owner editing the zone: the server answers with the new data from then on, but no cache is told.
          </dd>
        </div>
      </dl>
      <p>
        The Caches tab lists every cache at the current moment, with each entry's TTL and the time it has left. A resolver's cache holds far
        more than answers: most of what a cold lookup leaves behind is referrals and glue, and those are what make the next lookup short.
      </p>
    </Layer>
  )
}

export function DnsAnalysis({ sim }: { sim: Netsim }) {
  const cold = useMemo(() => runDns(sim, PRESETS.find((p) => p.id === "cold-warm")!.params.dns), [sim])
  const lat = cold.resolutions.map((r) => (r.done_us - r.at_us) / 1000)
  const ex = ZONES.find((z) => z.origin === "example.com.")!
  return (
    <Layer id="dns-analysis" layer="Analysis" title="What a lookup costs, what a cache saves, and how long it can be wrong">
      <h3 className="text-lg">Theorem 1 (latency)</h3>
      <p>
        If messages are not lost and servers answer at once, a lookup that misses every cache takes the client's round trip to the resolver
        plus one round trip to each server asked:
      </p>
      <Tex display>{`t = \\text{RTT}_c + \\sum_{z \\in \\text{asked}} \\text{RTT}_z.`}</Tex>
      <p>
        <i>Proof.</i> The resolver handles one question at a time per lookup; each server is asked only after the previous reply arrives,
        and the client's answer leaves as soon as the last reply is read. The terms do not overlap. In the recursive chain each server's
        round trip to the next nests inside its own asker's, which gives the same sum. ∎
      </p>
      <p>
        In the first scenario the cold lookup takes <Tex>{`10 + 30 + 40 + 20 = ${texNum(lat[0] ?? 0, 0)}\\text{ ms}`}</Tex>, the warm one
        only the phone's <Tex>{`${texNum(lat[1] ?? 0, 0)}\\text{ ms}`}</Tex>, and the second name in the same zone{" "}
        <Tex>{`10 + 20 = ${texNum(lat[2] ?? 0, 0)}\\text{ ms}`}</Tex>. Every run in the test suite checks this sum, lookup by lookup, in
        both modes.
      </p>

      <h3 className="text-lg">Theorem 2 (hit ratio)</h3>
      <p>
        Let queries for one name reach a resolver as a Poisson process of rate λ, let the record's TTL be T, and suppose a miss is answered
        after a time L during which further queries wait for it. Then the long-run fraction of queries answered from the cache is
      </p>
      <Tex
        display
      >{`h = \\frac{\\lambda T}{1 + \\lambda L + \\lambda T} \\;\\xrightarrow{L \\to 0}\\; \\frac{\\lambda T}{1 + \\lambda T}.`}</Tex>
      <p>
        <i>Proof.</i> Cut time at each miss. A cycle starts with the miss, lasts L, then T while the copy lives, then until the next query,
        which misses and starts the next cycle. By the memoryless property the number of queries in the first two intervals is Poisson with
        means λL and λT, and the wait for the next query is independent of them. Each cycle therefore has one miss, λL joined queries and λT
        hits on average, and by the renewal-reward theorem the long-run ratio is the ratio of the means. ∎
      </p>
      <p>
        At λT = 3, as in the shared-cache scenario, <Tex>{`h = 3/4`}</Tex>; at λT = 30 it is <Tex>{`${texNum(hitRatio(1, 30), 3)}`}</Tex>.
        Ten times the TTL raised the hit ratio by 0.22. Jung, Berger and Balakrishnan derive the same expression for TTL caches and find it
        matches traces. The test suite compares the simulator with it at 200,000 queries per point in Rust, where four seed standard
        deviations come to 0.0014 to 0.004, and across the page's sweep.
      </p>

      <h3 className="text-lg">Theorem 3 (staleness)</h3>
      <p>
        A cache that fetched a record at time f with TTL T serves it until f + T. If the zone changes at time c, every copy fetched before c
        is stale from c, and the last stale answer is served before
      </p>
      <Tex display>{`\\max_{f < c} (f + T_f) \\le c + T_{\\text{old}}.`}</Tex>
      <p>
        If the owner lowers the TTL to T′ at time ℓ ≤ c − T<sub>old</sub>, every copy alive at c was fetched after ℓ, so the window shrinks
        to T′. <i>Proof.</i> A copy fetched before ℓ expires by ℓ + T<sub>old</sub> ≤ c. ∎ This is why operators lower TTLs a day ahead of a
        move.
      </p>

      <h3 className="text-lg">Theorem 4 (negative caching)</h3>
      <p>
        A denial is cached for{" "}
        <Tex>{`\\min(\\text{SOA TTL}, \\text{MINIMUM}) = \\min(${ex.soa_ttl_s}, ${ex.soa_minimum_s}) = ${negativeTtl(ex)}\\text{ s}`}</Tex>{" "}
        for example.com. here. RFC 2308 (Section 5) makes the MINIMUM field mean exactly this, replacing its original role as a floor on
        every TTL in the zone; the SOA record's own TTL caps it so that a denial never outlives the record that justifies it.
      </p>

      <h3 className="text-lg">Load on the root</h3>
      <p>
        An iterating resolver asks the root about once per top-level domain per referral TTL, so with D domains and referral TTL T
        <sub>R</sub> the root sees at most <Tex>{`D \\lceil t / T_R \\rceil`}</Tex> of its queries in time t, however many lookups it
        serves. In the recursive chain the root sees every miss the resolver has. The root's real traffic is dominated by neither: by
        measurement, much of it is queries for names that do not exist.
      </p>

      <h3 className="pt-2 text-lg">Exercises</h3>
      <ol className="list-decimal space-y-4 pl-5">
        <Exercise
          rating="10"
          answer={
            <p>
              10 + 30 + 40 + 20 = 100 ms cold; the referral to example.com. is cached, so mail.example.com. costs 10 + 20 = 30 ms. If both
              lookups used different top-level domains the second would cost 10 + 30 + (its TLD) + (its zone).
            </p>
          }
        >
          With the round trips of the first scenario, what do a cold lookup of www.example.com. and then a lookup of mail.example.com. cost?
        </Exercise>
        <Exercise
          rating="15"
          answer={
            <p>
              h = λT / (1 + λT) = 0.9 needs λT = 9, so T = 9 / 0.05 = 180 s. For 0.99, λT = 99 and T = 1980 s: eleven times as long for nine
              points more.
            </p>
          }
        >
          A name is asked at 0.05 queries a second behind one resolver. What TTL gives a hit ratio of 0.9? Of 0.99?
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              The lowering must reach the zone by 400 − 300 = 100 s, so that the copy alive at 400 s was fetched under the new TTL; then at
              most one 30 s copy is stale. In the scenario the copy fetched at 0.095 s expires at 300.095 s; lowered at 50 s, the refetch at
              300.095 s already has the 30 s TTL.
            </p>
          }
        >
          A record with TTL 300 s will change at 400 s, and the owner will lower its TTL to 30 s first. What is the latest time to do so?
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              Iterating, the root hears from the resolver once per top-level domain per two days: twice in the root-load scenario.
              Recursing, every miss goes through it; with a 60 s record at the bottom of a chain, that is about one query a minute per such
              name, and every typo.
            </p>
          }
        >
          Why do root and top-level servers refuse recursive queries? Answer with the root-load scenario's numbers.
        </Exercise>
        <Exercise
          rating="M25"
          answer={
            <p>
              Each cycle has 1 + λL + λT queries on average; the hit ratio over n cycles is a ratio of sums of n independent cycle counts,
              so by the central limit theorem and the delta method its standard deviation falls as 1/√n. The Rust tests measured about
              0.0009 over seeds at 200,000 queries; at 5000 queries a point that becomes 0.0009 × √40 ≈ 0.006, and four of those, 0.023,
              fits inside the page test's 0.03.
            </p>
          }
        >
          Show that the hit ratio measured over n queries has a standard deviation of order 1/√n, and use it to justify the tolerance in the
          tests.
        </Exercise>
      </ol>
    </Layer>
  )
}

export function DnsFrontier() {
  return (
    <Layer id="dns-frontier" layer="Frontier" title="Privacy, authenticity and scale">
      <p>
        <b>Encrypted transport.</b> Classic DNS is plain UDP on port 53: anyone on the path sees every name you look up and can forge
        replies. DNS over TLS (RFC 7858) and DNS over HTTPS (RFC 8484) carry the stub-to-resolver hop inside an encrypted session, and DNS
        over QUIC (RFC 9250) does the same without TCP's head-of-line blocking. They protect the first hop only; the resolver still sees
        everything, which moves trust to whoever runs it.
      </p>
      <p>
        <b>Authenticity.</b> DNSSEC (RFCs 4033 to 4035) signs record sets. Each zone publishes its keys in DNSKEY records, signs its data in
        RRSIG records, and its parent vouches for the key with a DS record, so a validating resolver can follow a chain of signatures down
        from the root's key. NSEC and NSEC3 records prove that a name does not exist, and RFC 8198 lets a resolver use them to deny other
        names in the same gap without asking. Before DNSSEC, the main defence against forged replies was unpredictability: a random query ID
        and a random source port (RFC 5452), after Kaminsky's 2008 attack showed how quickly a cache could be poisoned without them.
      </p>
      <p>
        <b>Anycast roots.</b> There are thirteen root server names, a to m, but over a thousand machines answer for them: each letter is
        announced by BGP from many sites (RFC 3258), and routing delivers a query to a nearby one. Anycast spreads load and absorbs attacks,
        and keeps the root's round trip short almost everywhere, which is why the root is rarely the slow step of a cold lookup.
      </p>
      <p>
        <b>QNAME minimisation.</b> The walk on the ladder sends the full name, www.example.com., to the root and to com., which need only
        know that it is under com. and example.com. RFC 9156 has the resolver send each server only as much of the name as it needs, so the
        root learns of com. and not of www. Most large resolvers now do this.
      </p>
      <p>
        <b>Keeping caches useful.</b> Serve-stale (RFC 8767) lets a resolver answer with an expired record if the authoritative servers are
        unreachable, trading freshness for availability. Popular names are often refreshed before they expire, so users never see the miss.
        Client subnet (RFC 7871) lets a content network give different answers to resolvers on behalf of different networks, at the cost of
        splitting the cache.
      </p>
    </Layer>
  )
}

export function DnsInternals() {
  return (
    <Layer id="dns-internals" layer="Internals" title="How the model works, and what it leaves out">
      <p>
        The model is one Rust function, <code>dns_run</code> in crates/netsim/src/dns.rs, compiled to WebAssembly. It keeps a cache per
        machine as a map from (name, type) to a record set with its expiry time, and resolves each question as a sequence of exchanges whose
        times are sums of half round trips, so every latency is exact in microseconds. Questions come from a script, from a Poisson stream
        drawn with a seeded generator, or both; the owner's changes are applied to the zone data at their times. Queries that arrive while
        the same question is in flight join it and get its answer.
      </p>
      <p>The tests check, in Rust and again through the page's own API:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>every lookup's latency equals the sum of the round trips of the hops it took, in both modes;</li>
        <li>
          every entry expires exactly at its insertion time plus its TTL: a query a microsecond earlier hits, one at that time misses;
        </li>
        <li>the negative TTL is min(SOA TTL, MINIMUM), whichever is smaller;</li>
        <li>the hit ratio matches λT / (1 + λL + λT) within four seed standard deviations;</li>
        <li>iterative and recursive resolution give the same answers to the same questions.</li>
      </ul>
      <h3 className="pt-2 text-lg">Simplifications</h3>
      <ul className="list-disc space-y-1 pl-5">
        <li>No loss, retransmission or timeouts: every message arrives after half its round trip, and servers answer at once.</li>
        <li>One server per zone, so there is no choice among a zone's servers by measured round trip.</li>
        <li>Only A, NS and CNAME records; no AAAA, MX, EDNS, truncation or fallback to TCP.</li>
        <li>Glue is always present for in-zone servers; out-of-zone server names would need lookups of their own.</li>
        <li>No DNSSEC, no QNAME minimisation and no prefetching.</li>
        <li>A stub caches the TTL the resolver hands it, the remainder of the resolver's copy, as real resolvers do.</li>
      </ul>
      <h3 className="pt-2 text-lg">References</h3>
      <ul className="list-disc space-y-1 pl-5">
        <li>P. Mockapetris. RFC 1034, Domain names: concepts and facilities; RFC 1035, implementation and specification. 1987.</li>
        <li>R. Elz and R. Bush. RFC 2181, Clarifications to the DNS specification. 1997.</li>
        <li>M. Andrews. RFC 2308, Negative caching of DNS queries. 1998.</li>
        <li>A. Hubert and R. van Mook. RFC 5452, Measures for making DNS more resilient against forged answers. 2009.</li>
        <li>S. Bortzmeyer, R. Dolmans and P. Hoffman. RFC 9156, DNS query name minimisation to improve privacy. 2021.</li>
        <li>Z. Hu et al. RFC 7858 (DNS over TLS), 2016; P. Hoffman and P. McManus, RFC 8484 (DNS over HTTPS), 2018.</li>
        <li>R. Arends et al. RFCs 4033 to 4035, DNS security introduction, records and protocol. 2005.</li>
        <li>J. Jung, A. W. Berger and H. Balakrishnan. Modeling TTL-based Internet caches. IEEE INFOCOM 2003.</li>
        <li>J. Jung, E. Sit, H. Balakrishnan and R. Morris. DNS performance and the effectiveness of caching. IEEE/ACM ToN, 2002.</li>
        <li>J. F. Kurose and K. W. Ross. Computer Networking: A Top-Down Approach, 8th ed., Section 2.4.</li>
      </ul>
    </Layer>
  )
}
