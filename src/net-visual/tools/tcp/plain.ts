// The step card's words for the TCP tool. The model's event texts are terse
// and use RFC notation ("ACK 51: congestion avoidance, cwnd + 1/cwnd"); they
// stay in the trace and the source. This turns each into a full sentence
// that says what happened and why, with every term spelled out.

import type { TcpEvent, TcpParams } from "../../core/tcp"
import { formatTime } from "../../components/timeline"

export interface Plain {
  title: string
  text: string
  why?: string
}

/** A window size in packets: whole numbers plain, fractions to two places. */
export const packets = (v: number) => {
  if (v >= 1e8) return "no limit yet"
  const n = v >= 100 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2)
  return `${n} packet${n === "1" ? "" : "s"}`
}

const ORDINAL = ["", "first", "second", "third"]

export function plainTcp(e: TcpEvent, p: TcpParams): Plain {
  const s = e.state
  const t = e.text
  const algo = p.flows[0].algo
  const w = packets(s.cwnd)
  const th = packets(s.ssthresh)
  let r: RegExpMatchArray | null

  if (t.startsWith("the connection opens"))
    return {
      title: "Start",
      text: `The connection opens. The sender may have ${w} on the way before it hears anything back.`,
      why: "That number is the congestion window. It starts small because the sender knows nothing yet about the path or who else is using it.",
    }
  if ((r = t.match(/^(send|retransmit) segment (\d+)/))) {
    const again = r[1] === "retransmit"
    const out = s.nxt - s.una
    return {
      title: again ? "Send it again" : "Send",
      text: again ? `The sender sends packet ${r[2]} again.` : `The sender puts packet ${r[2]} on the link.`,
      why: again
        ? e.step === "T1"
          ? "Its timer ran out with no acknowledgement, so the sender assumes it was lost."
          : e.step === "F5"
            ? "An acknowledgement showed that this packet is missing too, so it goes at once."
            : "Three repeated acknowledgements said it was missing, so the sender resends it without waiting for its timer (fast retransmit)."
        : `${out} packet${out === 1 ? " is" : "s are"} now on the way without an acknowledgement; the window allows ${Math.floor(s.cwnd)}.`,
    }
  }
  if ((r = t.match(/^segment (\d+) dropped(.*)$/))) {
    const why = r[2]
    const text = why.includes("queue full")
      ? `Packet ${r[1]} reaches the router, but its buffer is full (${p.buffer_pkts} packets waiting), so the router throws it away.`
      : why.includes("scripted")
        ? `Packet ${r[1]} is lost: this example drops it on purpose.`
        : why.includes("n-th")
          ? `Packet ${r[1]} is lost: this example loses every ${p.drop_every.toLocaleString("en")}th packet.`
          : `Packet ${r[1]} is lost at random (this link loses ${(p.loss * 100).toPrecision(2)}% of packets).`
    return {
      title: "A packet is lost",
      text,
      why: "Nobody tells the sender. It can only find out from what the receiver sends back, or fails to.",
    }
  }
  if ((r = t.match(/^receiver gets (\d+): ([^;]+); ACK (\d+)/))) {
    const [, seg, fate, ack] = r
    if (fate.startsWith("delivered"))
      return {
        title: "A packet arrives",
        text:
          Number(ack) > Number(seg) + 1
            ? `Packet ${seg} reaches the receiver. It fills a gap: the receiver already held the packets after it, so it acknowledges everything up to ${ack} (ACK ${ack}).`
            : `Packet ${seg} reaches the receiver, which sends back an acknowledgement, ACK ${ack}: the next packet it expects is ${ack}.`,
      }
    if (fate.startsWith("buffered"))
      return {
        title: "A packet arrives out of order",
        text: `Packet ${seg} reaches the receiver, but packet ${ack} is still missing. The receiver keeps ${seg} and sends ACK ${ack} again.`,
        why: "Repeating the acknowledgement for the missing packet is the only way the receiver can tell the sender that something did not arrive.",
      }
    return {
      title: "A copy arrives",
      text: `Packet ${seg} arrives again. The receiver already has it, and sends ACK ${ack}.`,
    }
  }
  if ((r = t.match(/^ACK (\d+): slow start/)))
    return {
      title: "An acknowledgement: grow fast",
      text: `ACK ${r[1]} reaches the sender: every packet before ${r[1]} has arrived. The window grows by one packet, to ${w}.`,
      why: `This is slow start. One more packet for every acknowledgement doubles the window every round trip, until it reaches the slow-start threshold${
        s.ssthresh >= 1e8 ? ", which is not set until the first loss" : ` (${th})`
      }.`,
    }
  if ((r = t.match(/^ACK (\d+): congestion avoidance/)))
    return {
      title: "An acknowledgement: grow slowly",
      text: `ACK ${r[1]} reaches the sender. The window grows by a fraction of a packet, to ${w}.`,
      why: `The window is past the slow-start threshold (${th}), so the sender probes carefully: the fractions add up to one packet per round trip. This is congestion avoidance.`,
    }
  if ((r = t.match(/^ACK (\d+): CUBIC, Reno-friendly/)))
    return {
      title: "An acknowledgement (CUBIC)",
      text: `ACK ${r[1]} reaches the sender. CUBIC sets its window to what Reno would have reached by now: ${w}.`,
      why: "Soon after a loss, and on short paths, CUBIC is never slower than Reno.",
    }
  if ((r = t.match(/^ACK (\d+): CUBIC/)))
    return {
      title: "An acknowledgement (CUBIC)",
      text: `ACK ${r[1]} reaches the sender. CUBIC moves its window along its curve, to ${w}.`,
      why: `The curve climbs fast while the window is far below ${packets(s.w_max)}, where the last loss happened, flattens near it, then climbs faster again beyond it.`,
    }
  if ((r = t.match(/^duplicate ACK (\d+) in recovery/)))
    return {
      title: "Another repeated acknowledgement",
      text: `ACK ${r[1]} arrives again while the sender is repairing a loss. The window grows by one, to ${w}.`,
      why: "Each repeat means one more packet has left the network, so one more may be sent in its place.",
    }
  if ((r = t.match(/^duplicate ACK (\d+) \(#(\d+)\)/))) {
    const n = Number(r[2])
    return {
      title: "A repeated acknowledgement",
      text: `ACK ${r[1]} arrives again, the ${ORDINAL[n] ?? `${n}th`} repeat in a row: the receiver is still waiting for packet ${r[1]}.`,
      why:
        n < 3
          ? "One or two repeats can mean packets merely arrived out of order. The sender waits for a third before it treats the packet as lost."
          : "Three repeats in a row: the sender treats the packet as lost.",
    }
  }
  if ((r = t.match(/^ACK (\d+) does not cover recover = (\d+)/)))
    return {
      title: "Repeats from a loss already handled",
      text: `Three repeated acknowledgements, but they come from packets sent before the last repair, so the sender ignores them.`,
      why: `The sender remembers the highest packet it had sent when it last cut its window (${r[2]}), and cuts at most once for losses up to there.`,
    }
  if ((r = t.match(/^third duplicate: fast retransmit (\d+); Tahoe/)))
    return {
      title: "Third repeat: resend and start over",
      text: `Three repeated acknowledgements for packet ${r[1]}. The sender resends it at once (fast retransmit), sets the slow-start threshold to ${th}, half of what was on the way, and drops its window to 1 packet.`,
      why: "Tahoe treats any loss the same way: back to slow start.",
    }
  if ((r = t.match(/^third duplicate: fast retransmit (\d+)/)))
    return {
      title: "Third repeat: resend at once",
      text: `Three repeated acknowledgements for packet ${r[1]}. The sender treats it as lost and resends it without waiting for its timer (fast retransmit). The slow-start threshold becomes ${th}, ${
        algo === "cubic" ? "0.7 times" : "half"
      } of what was on the way.`,
      why: "A loss is the sender's only sign that the path is full, so it slows down.",
    }
  if (t.startsWith("enter fast recovery"))
    return {
      title: "Repair mode (fast recovery)",
      text: `The window becomes the threshold plus three: ${w}.`,
      why: "The three repeats each stand for a packet that has left the network, so three more may go. The sender stays in this mode until the lost packet is acknowledged.",
    }
  if ((r = t.match(/^(?:full )?ACK (\d+): leave fast recovery/)))
    return {
      title: "Repair done",
      text: `ACK ${r[1]} acknowledges the resent packet and everything sent before the loss. The sender leaves repair mode with a window of ${w}.`,
      why: "From here it grows again, more slowly than before the loss.",
    }
  if ((r = t.match(/^partial ACK (\d+): retransmit (\d+)/)))
    return {
      title: "Partly repaired",
      text: `ACK ${r[1]} acknowledges the resent packet, but not everything sent before the loss: packet ${r[2]} is missing too. The sender resends it and stays in repair mode.`,
      why: "Treating several losses from one window as one avoids cutting the window again and again.",
    }
  if ((r = t.match(/^timeout on (\d+)/)))
    return {
      title: "The timer runs out",
      text: `No acknowledgement for packet ${r[1]} came back in time. The sender treats it as lost: its window drops to 1 packet, the slow-start threshold to ${th}, and its timer doubles to ${formatTime(s.rto_us)}.`,
      why: "A timeout means acknowledgements stopped coming altogether, a worse sign than repeats, so the sender starts again from slow start.",
    }
  return { title: "", text: t }
}
