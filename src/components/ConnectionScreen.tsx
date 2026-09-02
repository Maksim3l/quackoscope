import { useState } from "react";
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

  return (
    <div className="screen screen--centered">
      <div className="card">
        <h2>Connect a device</h2>
        <p className="muted">
          The host resolves the connection string through openDAQ. A reference
          device needs no hardware.
        </p>
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
