import { useState } from "react"

import { Button } from "@/components/ui/button"
import { ParamSlider, ParamSwitch } from "../../components/Controls"
import { ALGOS, type Algo, type TcpParams } from "../../core/tcp"

const RATES = [1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8]
const rateLabel = (r: number) => `${r / 1e6} Mb/s`
const ms = (us: number) => `${(us / 1000).toFixed(us < 10_000 ? 1 : 0)} ms`
/** The model allows at most this many packets through the bottleneck in one run. */
const MAX_PACKETS = 3e6

function AlgoSelect({ id, value, onChange, none }: { id: string; value: Algo | null; onChange(a: Algo | null): void; none?: string }) {
  return (
    <select
      id={id}
      className="rounded-sm border border-input bg-background px-1 py-0.5"
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || null) as Algo | null)}
    >
      {none && <option value="">{none}</option>}
      {ALGOS.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} ({a.rfc})
        </option>
      ))}
    </select>
  )
}

/** Every parameter of the model, with its unit and range. */
export function TcpSetup({
  p,
  set,
  cmp,
  setCmp,
}: {
  p: TcpParams
  set(p: TcpParams): void
  cmp: Algo | null
  setCmp(a: Algo | null): void
}) {
  const [seg, setSeg] = useState("")
  const tx = (8 * p.mss_bytes * 1e6) / p.rate_bps
  const maxDuration = Math.min(120e6, Math.floor((MAX_PACKETS / (p.rate_bps / (8 * p.mss_bytes))) * 1e6))
  const flow = (i: number, change: Partial<TcpParams["flows"][number]>) =>
    set({ ...p, flows: p.flows.map((f, j) => (j === i ? { ...f, ...change } : f)) })

  return (
    <div className="space-y-5">
      <fieldset className="space-y-4 rounded-sm border border-border p-3">
        <legend className="px-1 font-sans text-xs text-muted-foreground">
          Flows sharing the bottleneck (the ladder and trace follow flow 1)
        </legend>
        {p.flows.map((f, i) => (
          <div key={i} className="space-y-2 border-b border-border pb-3 last:border-b-0 last:pb-0">
            <div className="flex items-center justify-between gap-2 font-sans text-sm">
              <label htmlFor={`tcp-algo-${i}`}>Flow {i + 1}</label>
              <span className="flex items-center gap-2">
                <AlgoSelect id={`tcp-algo-${i}`} value={f.algo} onChange={(a) => a && flow(i, { algo: a })} />
                {i > 0 && (
                  <Button size="xs" variant="ghost" onClick={() => set({ ...p, flows: p.flows.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                )}
              </span>
            </div>
            <ParamSlider
              label="Propagation round trip"
              value={f.rtt_us}
              min={2000}
              max={500_000}
              log
              format={ms}
              onChange={(v) => flow(i, { rtt_us: Math.round(v) })}
            />
            {i > 0 && (
              <ParamSlider
                label="Starts at"
                value={f.start_us}
                min={0}
                max={p.duration_us - 1}
                step={100_000}
                format={(v) => `${(v / 1e6).toFixed(1)} s`}
                onChange={(v) => flow(i, { start_us: v })}
              />
            )}
          </div>
        ))}
        {p.flows.length < 4 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => set({ ...p, flows: [...p.flows, { algo: "reno", rtt_us: p.flows[0].rtt_us, start_us: 0 }] })}
          >
            Add a flow
          </Button>
        )}
      </fieldset>

      <div className="grid grid-cols-[1fr_auto] items-center gap-2 font-sans text-sm">
        <label htmlFor="tcp-compare">Also draw flow 1 as</label>
        <AlgoSelect id="tcp-compare" value={cmp} onChange={setCmp} none="nothing else" />
      </div>

      <div className="grid grid-cols-[1fr_auto] items-center gap-2 font-sans text-sm">
        <label htmlFor="tcp-rate">Bottleneck rate R</label>
        <select
          id="tcp-rate"
          className="rounded-sm border border-input bg-background px-1 py-0.5"
          value={p.rate_bps}
          onChange={(e) => {
            const rate = Number(e.target.value)
            const cap = Math.floor((MAX_PACKETS / (rate / (8 * p.mss_bytes))) * 1e6)
            set({ ...p, rate_bps: rate, duration_us: Math.min(p.duration_us, cap) })
          }}
        >
          {(RATES.includes(p.rate_bps) ? RATES : [...RATES, p.rate_bps].sort((a, b) => a - b)).map((r) => (
            <option key={r} value={r}>
              {rateLabel(r)}
            </option>
          ))}
        </select>
      </div>
      <p className="font-sans text-xs text-muted-foreground">
        One segment takes {ms(tx)} to send at this rate; the bandwidth-delay product of flow 1 is{" "}
        {((p.flows[0].rtt_us + tx) / tx).toFixed(0)} segments.
      </p>
      <ParamSlider
        label="Buffer B (packets waiting, besides the one being sent)"
        value={p.buffer_pkts}
        min={0}
        max={1000}
        format={(b) => `${b}`}
        onChange={(v) => set({ ...p, buffer_pkts: v })}
      />
      <ParamSlider
        label="Segment size (MSS)"
        value={p.mss_bytes}
        min={500}
        max={9000}
        step={10}
        format={(b) => `${b} bytes`}
        onChange={(v) => set({ ...p, mss_bytes: v, duration_us: Math.min(p.duration_us, maxDuration) })}
      />
      <ParamSlider
        label="Random loss, each packet"
        value={p.loss}
        min={0}
        max={0.05}
        step={0.0005}
        format={(x) => (x === 0 ? "none" : x.toFixed(4))}
        onChange={(v) => set({ ...p, loss: v })}
      />
      <ParamSwitch
        label="Periodic loss"
        name="Drop every n-th packet of each flow"
        checked={p.drop_every > 0}
        onChange={(v) => set({ ...p, drop_every: v ? 1000 : 0 })}
        on={`every ${p.drop_every}-th packet of each flow is dropped`}
        off="off"
      />
      {p.drop_every > 0 && (
        <ParamSlider
          label="Drop every n-th packet"
          value={p.drop_every}
          min={20}
          max={100_000}
          log
          format={(n) => `n = ${n}, p = ${(1 / n).toExponential(1)}`}
          onChange={(v) => set({ ...p, drop_every: Math.round(v) })}
        />
      )}
      <ParamSlider
        label="Jitter at the sender (uniform, 0 to J)"
        value={p.jitter_us}
        min={0}
        max={20_000}
        step={250}
        format={ms}
        onChange={(v) => set({ ...p, jitter_us: v })}
      />
      <ParamSlider
        label="Initial window"
        value={p.iw}
        min={1}
        max={10}
        format={(v) => `${v} segment${v === 1 ? "" : "s"}`}
        onChange={(v) => set({ ...p, iw: v })}
      />
      <ParamSlider
        label="Initial ssthresh"
        value={Math.min(p.init_ssthresh, 10_000)}
        min={2}
        max={10_000}
        log
        format={(v) => (v >= 10_000 ? "no limit" : `${v} segments`)}
        onChange={(v) => set({ ...p, init_ssthresh: v >= 10_000 ? 1e9 : Math.round(v) })}
      />
      <ParamSlider
        label="Minimum RTO"
        value={p.min_rto_us}
        min={100_000}
        max={3_000_000}
        step={50_000}
        format={ms}
        onChange={(v) => set({ ...p, min_rto_us: v })}
      />
      {p.flows.some((f) => f.algo === "cubic") && (
        <ParamSwitch
          label="CUBIC fast convergence"
          name="CUBIC fast convergence (RFC 9438, 4.7)"
          checked={p.fast_convergence}
          onChange={(v) => set({ ...p, fast_convergence: v })}
          on="a flow whose maximum fell lowers W_max further"
          off="W_max is the window at the loss"
        />
      )}
      <ParamSlider
        label="Duration"
        value={p.duration_us}
        min={1_000_000}
        max={maxDuration}
        step={1_000_000}
        format={(v) => `${(v / 1e6).toFixed(0)} s`}
        onChange={(v) => set({ ...p, duration_us: v, flows: p.flows.map((f) => ({ ...f, start_us: Math.min(f.start_us, v - 1) })) })}
      />
      <div className="flex items-center justify-between font-sans text-sm">
        <span>
          Seed <span className="text-muted-foreground tabular-nums">{p.seed}</span>
        </span>
        <Button size="sm" variant="outline" onClick={() => set({ ...p, seed: (p.seed * 1103515245 + 12345) % 2147483647 })}>
          New seed
        </Button>
      </div>

      <div className="space-y-2 font-sans text-sm">
        <p className="text-xs text-muted-foreground">
          Segments of flow 1 to drop. Click a data packet in the ladder and press D, or add one here (its first transmission).
        </p>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const n = Number(seg)
            if (!Number.isInteger(n) || n < 0 || p.drops.length >= 64) return
            if (!p.drops.some((d) => d.flow === 0 && d.seg === n && d.occurrence === 1))
              set({ ...p, drops: [...p.drops, { flow: 0, seg: n, occurrence: 1 }] })
            setSeg("")
          }}
        >
          <label htmlFor="tcp-drop" className="sr-only">
            Segment number to drop
          </label>
          <input
            id="tcp-drop"
            inputMode="numeric"
            className="w-24 rounded-sm border border-input bg-background px-1.5 py-0.5"
            placeholder="segment"
            value={seg}
            onChange={(e) => setSeg(e.target.value.replace(/\D/g, ""))}
          />
          <Button size="sm" variant="outline" type="submit" disabled={!seg || p.drops.length >= 64}>
            Drop it
          </Button>
        </form>
        {p.drops.length > 0 && (
          <ul className="space-y-1">
            {p.drops.map((d, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span>
                  {p.flows.length > 1 ? `flow ${d.flow + 1}, ` : ""}segment {d.seg}
                  {d.occurrence > 1 ? `, transmission ${d.occurrence}` : ""}
                </span>
                <Button size="xs" variant="ghost" onClick={() => set({ ...p, drops: p.drops.filter((_, j) => j !== i) })}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
