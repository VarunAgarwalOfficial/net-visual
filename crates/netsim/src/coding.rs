//! The link layer's second problem: bits arrive wrong.
//!
//! Two answers, both exact (no randomness: every error is one the learner
//! chose):
//!
//! - A cyclic redundancy check (Peterson and Brown 1961) treats the frame as
//!   a polynomial over GF(2), where adding is XOR, and appends the remainder
//!   of dividing it by a generator G(x). The receiver divides again; a
//!   nonzero remainder means the frame was damaged. An error pattern E(x)
//!   goes unnoticed exactly when G(x) divides E(x).
//! - A Hamming code (Hamming 1950) puts parity bits at the positions that are
//!   powers of two, each covering the positions whose binary number has that
//!   bit set. The recomputed parities, read as a binary number, are the
//!   position of a single flipped bit. One more parity bit over the whole
//!   word (SECDED) tells one error, which it corrects, from two, which it
//!   only reports.
//!
//! The steps are lettered; the trace names the step behind each event and the
//! page highlights it in this source.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Polynomials over GF(2)
// ---------------------------------------------------------------------------

/// Bits from a string of '0' and '1'; anything else is an error.
pub fn parse_bits(s: &str) -> Result<Vec<u8>, String> {
    s.chars()
        .map(|c| match c {
            '0' => Ok(0),
            '1' => Ok(1),
            _ => Err(format!("'{c}' is not a bit")),
        })
        .collect()
}

pub fn bit_string(bits: &[u8]) -> String {
    bits.iter()
        .map(|&b| if b == 1 { '1' } else { '0' })
        .collect()
}

/// A bit string, most significant first, as a polynomial: bit i of the
/// result is the coefficient of x^i.
fn to_poly(bits: &[u8]) -> u128 {
    bits.iter().fold(0, |acc, &b| (acc << 1) | b as u128)
}

fn degree(p: u128) -> i32 {
    127 - p.leading_zeros() as i32
}

/// The longest codeword, in bits, whose error patterns are counted.
pub const MAX_CODEWORD: usize = 128;

/// The remainder of e(x) divided by g(x), over GF(2).
pub fn poly_rem(mut e: u128, g: u128) -> u128 {
    let dg = degree(g);
    while e != 0 && degree(e) >= dg {
        e ^= g << (degree(e) - dg);
    }
    e
}

// ---------------------------------------------------------------------------
// Standard CRCs
// ---------------------------------------------------------------------------

/// A CRC in the parameter model of Williams (1993), "A painless guide to CRC
/// error detection algorithms", as catalogued by Cook's CRC RevEng.
#[derive(Clone, Copy, Debug)]
pub struct CrcSpec {
    pub name: &'static str,
    pub width: u32,
    /// The generator without its x^width term.
    pub poly: u64,
    pub init: u64,
    /// Whether each byte enters least significant bit first.
    pub refin: bool,
    pub refout: bool,
    pub xorout: u64,
}

pub const CRC8: CrcSpec = CrcSpec {
    name: "CRC-8 (x⁸ + x² + x + 1)",
    width: 8,
    poly: 0x07,
    init: 0,
    refin: false,
    refout: false,
    xorout: 0,
};

pub const CRC16_CCITT: CrcSpec = CrcSpec {
    name: "CRC-16/CCITT-FALSE (x¹⁶ + x¹² + x⁵ + 1)",
    width: 16,
    poly: 0x1021,
    init: 0xFFFF,
    refin: false,
    refout: false,
    xorout: 0,
};

/// The frame check sequence of Ethernet (IEEE 802.3, Clause 3.2.9).
pub const CRC32: CrcSpec = CrcSpec {
    name: "CRC-32 (IEEE 802.3)",
    width: 32,
    poly: 0x04C1_1DB7,
    init: 0xFFFF_FFFF,
    refin: true,
    refout: true,
    xorout: 0xFFFF_FFFF,
};

/// The CRC of `data`, one bit at a time, exactly as a shift register with
/// XOR taps computes it.
pub fn crc(spec: &CrcSpec, data: &[u8]) -> u64 {
    let w = spec.width;
    let top = 1u64 << (w - 1);
    let mask = (1u64 << w) - 1;
    let mut reg = spec.init & mask;
    for &byte in data {
        let b = if spec.refin {
            byte.reverse_bits()
        } else {
            byte
        };
        reg ^= (b as u64) << (w - 8);
        for _ in 0..8 {
            reg = if reg & top != 0 {
                (reg << 1) ^ spec.poly
            } else {
                reg << 1
            } & mask;
        }
    }
    if spec.refout {
        reg = reg.reverse_bits() >> (64 - w);
    }
    reg ^ spec.xorout
}

// ---------------------------------------------------------------------------
// The CRC by long division
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CrcParams {
    /// The message, as a string of bits.
    pub message: String,
    /// The generator, as a string of bits from x^r down to x^0.
    pub generator: String,
    /// Positions in the codeword, counted from 0 at the left, that are
    /// flipped in transit.
    #[serde(default)]
    pub flips: Vec<usize>,
    /// Text whose standard CRCs the page lists beside the division.
    #[serde(default)]
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CrcEvent {
    pub t: u64,
    pub step: &'static str,
    /// "send" while the sender divides, "check" once the frame is received.
    pub phase: &'static str,
    /// Where the generator sits under the working bits, for a subtraction.
    pub pos: Option<usize>,
    /// The working bits after the step.
    pub bits: String,
    /// The quotient so far.
    pub quotient: String,
    pub what: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct BurstStat {
    pub len: usize,
    pub patterns: u64,
    pub undetected: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct CrcProps {
    pub r: usize,
    pub n: usize,
    /// Undetected error patterns of each weight from one to three, out of
    /// all of them in this codeword length.
    pub weight: Vec<BurstStat>,
    /// Whether (x + 1) divides G(x), so every odd number of errors is seen.
    pub plus_one: bool,
    /// Bursts by length: every error pattern whose first and last flipped
    /// bits are `len` apart, inclusive, anywhere in the codeword.
    pub bursts: Vec<BurstStat>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StdCrc {
    pub name: &'static str,
    pub width: u32,
    pub value: u64,
    /// The catalogue's check value: the CRC of the ASCII text "123456789".
    pub check: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct CrcRun {
    pub events: Vec<CrcEvent>,
    pub remainder: String,
    pub codeword: String,
    pub error: String,
    pub received: String,
    pub syndrome: String,
    pub detected: bool,
    pub props: CrcProps,
    pub standard: Vec<StdCrc>,
}

/// Divides `bits` by `g` as by hand, recording each subtraction.
fn divide(
    bits: &[u8],
    g: &[u8],
    phase: &'static str,
    events: &mut Vec<CrcEvent>,
) -> (Vec<u8>, Vec<u8>) {
    let r = g.len() - 1;
    let mut w = bits.to_vec();
    let mut q = Vec::new();
    for i in 0..=(w.len() - g.len()) {
        if w[i] == 1 {
            // C2. [Subtract the generator.] Where the working bits have a
            // leading 1, the quotient gets a 1 and G, shifted under it, is
            // subtracted; over GF(2) that is XOR, with no borrowing. A
            // leading 0 gives a quotient bit of 0 and nothing to subtract.
            for (j, &gj) in g.iter().enumerate() {
                w[i + j] ^= gj;
            }
            q.push(1);
            events.push(CrcEvent {
                t: events.len() as u64,
                step: if phase == "send" { "C2" } else { "C5" },
                phase,
                pos: Some(i),
                bits: bit_string(&w),
                quotient: bit_string(&q),
                what: "xor",
            });
        } else {
            q.push(0);
        }
    }
    (w[w.len() - r..].to_vec(), q)
}

pub fn crc_run(p: &CrcParams) -> Result<CrcRun, String> {
    let m = parse_bits(&p.message)?;
    let g = parse_bits(&p.generator)?;
    if g.len() < 2 || g[0] != 1 || g[g.len() - 1] != 1 {
        return Err("a generator starts and ends with 1".into());
    }
    if m.is_empty() {
        return Err("the message is empty".into());
    }
    let r = g.len() - 1;
    let n = m.len() + r;
    if n > MAX_CODEWORD {
        return Err(format!("the codeword is limited to {MAX_CODEWORD} bits"));
    }
    let mut events = Vec::new();

    // C1. [Append r zeros.] Multiplying M(x) by x^r makes room for the
    // remainder, which has degree below r.
    let mut padded = m.clone();
    padded.extend(std::iter::repeat_n(0, r));
    events.push(CrcEvent {
        t: 0,
        step: "C1",
        phase: "send",
        pos: None,
        bits: bit_string(&padded),
        quotient: String::new(),
        what: "pad",
    });
    let (rem, q) = divide(&padded, &g, "send", &mut events);

    // C3. [Send M followed by the remainder.] x^r M(x) + R(x) is a multiple
    // of G(x), since subtracting the remainder of a division leaves a
    // multiple of the divisor.
    let mut codeword = m.clone();
    codeword.extend(&rem);
    events.push(CrcEvent {
        t: events.len() as u64,
        step: "C3",
        phase: "send",
        pos: None,
        bits: bit_string(&codeword),
        quotient: bit_string(&q),
        what: "send",
    });

    // C4. [Errors in transit.] The channel adds an error pattern E(x): each
    // 1 in it flips the bit in that place.
    let mut error = vec![0u8; n];
    for &f in &p.flips {
        if f >= n {
            return Err("a flipped bit lies outside the codeword".into());
        }
        error[f] ^= 1;
    }
    let received: Vec<u8> = codeword.iter().zip(&error).map(|(a, b)| a ^ b).collect();
    events.push(CrcEvent {
        t: events.len() as u64,
        step: "C4",
        phase: "check",
        pos: None,
        bits: bit_string(&received),
        quotient: String::new(),
        what: "receive",
    });

    // C5. [The receiver divides.] It divides the frame as received by the
    // same G(x), with no zeros appended this time.
    let (syn, _) = divide(&received, &g, "check", &mut events);

    // C6. [Read the remainder.] Zero means accept. Since the codeword is a
    // multiple of G(x), the remainder is that of E(x) alone: an error is
    // missed exactly when G(x) divides E(x).
    let detected = syn.contains(&1);
    events.push(CrcEvent {
        t: events.len() as u64,
        step: "C6",
        phase: "check",
        pos: None,
        bits: bit_string(&syn),
        quotient: String::new(),
        what: if detected { "reject" } else { "accept" },
    });

    let text = p.text.as_bytes();
    let standard = [CRC8, CRC16_CCITT, CRC32]
        .iter()
        .map(|s| StdCrc {
            name: s.name,
            width: s.width,
            value: crc(s, text),
            check: crc(s, b"123456789"),
        })
        .collect();

    Ok(CrcRun {
        events,
        remainder: bit_string(&rem),
        codeword: bit_string(&codeword),
        error: bit_string(&error),
        received: bit_string(&received),
        syndrome: bit_string(&syn),
        detected,
        props: crc_props(to_poly(&g), n),
        standard,
    })
}

/// Counts, by enumeration, the error patterns that G(x) misses in an
/// n-bit codeword.
pub fn crc_props(g: u128, n: usize) -> CrcProps {
    let r = degree(g) as usize;
    let missed = |e: u128| poly_rem(e, g) == 0;
    let mut weight = Vec::new();
    for w in 1..=3usize.min(n) {
        let (mut total, mut undetected) = (0u64, 0u64);
        let mut each = |e: u128| {
            total += 1;
            undetected += missed(e) as u64;
        };
        match w {
            1 => (0..n).for_each(|i| each(1 << i)),
            2 => (0..n).for_each(|i| (0..i).for_each(|j| each(1 << i | 1 << j))),
            _ => (0..n).for_each(|i| {
                (0..i).for_each(|j| (0..j).for_each(|k| each(1 << i | 1 << j | 1 << k)))
            }),
        }
        weight.push(BurstStat {
            len: w,
            patterns: total,
            undetected,
        });
    }
    // A burst of length b is x^j B(x) with B of degree b − 1 and B(0) = 1.
    // G(0) = 1 means x shares no factor with G(x), so G divides x^j B(x)
    // exactly when it divides B(x): the count at one position, times the
    // n − b + 1 positions, is the count over the codeword. (The tests check
    // this against enumerating every position.)
    let mut bursts = Vec::new();
    for b in 1..=n.min(r + 3).min(20) {
        let positions = (n - b + 1) as u64;
        let (mut patterns, mut undetected) = (0u64, 0u64);
        if b == 1 {
            patterns = 1;
            undetected = missed(1) as u64;
        } else {
            for mid in 0..(1u128 << (b - 2)) {
                patterns += 1;
                undetected += missed(1 << (b - 1) | mid << 1 | 1) as u64;
            }
        }
        bursts.push(BurstStat {
            len: b,
            patterns: patterns * positions,
            undetected: undetected * positions,
        });
    }
    CrcProps {
        r,
        n,
        weight,
        plus_one: poly_rem(g, 0b11) == 0,
        bursts,
    }
}

// ---------------------------------------------------------------------------
// Hamming codes
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HammingParams {
    /// Parity bits: the code is (2^r − 1, 2^r − r − 1).
    pub r: u32,
    /// Add an overall parity bit, at position 0: single error correction,
    /// double error detection.
    pub secded: bool,
    /// The data bits, 2^r − r − 1 of them.
    pub data: String,
    /// Positions flipped in transit: 1 to 2^r − 1, or 0 for the overall
    /// parity bit.
    #[serde(default)]
    pub flips: Vec<usize>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HammingEvent {
    pub t: u64,
    pub step: &'static str,
    pub what: &'static str,
    /// The parity position or flipped position the step is about.
    pub pos: Option<usize>,
    pub value: u8,
    /// The positions a parity bit covers.
    pub covers: Vec<usize>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WeightStat {
    pub w: usize,
    pub patterns: u64,
    /// Decoded data right: no error, or every error corrected.
    pub right: u64,
    /// Reported as uncorrectable.
    pub detected: u64,
    /// Decoded data wrong with no warning: missed, or "corrected" into a
    /// different codeword.
    pub wrong: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HammingRun {
    pub n: usize,
    pub k: usize,
    /// Index 0 is the overall parity bit (always 0 without SECDED), then
    /// positions 1 to n.
    pub codeword: Vec<u8>,
    pub received: Vec<u8>,
    pub syndrome: usize,
    pub overall: u8,
    /// "clean", "corrected" or "detected".
    pub verdict: &'static str,
    pub corrected: Vec<u8>,
    pub decoded: Vec<u8>,
    pub data_ok: bool,
    pub events: Vec<HammingEvent>,
    /// Every error pattern of up to four bits, by weight.
    pub by_weight: Vec<WeightStat>,
    /// The least weight of a nonzero error pattern the decoder cannot see:
    /// the code's minimum distance.
    pub min_distance: Option<usize>,
}

fn covers(n: usize, pbit: usize) -> Vec<usize> {
    (1..=n).filter(|j| j & pbit != 0).collect()
}

/// Encodes `data` (k bits) into positions 0..=n.
pub fn hamming_encode(r: u32, secded: bool, data: &[u8]) -> Vec<u8> {
    let n = (1usize << r) - 1;
    let mut w = vec![0u8; n + 1];
    let mut d = data.iter();
    for (j, slot) in w.iter_mut().enumerate().skip(1) {
        if !j.is_power_of_two() {
            *slot = *d.next().unwrap_or(&0);
        }
    }
    for i in 0..r {
        let pbit = 1usize << i;
        w[pbit] = covers(n, pbit)
            .iter()
            .filter(|&&j| j != pbit)
            .fold(0, |a, &j| a ^ w[j]);
    }
    if secded {
        w[0] = w[1..].iter().fold(0, |a, b| a ^ b);
    }
    w
}

/// The syndrome (XOR of the positions holding a 1) and the overall parity.
fn hamming_check(w: &[u8]) -> (usize, u8) {
    let s = (1..w.len()).filter(|&j| w[j] == 1).fold(0, |a, j| a ^ j);
    (s, w.iter().fold(0, |a, b| a ^ b))
}

/// Decodes a received word: the verdict and the corrected word.
pub fn hamming_decode(secded: bool, w: &[u8]) -> (&'static str, Vec<u8>) {
    let (s, overall) = hamming_check(w);
    let mut c = w.to_vec();
    if secded {
        match (s, overall) {
            (0, 0) => ("clean", c),
            (_, 1) => {
                c[s] ^= 1;
                ("corrected", c)
            }
            _ => ("detected", c),
        }
    } else if s == 0 {
        ("clean", c)
    } else {
        c[s] ^= 1;
        ("corrected", c)
    }
}

fn hamming_data(w: &[u8]) -> Vec<u8> {
    (1..w.len())
        .filter(|j| !j.is_power_of_two())
        .map(|j| w[j])
        .collect()
}

pub fn hamming_run(p: &HammingParams) -> Result<HammingRun, String> {
    let r = p.r;
    let n = (1usize << r) - 1;
    let k = n - r as usize;
    let data = parse_bits(&p.data)?;
    if data.len() != k {
        return Err(format!("this code carries {k} data bits"));
    }
    let mut events = Vec::new();
    let push = |events: &mut Vec<HammingEvent>,
                step: &'static str,
                what: &'static str,
                pos: Option<usize>,
                value: u8,
                covers: Vec<usize>| {
        let t = events.len() as u64;
        events.push(HammingEvent {
            t,
            step,
            what,
            pos,
            value,
            covers,
        });
    };

    // H1. [Place the data bits.] Number the positions from 1. Those that are
    // powers of two (1, 2, 4, 8, ...) are kept for parity; the data fills
    // the rest in order.
    push(&mut events, "H1", "place", None, 0, vec![]);
    let w = hamming_encode(r, p.secded, &data);
    // H2. [Set each parity bit.] Parity bit 2^i covers every position whose
    // binary number has bit i set, and makes the count of 1s among them
    // even. Each position other than 0 is thus covered by the parity bits
    // that spell out its own number.
    for i in 0..r {
        let pbit = 1usize << i;
        push(
            &mut events,
            "H2",
            "parity",
            Some(pbit),
            w[pbit],
            covers(n, pbit),
        );
    }
    // H3. [Overall parity.] For SECDED, bit 0 makes the whole word's count
    // of 1s even.
    if p.secded {
        push(
            &mut events,
            "H3",
            "overall",
            Some(0),
            w[0],
            (1..=n).collect(),
        );
    }

    // H4. [Errors in transit.]
    let mut rx = w.clone();
    for &f in &p.flips {
        if f > n || (f == 0 && !p.secded) {
            return Err("a flipped bit lies outside the codeword".into());
        }
        rx[f] ^= 1;
        push(&mut events, "H4", "flip", Some(f), rx[f], vec![]);
    }

    // H5. [Recheck each parity.] The receiver recounts each parity group. A
    // group with an odd count contains an error; the failing groups, read
    // as binary digits, spell the syndrome.
    for i in 0..r {
        let pbit = 1usize << i;
        let c = covers(n, pbit);
        let v = c.iter().fold(0, |a, &j| a ^ rx[j]);
        push(&mut events, "H5", "recheck", Some(pbit), v, c);
    }
    let (syndrome, overall) = hamming_check(&rx);
    // H6. [Read the syndrome.] One flipped bit at position j fails exactly
    // the groups of j's binary digits, so the syndrome is j. With SECDED the
    // overall parity says whether the number of errors is odd.
    push(
        &mut events,
        "H6",
        "syndrome",
        Some(syndrome),
        overall,
        vec![],
    );
    // H7. [Correct, or give up.] Without SECDED any nonzero syndrome is taken
    // as one error and that bit is flipped back, which turns two errors into
    // three. With SECDED a nonzero syndrome and even overall parity mean two
    // errors: reported, not corrected.
    let (verdict, corrected) = hamming_decode(p.secded, &rx);
    let decoded = hamming_data(&corrected);
    push(
        &mut events,
        "H7",
        verdict,
        if verdict == "corrected" {
            Some(syndrome)
        } else {
            None
        },
        0,
        vec![],
    );

    let by_weight = hamming_weights(r, p.secded, &w);
    let min_distance = by_weight
        .iter()
        .find(|s| s.w > 0 && s.patterns > 0 && undetectable(r, p.secded, s.w))
        .map(|s| s.w);
    Ok(HammingRun {
        n,
        k,
        data_ok: decoded == data,
        codeword: w,
        received: rx,
        syndrome,
        overall,
        verdict,
        corrected,
        decoded,
        events,
        by_weight,
        min_distance,
    })
}

/// Visits every subset of `w` positions out of `0..m`.
fn subsets(m: usize, w: usize, f: &mut dyn FnMut(&[usize])) {
    fn go(start: usize, m: usize, left: usize, cur: &mut Vec<usize>, f: &mut dyn FnMut(&[usize])) {
        if left == 0 {
            f(cur);
            return;
        }
        for i in start..=(m - left) {
            cur.push(i);
            go(i + 1, m, left - 1, cur, f);
            cur.pop();
        }
    }
    go(0, m, w, &mut Vec::new(), f);
}

/// Whether some nonzero error of weight w leaves a valid codeword (zero
/// syndrome, even overall parity).
fn undetectable(r: u32, secded: bool, w: usize) -> bool {
    let n = (1usize << r) - 1;
    let lo = if secded { 0 } else { 1 };
    let mut found = false;
    subsets(n + 1 - lo, w, &mut |s| {
        if found {
            return;
        }
        let mut e = vec![0u8; n + 1];
        for &i in s {
            e[i + lo] = 1;
        }
        let (syn, overall) = hamming_check(&e);
        found = syn == 0 && (!secded || overall == 0);
    });
    found
}

/// Applies every error pattern of weight 0 to 4 to the codeword and decodes.
pub fn hamming_weights(r: u32, secded: bool, w: &[u8]) -> Vec<WeightStat> {
    let n = (1usize << r) - 1;
    let lo = if secded { 0 } else { 1 };
    let m = n + 1 - lo;
    let data = hamming_data(w);
    (0..=4usize.min(m))
        .map(|wt| {
            let mut st = WeightStat {
                w: wt,
                patterns: 0,
                right: 0,
                detected: 0,
                wrong: 0,
            };
            subsets(m, wt, &mut |s| {
                let mut rx = w.to_vec();
                for &i in s {
                    rx[i + lo] ^= 1;
                }
                let (verdict, c) = hamming_decode(secded, &rx);
                st.patterns += 1;
                if verdict == "detected" {
                    st.detected += 1;
                } else if hamming_data(&c) == data {
                    st.right += 1;
                } else {
                    st.wrong += 1;
                }
            });
            st
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_crcs_give_their_catalogue_check_values() {
        // The check value of each CRC in Cook's catalogue (and Williams 1993)
        // is its CRC of the nine ASCII bytes "123456789".
        assert_eq!(crc(&CRC32, b"123456789"), 0xCBF4_3926);
        assert_eq!(crc(&CRC16_CCITT, b"123456789"), 0x29B1);
        assert_eq!(crc(&CRC8, b"123456789"), 0xF4);
    }

    #[test]
    fn long_division_is_the_crc() {
        // CRC-8 starts from zero, reflects nothing and adds nothing at the
        // end, so it is exactly the remainder of x^8 M(x) by G(x), the long
        // division of the page, with M the message's bits in order.
        let bits: String = b"123456789".iter().map(|b| format!("{b:08b}")).collect();
        let run = crc_run(&CrcParams {
            message: bits,
            generator: "100000111".into(),
            flips: vec![],
            text: String::new(),
        })
        .unwrap();
        assert_eq!(u64::from_str_radix(&run.remainder, 2).unwrap(), 0xF4);
        assert!(!run.detected);
        assert_eq!(run.syndrome, "00000000");
    }

    #[test]
    fn a_textbook_division() {
        // M = 1101011011, G = x^4 + x + 1 (10011): R = 1110, a standard
        // worked example (Tanenbaum and Wetherall, Section 3.2.2).
        let run = crc_run(&CrcParams {
            message: "1101011011".into(),
            generator: "10011".into(),
            flips: vec![],
            text: String::new(),
        })
        .unwrap();
        assert_eq!(run.remainder, "1110");
        assert_eq!(run.codeword, "11010110111110");
        assert_eq!(
            poly_rem(to_poly(&parse_bits(&run.codeword).unwrap()), 0b10011),
            0
        );
        let steps: Vec<&str> = run.events.iter().map(|e| e.step).collect();
        assert_eq!(steps[0], "C1");
        assert_eq!(*steps.last().unwrap(), "C6");
        assert!(run
            .events
            .iter()
            .enumerate()
            .all(|(i, e)| e.t as usize == i));
    }

    #[test]
    fn an_error_divisible_by_the_generator_is_missed() {
        // E = G itself, placed anywhere, leaves a multiple of G.
        let run = crc_run(&CrcParams {
            message: "1101011011".into(),
            generator: "10011".into(),
            flips: vec![3, 6, 7],
            text: String::new(),
        })
        .unwrap();
        assert_eq!(&run.error[3..8], "10011");
        assert!(!run.detected);
        // One bit fewer and it is caught.
        let caught = crc_run(&CrcParams {
            flips: vec![3, 6],
            ..CrcParams {
                message: "1101011011".into(),
                generator: "10011".into(),
                flips: vec![],
                text: String::new(),
            }
        })
        .unwrap();
        assert!(caught.detected);
    }

    #[test]
    fn detection_properties_hold_by_enumeration() {
        // G = x^4 + x^3 + x^2 + 1 = (x + 1)(x^3 + x + 1), r = 4, in 12-bit
        // codewords: every error of every pattern is enumerated directly.
        let g = 0b11101u128;
        let n = 12;
        let props = crc_props(g, n);
        assert!(props.plus_one);
        // Every single error, and (since x + 1 divides G) every odd weight.
        assert_eq!(props.weight[0].undetected, 0);
        assert_eq!(props.weight[2].undetected, 0);
        let mut odd_missed = 0;
        let mut by_len = vec![(0u64, 0u64); n + 1];
        for e in 1u128..(1 << n) {
            let missed = poly_rem(e, g) == 0;
            if e.count_ones() % 2 == 1 && missed {
                odd_missed += 1;
            }
            let len = (degree(e) - e.trailing_zeros() as i32 + 1) as usize;
            by_len[len].0 += 1;
            by_len[len].1 += missed as u64;
        }
        assert_eq!(odd_missed, 0);
        // Bursts up to r long: all caught. Length r + 1: a fraction
        // 2^-(r-1) missed. Longer: 2^-r.
        for b in &props.bursts {
            assert_eq!((b.patterns, b.undetected), by_len[b.len], "burst {}", b.len);
            if b.len <= 4 {
                assert_eq!(b.undetected, 0);
            } else if b.len == 5 {
                assert_eq!(b.undetected * 8, b.patterns);
            } else {
                assert_eq!(b.undetected * 16, b.patterns);
            }
        }
        // Without the (x + 1) factor some three-bit error slips by.
        let props = crc_props(0b10011, 15);
        assert!(!props.plus_one);
        assert!(props.weight[2].undetected > 0);
    }

    #[test]
    fn hamming_7_4_places_parity_and_locates_errors() {
        // Data 1011 at positions 3, 5, 6, 7; parities at 1, 2, 4.
        let w = hamming_encode(3, false, &[1, 0, 1, 1]);
        assert_eq!(&w[1..], &[0, 1, 1, 0, 0, 1, 1]);
        for j in 1..=7 {
            let mut rx = w.clone();
            rx[j] ^= 1;
            assert_eq!(hamming_check(&rx).0, j);
        }
    }

    #[test]
    fn every_single_error_is_corrected_and_every_double_detected() {
        for r in [2u32, 3, 4] {
            let n = (1usize << r) - 1;
            let k = n - r as usize;
            for secded in [false, true] {
                let lo = if secded { 0 } else { 1 };
                let mut dmin = usize::MAX;
                for d in 0u32..(1 << k) {
                    let data: Vec<u8> = (0..k).map(|i| (d >> i & 1) as u8).collect();
                    let w = hamming_encode(r, secded, &data);
                    let weight = w.iter().filter(|&&b| b == 1).count();
                    if d != 0 {
                        dmin = dmin.min(weight);
                    }
                    for i in lo..=n {
                        let mut rx = w.clone();
                        rx[i] ^= 1;
                        let (v, c) = hamming_decode(secded, &rx);
                        assert_eq!((v, &c), ("corrected", &w));
                        if secded {
                            for j in lo..i {
                                let mut rx2 = rx.clone();
                                rx2[j] ^= 1;
                                assert_eq!(hamming_decode(true, &rx2).0, "detected");
                            }
                        }
                    }
                }
                // Minimum distance by enumerating every codeword.
                assert_eq!(dmin, if secded { 4 } else { 3 }, "r {r}");
                let run = hamming_run(&HammingParams {
                    r,
                    secded,
                    data: "1".repeat(k),
                    flips: vec![],
                })
                .unwrap();
                assert_eq!(run.min_distance, Some(dmin));
                let w1 = &run.by_weight[1];
                assert_eq!((w1.right, w1.patterns), (w1.patterns, (n + 1 - lo) as u64));
                if secded {
                    let w2 = &run.by_weight[2];
                    assert_eq!(w2.detected, w2.patterns);
                }
            }
        }
    }

    #[test]
    fn without_secded_two_errors_become_three() {
        let run = hamming_run(&HammingParams {
            r: 3,
            secded: false,
            data: "1011".into(),
            flips: vec![3, 5],
        })
        .unwrap();
        assert_eq!(run.syndrome, 6);
        assert_eq!(run.verdict, "corrected");
        assert!(!run.data_ok);
        let flipped = (1..=7)
            .filter(|&j| run.corrected[j] != run.codeword[j])
            .count();
        assert_eq!(flipped, 3);
        let sec = hamming_run(&HammingParams {
            secded: true,
            ..HammingParams {
                r: 3,
                secded: false,
                data: "1011".into(),
                flips: vec![3, 5],
            }
        })
        .unwrap();
        assert_eq!(sec.verdict, "detected");
    }
}
