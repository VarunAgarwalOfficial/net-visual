//! The two pieces every model shares: a seeded random source and an event queue.
//!
//! Time is an integer number of microseconds. Events at the same instant run in
//! the order they were scheduled, so a run is a pure function of its inputs.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// SplitMix64 (Steele, Lea and Flood, OOPSLA 2014). Small, fast, and the same
/// stream on every platform, which is all a teaching simulator needs.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform on [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Uniform integer on [0, n]; `n = 0` gives 0.
    pub fn upto(&mut self, n: u64) -> u64 {
        if n == 0 {
            self.next_u64();
            0
        } else {
            self.next_u64() % (n + 1)
        }
    }

    /// Exponential with the given mean.
    pub fn exp(&mut self, mean: f64) -> f64 {
        -mean * (1.0 - self.unit()).ln()
    }
}

/// A min-queue of timed events with a stable tie-break.
pub struct Queue<E> {
    heap: BinaryHeap<Reverse<(u64, u64)>>,
    slots: Vec<Option<E>>,
    order: u64,
}

impl<E> Default for Queue<E> {
    fn default() -> Self {
        Queue {
            heap: BinaryHeap::new(),
            slots: Vec::new(),
            order: 0,
        }
    }
}

impl<E> Queue<E> {
    pub fn push(&mut self, at: u64, event: E) {
        self.slots.push(Some(event));
        self.heap.push(Reverse((at, self.order)));
        self.order += 1;
    }

    pub fn pop(&mut self) -> Option<(u64, E)> {
        let Reverse((at, order)) = self.heap.pop()?;
        let event = self.slots[order as usize].take()?;
        Some((at, event))
    }

    /// The time of the next event, without taking it.
    pub fn peek_time(&self) -> Option<u64> {
        self.heap.peek().map(|Reverse((at, _))| *at)
    }

    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_is_stable_and_rng_is_uniform() {
        let mut q = Queue::default();
        q.push(5, 'b');
        q.push(1, 'a');
        q.push(5, 'c');
        let order: Vec<char> = std::iter::from_fn(|| q.pop().map(|e| e.1)).collect();
        assert_eq!(order, vec!['a', 'b', 'c']);

        let mut r = Rng::new(7);
        let mean = (0..100_000).map(|_| r.unit()).sum::<f64>() / 100_000.0;
        assert!((mean - 0.5).abs() < 0.005);
    }
}
