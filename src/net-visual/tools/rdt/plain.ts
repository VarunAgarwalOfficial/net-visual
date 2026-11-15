// The step card's words. The simulation's own event texts are terse and use
// the textbook's notation ("ACK 1 read as 1: advances base; base = 2"); they
// stay in the trace and the source. This turns each into a full sentence that
// says what happened and why, with every term spelled out.

import type { RdtEvent, RdtParams, RdtRun } from "../../core/rdt"
import { formatTime } from "../../components/timeline"

export interface Plain {
  title: string
  text: string
  why?: string
}

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)

export function plainRdt(e: RdtEvent, run: RdtRun, p: RdtParams): Plain {
  const n = p.messages
  const m = 2 ** p.seq_bits
  const one = p.window === 1
  const cumulative = p.rules.ack === "cumulative"
  const T = formatTime(p.timeout_us)
  const t = e.text
  let r: RegExpMatchArray | null

  if (t.startsWith("start:"))
    return {
      title: "Start",
      text: `The application hands the sender ${n} message${n === 1 ? "" : "s"} to deliver, in order.`,
      why: one
        ? "This sender sends one message and waits for it to be acknowledged before it sends the next."
        : `This sender may have up to ${p.window} messages sent but not yet acknowledged at once (its window).`,
    }
  if ((r = t.match(/^send message (\d+) as seq (\d+)/)))
    return {
      title: "Next message",
      text: `The sender takes message ${r[1]} and gives it sequence number ${r[2]}.`,
      why:
        m < n
          ? `Sequence numbers count from 0 to ${m - 1} and then start again, so message ${r[1]} travels as ${r[2]}. The receiver uses the number to tell a new message from a repeated one.`
          : "The receiver uses the number to tell a new message from a repeated one.",
    }
  if ((r = t.match(/^transmit seq (\d+)( \(again\))?/)))
    return {
      title: r[2] ? "Send it again" : "Send",
      text: `The sender puts packet ${r[1]} on the link${r[2] ? " a second time" : ""} and starts a timer of ${T}.`,
      why: `If no acknowledgement (ACK) for it comes back before the timer runs out, the sender will assume it was lost and send it again.`,
    }
  if ((r = t.match(/^ACK (\d+) read as (-?\d+): (advances base|marks one|duplicate|ignored); base = (\d+)/))) {
    const [, w, k, fate, base] = r
    const done = Number(base) >= n
    const waiting = done
      ? "Every message has now been acknowledged."
      : `The oldest message still waiting for an ACK is now message ${base}.`
    if (fate === "advances base")
      return {
        title: "Acknowledgement arrives",
        text: `ACK ${w} reaches the sender: the receiver has everything up to message ${k}.`,
        why: `The sender stops the timer for ${Number(k) === Number(base) - 1 && one ? "that message" : "those messages"}. ${waiting}`,
      }
    if (fate === "marks one")
      return {
        title: "Acknowledgement arrives",
        text: `ACK ${w} reaches the sender: the receiver has message ${k}.`,
        why: `Each packet is acknowledged on its own here, so the sender marks just that one as done. ${waiting}`,
      }
    if (fate === "duplicate")
      return {
        title: "A repeated acknowledgement",
        text: `ACK ${w} arrives again, for message ${k}, which was already acknowledged.`,
        why: "It tells the sender nothing new, so the sender ignores it.",
      }
  }
  if ((r = t.match(/^ACK (\d+)/)))
    return {
      title: "An acknowledgement nobody needs",
      text: `ACK ${r[1]} matches nothing the sender is waiting for, so it is ignored.`,
    }
  if (t.startsWith("every message acknowledged"))
    return {
      title: "Done",
      text: `Every message has been delivered and acknowledged, at ${formatTime(e.t)}.`,
    }
  if ((r = t.match(/^timer for seq (\d+) expires: resend (.*)$/))) {
    const resend = r[2].split(", ")
    return {
      title: "The timer runs out",
      text: `No acknowledgement for packet ${r[1]} came back within ${T}, so the sender sends ${
        resend.length > 1 ? `packets ${list(resend)}` : `packet ${resend[0]}`
      } again.`,
      why:
        (resend.length > 1 ? "This sender resends every packet it has sent but not had acknowledged, not only the missing one. " : "") +
        "The sender cannot tell a lost packet from a slow one; it only knows the timer ran out.",
    }
  }
  const flight = e.flight !== null ? run.flights[e.flight] : null
  const wrong = flight?.fate.includes("wrong")
    ? ` In fact it carries message ${flight.number}: the numbers repeat too soon, so an old copy looks new.`
    : ""
  if ((r = t.match(/^seq (\d+) read as (\d+): deliver (.*)$/))) {
    const passed = r[3]
    const many = passed.includes(" to ") || passed.includes(",")
    return {
      title: "Packet arrives",
      text: `Packet ${r[1]} reaches the receiver as message ${r[2]}, and the receiver hands message${many ? "s" : ""} ${passed} to the application.${wrong}`,
      why: many
        ? "Messages are handed over only in order; this one filled a gap, so the ones held behind it go up too."
        : "Messages are handed over only in order, and this is the one the receiver was waiting for.",
    }
  }
  if ((r = t.match(/^seq (\d+) read as (\d+), past the last message/)))
    return {
      title: "An old copy taken for new",
      text: `Packet ${r[1]} reaches the receiver, which takes it for message ${r[2]}, beyond the last one.${wrong}`,
      why: "The receiver sees only the sequence number, and with so few numbers an old copy and a new message look the same.",
    }
  if ((r = t.match(/^seq (\d+) read as (\d+): buffer it/)))
    return {
      title: "Packet arrives early",
      text: `Packet ${r[1]} reaches the receiver as message ${r[2]}, but an earlier message is still missing, so the receiver keeps it for later.${wrong}`,
      why: "Messages are handed to the application only in order; this one waits until the gap before it is filled.",
    }
  if ((r = t.match(/^seq (\d+) read as old (\d+)/)))
    return {
      title: "A copy arrives",
      text: `Packet ${r[1]} arrives again: the receiver already has message ${r[2]}, so it throws the copy away and acknowledges it once more.`,
      why: "The sender only resends when its acknowledgement was lost or late, so the receiver repeats it.",
    }
  if ((r = t.match(/^seq (\d+) is not the expected (\d+)/)))
    return {
      title: "Packet thrown away",
      text: `Packet ${r[1]} arrives, but the receiver is waiting for ${r[2]}, so it throws this one away.`,
      why: p.rules.buffer
        ? "It falls outside the range of numbers the receiver can accept now."
        : "This receiver keeps nothing that arrives out of order; the sender will have to send it again.",
    }
  if ((r = t.match(/^queue ACK (\d+)/)))
    return {
      title: "Acknowledge",
      text: `The receiver sends acknowledgement (ACK) ${r[1]} back to the sender.`,
      why: cumulative
        ? `ACK ${r[1]} means: everything up to and including ${r[1]} has arrived.`
        : `ACK ${r[1]} means: packet ${r[1]} has arrived.`,
    }
  return { title: "", text: t }
}
