import { useState } from "react";
import { CapabilityGapNotice } from "../session/CapabilityGapNotice";
import {
  useCapabilityStanding,
  useHostProcessName,
} from "../session/host-capability-context";
import { OpButton, OpInput } from "../ui/op";

const DEFAULT_CONNECTION_STRING = "daqref://device0";

export function ConnectionScreen({
  busy,
  error,
  onConnect,
}: {
  busy: boolean;
  error: string | null;
  onConnect: (connectionString: string) => void;
}) {
  const [connectionString, setConnectionString] = useState(
    DEFAULT_CONNECTION_STRING,
  );
  const connectStanding = useCapabilityStanding("device.connect");
  const hostProcessName = useHostProcessName();
  const connectIsGapped =
    connectStanding !== null && !connectStanding.served && connectStanding.gap !== null;

  return (
    <div className="screen screen--centered">
      <div className="card">
        <h2>Connect a device</h2>
        <p className="muted">
          The host resolves the connection string through openDAQ. A reference
          device needs no hardware.
        </p>

        {connectIsGapped && (
          <CapabilityGapNotice
            standing={connectStanding}
            hostProcessName={hostProcessName}
            whatIsBlocked={`No device can be connected through ${hostProcessName}. The connection string box and the Connect button below are disabled for this session; switching to another backend is the only way past it from here.`}
          />
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) onConnect(connectionString.trim());
          }}
        >
          <OpInput
            op={["device.connect"]}
            className="grow"
            aria-label="connection string"
            value={connectionString}
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setConnectionString(e.currentTarget.value)}
          />
          <OpButton
            op={["device.connect"]}
            type="submit"
            disabled={busy || connectionString.trim().length === 0}
          >
            {busy ? "Connecting…" : "Connect"}
          </OpButton>
        </form>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
