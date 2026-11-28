# The six tools

Each tool has five layers: a guided tour, the mechanics on one clock you can scrub, the analysis set against the formulas, where the idea goes in current systems, and the Rust source behind the current event. "Checked against" lists what the Rust tests compare each model with.

| Tool | Model | Checked against | Layers |
| --- | --- | --- | --- |
| Reliable data transfer | Stop-and-wait, Go-Back-N, Selective Repeat, or any mix of their four rules, on a channel that loses, delays and reorders | The stop-and-wait closed form (within 4%); the lossless window bound (within 1%); Kurose and Ross Fig. 3.27; the sequence-number condition N ≤ 2^(k−1). Presets replay Fig. 3.16, 3.22 and 3.26 | all five |
| TCP congestion control | Up to four flows through one bottleneck: Tahoe, Reno, NewReno, CUBIC, and the retransmission timer | RFC 6298 timer values; NewReno surviving the losses that stall Reno; the sawtooth utilisation formula (within 0.02); the Mathis square-root law (within 8%); the CUBIC curve; fair sharing and round-trip unfairness | all five |
| Routing | Distance vector (triggered updates, poisoned reverse) and link state, with cost changes and failures | Kurose and Ross Fig. 5.3 and 5.7; agreement with Dijkstra on 40 random networks; count to infinity, and poisoned reverse failing on a loop of three (RFC 2453) | all five |
| Queueing and delay | The four delays, M/M/1, M/D/1, priority, token and leaky buckets, weighted fair queueing | Little's law; Pollaczek-Khinchine; Cobham's priority formula; the Parekh-Gallager delay bound | all five |
| Link layer and wireless | ALOHA, Ethernet CSMA/CD, Wi-Fi CSMA/CA with RTS/CTS, learning switches, spanning tree, CRC and Hamming codes | G e^(-G) and G e^(-2G); 802.3 back-off; the hidden and exposed terminals; textbook spanning-tree recovery times; catalogue CRC check values | all five |
| Naming and the web | DNS (iterative and recursive, caching, TTLs) and HTTP/1.0, 1.1, 2 and 3 | The textbook HTTP response-time formulas; head-of-line blocking in HTTP/2 against HTTP/3; the renewal formula for the cache hit ratio | all five |

The Lab tab poses tasks and checks your answer against the simulation in the
browser. No server is involved.

For teaching, every tool has three more actions. "Copy link to this moment"
stores the settings, your packet edits and the clock in the URL. "SVG" and
"TikZ" export the sequence diagram up to the current moment as a figure; the
TikZ file is a standalone document that compiles with `pdflatex`. "Present"
puts the tool full screen and larger, without the article.
