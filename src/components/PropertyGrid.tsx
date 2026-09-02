import { useCallback, useEffect, useRef, useState } from "react";
import {
  TransportClient,
  WireError,
  type Node,
  type PropertyDescriptor,
} from "../transport";
import { PropertyField, precheck, type FieldNotice } from "./PropertyField";

/**
 * One write produces several refresh triggers within a few milliseconds: the
 * write's own read-back, the property_changed event and, when a descriptor is
 * an EvalValue over the written property, property_descriptor_changed. Each
 * trigger used to cost a full descriptor reload plus one get_property_value per
 * property, so a single write cost ~30 follow-up requests. Triggers that land
 * inside this window collapse into one descriptor refresh and one value
 * refresh. WHAT is refreshed is unchanged.
 */
const REFRESH_COALESCE_WINDOW_MS = 50;

/**
 * Descriptor-driven property grid.
 *
 * Two rules from the contract are load-bearing here:
 *  - after set_property_value the displayed value is taken from the resulting
 *    property_changed event or a read-back, never from what was submitted,
 *    because a coercer may have changed it;
 *  - property_changed refreshes DESCRIPTORS as well as values, because
 *    visible/read_only/min/max can be EvalValue expressions over other
 *    properties, so writing A can reshape B's widget.
 */
export function PropertyGrid({
  client,
  node,
}: {
  client: TransportClient;
  node: Node;
}) {
  const [descriptors, setDescriptors] = useState<PropertyDescriptor[] | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fieldNotices, setFieldNotices] = useState<Record<string, FieldNotice>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const generation = useRef(0);

  const readDescriptorsAndValuesFromHost = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const ds = await client.call("get_property_descriptors", {
        node_id: node.id,
      });
      const vs = await Promise.all(
        ds.map(async (d) => {
          try {
            return [
              d.id,
              await client.call("get_property_value", {
                node_id: node.id,
                property_id: d.id,
              }),
            ] as const;
          } catch {
            return [d.id, undefined] as const;
          }
        }),
      );
      if (gen !== generation.current) return; // a newer reload won
      setDescriptors(ds);
      setValues(Object.fromEntries(vs));
      setLoadError(null);
    } catch (e) {
      if (gen !== generation.current) return;
      setDescriptors([]);
      setValues({});
      setLoadError(e instanceof WireError ? `${e.code}: ${e.detail}` : String(e));
    }
  }, [client, node.id]);

  const coalesceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Asks for one refresh; every ask inside REFRESH_COALESCE_WINDOW_MS shares it. */
  const refreshFromHostSoon = useCallback(() => {
    if (coalesceTimer.current !== null) clearTimeout(coalesceTimer.current);
    coalesceTimer.current = setTimeout(() => {
      coalesceTimer.current = null;
      void readDescriptorsAndValuesFromHost();
    }, REFRESH_COALESCE_WINDOW_MS);
  }, [readDescriptorsAndValuesFromHost]);

  useEffect(
    () => () => {
      if (coalesceTimer.current !== null) clearTimeout(coalesceTimer.current);
    },
    [],
  );

  useEffect(() => {
    setDescriptors(null);
    setValues({});
    setFieldNotices({});
    setLoadError(null);
    void readDescriptorsAndValuesFromHost();
  }, [readDescriptorsAndValuesFromHost]);

  // A write anywhere on this node can reshape any descriptor on it, so both
  // events trigger a full descriptor + value refresh.
  useEffect(() => {
    const offValue = client.on("property_changed", (p) => {
      if (p.node_id === node.id) refreshFromHostSoon();
    });
    const offDesc = client.on("property_descriptor_changed", (p) => {
      if (p.node_id === node.id) refreshFromHostSoon();
    });
    return () => {
      offValue();
      offDesc();
    };
  }, [client, node.id, refreshFromHostSoon]);

  const write = useCallback(
    async (d: PropertyDescriptor, value: unknown) => {
      const local = precheck(d, value);
      if (local !== null) {
        setFieldNotices((prev) => ({
          ...prev,
          [d.id]: { severity: "rejected", text: local },
        }));
        return;
      }
      setPending((prev) => ({ ...prev, [d.id]: true }));
      try {
        await client.call("set_property_value", {
          node_id: node.id,
          property_id: d.id,
          value,
        });
        setFieldNotices((prev) => {
          const next = { ...prev };
          delete next[d.id];
          return next;
        });
      } catch (e) {
        // A timeout is not a refusal: the deadline is the client's, and a slow
        // host may still apply the write afterwards. Say so, and let the value
        // on screen be whatever the host reports after the refresh below.
        const notice: FieldNotice =
          e instanceof WireError && e.code === "timeout"
            ? {
                severity: "unconfirmed",
                text:
                  `${e.code}: ${e.detail}. Writing ${d.name} = ${JSON.stringify(value)} ` +
                  `may still have been applied by the host — the value shown was re-read ` +
                  `from the host after the deadline passed, not taken from what was typed.`,
              }
            : {
                severity: "rejected",
                text:
                  e instanceof WireError ? `${e.code}: ${e.detail}` : String(e),
              };
        setFieldNotices((prev) => ({ ...prev, [d.id]: notice }));
      } finally {
        setPending((prev) => {
          const next = { ...prev };
          delete next[d.id];
          return next;
        });
      }
      // Read back unconditionally, including after a timeout, so the grid
      // resynchronises instead of sitting on a value nothing confirmed. The
      // host may or may not have emitted property_changed; either way the value
      // on screen comes from the host, and the coalescer folds this read-back
      // together with any event the same write raised.
      refreshFromHostSoon();
    },
    [client, node.id, refreshFromHostSoon],
  );

  if (loadError !== null) {
    return (
      <div className="pad">
        <p className="error" role="alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (descriptors === null) {
    return <p className="muted pad">Reading descriptors…</p>;
  }

  const visible = descriptors.filter((d) => d.visible);
  if (visible.length === 0) {
    return <p className="muted pad">No visible properties on this component.</p>;
  }

  return (
    <div className="grid">
      {visible.map((d) => (
        <PropertyField
          key={d.id}
          descriptor={d}
          value={values[d.id]}
          notice={fieldNotices[d.id] ?? null}
          pending={pending[d.id] === true}
          onWrite={(v) => write(d, v)}
          onRereadFromHost={() => {
            setFieldNotices((prev) => {
              const next = { ...prev };
              delete next[d.id];
              return next;
            });
            refreshFromHostSoon();
          }}
        />
      ))}
    </div>
  );
}
