import { Button } from "@/components/ui/button"
import { HeaderDiagram, type HeaderField } from "../../components/HeaderDiagram"
import { formatTime } from "../../components/timeline"
import { WINDOW, tcpHeader, type Flight, type TcpParams } from "../../core/tcp"

export function TcpPacket({ f, p, scripted, onToggle }: { f: Flight; p: TcpParams; scripted: boolean; onToggle(): void }) {
  const h = tcpHeader(f, p)
  const flagNames = ["FIN", "SYN", "RST", "PSH", "ACK", "URG", "ECE", "CWR"].filter((_, i) => h.flags & (1 << i)).reverse()
  const fields: HeaderField[] = [
    { name: "source port", bits: 16, value: String(h.sport) },
    { name: "destination port", bits: 16, value: String(h.dport) },
    { name: "sequence number", bits: 32, value: String(h.seq) },
    { name: "acknowledgment number", bits: 32, value: String(h.ack) },
    { name: "offset", bits: 4, value: "5" },
    { name: "rsrvd", bits: 4, value: "0" },
    { name: "flags", bits: 8, value: flagNames.join(" ") },
    { name: "window", bits: 16, value: String(WINDOW) },
    { name: "checksum", bits: 16, value: `0x${h.checksum.toString(16).padStart(4, "0")}` },
    { name: "urgent pointer", bits: 16, value: "0" },
    { name: "addresses", bits: 0, value: `${h.src.join(".")} to ${h.dst.join(".")} (in the pseudo-header)`, hidden: true },
    {
      name: "segment",
      bits: 0,
      value: f.ack ? `ACK ${f.seg}: the next segment the receiver expects` : `data segment ${f.seg}`,
      hidden: true,
    },
    ...(f.ack
      ? []
      : [{ name: "transmission", bits: 0, value: f.occurrence > 1 ? `${f.occurrence} (a retransmission)` : "1", hidden: true }]),
    { name: "first bit leaves", bits: 0, value: formatTime(f.t_start), hidden: true },
    {
      name: f.lost ? "dropped" : "arrives",
      bits: 0,
      value: f.lost ? formatTime(f.t_arrive) : f.t_arrive > 1e15 ? "after the end of the run" : formatTime(f.t_arrive),
      hidden: true,
    },
    { name: "outcome", bits: 0, value: f.fate || "in flight", hidden: true },
  ]
  return (
    <div className="space-y-3">
      <HeaderDiagram
        title={f.ack ? `ACK ${f.seg}, receiver to sender` : `Segment ${f.seg}${f.occurrence > 1 ? " (again)" : ""}, sender to receiver`}
        fields={fields}
        note={`RFC 9293 layout with relative sequence numbers. The model sends packets of ${p.mss_bytes} bytes, so each carries ${Math.max(0, p.mss_bytes - 40)} bytes of data after 40 of IP and TCP headers; ACKs carry none. The checksum is RFC 1071 over the pseudo-header, the header and a stand-in payload. The model's receiver never limits the sender, so the window field is constant.`}
      />
      {!f.ack && (
        <Button
          size="sm"
          variant={f.lost && !scripted ? "outline" : scripted ? "outline" : "destructive"}
          onClick={onToggle}
          disabled={f.lost && !scripted}
        >
          {scripted ? "Undo: let it through" : f.lost ? "Lost in the network (not your edit)" : "Drop this transmission (D)"}
        </Button>
      )}
    </div>
  )
}
