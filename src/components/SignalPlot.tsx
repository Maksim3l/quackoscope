import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { TransportClient, WireError, type Node } from "../transport";

/**
 * One plot, fed by subscribe_signal.
 *
 * Sample data NEVER enters React state or reconciliation. The uPlot instance,
 * the column buffers and the frame counter all live in refs / effect-local
 * closures, and updates go straight into the canvas on a rAF tick. React state
 * here holds only the subscription's lifecycle status and any error text.
 *
 * Decimation is the host's job: the plot's own pixel width is sent as
 * pixel_columns and the host answers with min/max envelope frames whose
 * sample_count is at most that.
 */
export function SignalPlot({
  client,
  signal,
}: {
  client: TransportClient;
  signal: Node;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const statsRef = useRef<HTMLSpanElement | null>(null);
  const [state, setState] = useState<"subscribing" | "live" | "error">(
    "subscribing",
  );
  const [error, setError] = useState<string | null>(null);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let subId: string | null = null;
    let subNum = -1;
    let raf = 0;
    let dirty = false;
    let frames = 0;
    let xs = new Float64Array(0);
    let mins = new Float64Array(0);
    let maxs = new Float64Array(0);

    const pixelColumns = Math.max(64, Math.floor(host.clientWidth) || 640);

    const plot = new uPlot(
      {
        width: pixelColumns,
        height: 260,
        cursor: { drag: { x: false, y: false } },
        legend: { show: false },
        scales: { x: { time: false } },
        axes: [
          { stroke: "#8b949e", grid: { stroke: "#232a33" } },
          { stroke: "#8b949e", grid: { stroke: "#232a33" } },
        ],
        series: [
          {},
          { label: "min", stroke: "#4aa3ff", width: 1, points: { show: false } },
          { label: "max", stroke: "#ffa657", width: 1, points: { show: false } },
        ],
      },
      [[], [], []] as unknown as uPlot.AlignedData,
      host,
    );

    const flush = () => {
      raf = 0;
      if (disposed || !dirty) return;
      dirty = false;
      plot.setData([xs, mins, maxs] as unknown as uPlot.AlignedData);
      if (statsRef.current) {
        statsRef.current.textContent = `${frames} frames · ${xs.length} columns`;
      }
    };

    // rAF is the normal coalescer. Some embedded WebViews and offscreen tabs
    // starve rAF entirely, which would leave the canvas blank forever, so a slow
    // timer acts as a safety net. flush() is idempotent on the dirty flag, so
    // whichever fires first wins and the other is a no-op.
    const fallbackTick = setInterval(() => {
      if (dirty) flush();
    }, 100);

    const offData = client.onData((f) => {
      if (f.subscription_id !== subNum) return;
      frames += 1;
      const n = f.sample_count;
      if (xs.length !== n) {
        xs = new Float64Array(n);
        for (let i = 0; i < n; i++) xs[i] = i;
        mins = new Float64Array(n);
        maxs = new Float64Array(n);
      }
      if (f.encoding === 1) {
        for (let i = 0; i < n; i++) {
          mins[i] = f.values[2 * i];
          maxs[i] = f.values[2 * i + 1];
        }
      } else {
        for (let i = 0; i < n; i++) {
          mins[i] = f.values[i];
          maxs[i] = f.values[i];
        }
      }
      dirty = true;
      if (raf === 0) raf = requestAnimationFrame(flush);
    });

    client
      .call("subscribe_signal", {
        signal_id: signal.id,
        pixel_columns: pixelColumns,
      })
      .then((id) => {
        if (disposed) {
          void client.call("unsubscribe_signal", { subscription_id: id }).catch(() => {});
          return;
        }
        subId = id;
        subNum = Number(id);
        setSubscriptionId(id);
        setState("live");
      })
      .catch((e) => {
        if (disposed) return;
        setState("error");
        setError(e instanceof WireError ? `${e.code}: ${e.detail}` : String(e));
      });

    return () => {
      disposed = true;
      clearInterval(fallbackTick);
      if (raf !== 0) cancelAnimationFrame(raf);
      offData();
      if (subId !== null) {
        void client
          .call("unsubscribe_signal", { subscription_id: subId })
          .catch(() => {});
      }
      plot.destroy();
    };
  }, [client, signal.id]);

  return (
    <div className="plot">
      <div className="plot-head">
        <strong>{signal.name}</strong>
        <span className="muted">
          {state === "subscribing" && "subscribing…"}
          {state === "live" && `subscription ${subscriptionId}`}
          {state === "error" && "subscription failed"}
        </span>
        <span className="muted" ref={statsRef} />
      </div>
      <div className="plot-canvas" ref={hostRef} />
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
