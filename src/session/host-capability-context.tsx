import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { LinkState } from "../transport";
import {
  computeCapabilityStandings,
  hostProcessNameOf,
  type CapabilityStanding,
  type HandshakeReading,
  type HostCapabilityReading,
} from "./host-handshake";
import { isBaselineCapabilityId } from "./capability-baseline";

/**
 * The session's handshake, held once and read from everywhere that needs to know
 * whether a capability is served.
 *
 * The rule this context enforces: a control is blocked ONLY by a computed gap.
 * Before a handshake arrives there is no evidence of any gap, so nothing is
 * blocked — a silent host is not treated as a host that can do nothing, because
 * disabling the app on no evidence would be inventing gaps the same way a
 * host-supplied gap list would.
 *
 * The socket's state is carried alongside, because a handshake only ever
 * describes a LIVE session. LinkState says so itself for "closed": "The socket
 * dropped or never came up. The session is invalid; state must be cleared." So
 * App clears handshakeReading the moment the link leaves "open", and socketState
 * is here so the header can say which of the four states the socket is in by
 * name rather than falling silent.
 */

export interface HostSession {
  /** The URL this session's socket was opened against. */
  backendUrl: string;
  /** The socket right now. A handshake is only ever valid while this is "open". */
  socketState: LinkState;
  /** null until the host's first non-envelope message arrives. */
  handshakeReading: HandshakeReading | null;
  /** null unless a handshake was read: gaps are computed only from a real handshake. */
  capabilityReading: HostCapabilityReading | null;
  /** Non-envelope text messages after the first one; the contract expects none. */
  strayNonEnvelopeMessageCount: number;
}

const HostSessionContext = createContext<HostSession | null>(null);

export function HostSessionProvider({
  backendUrl,
  socketState,
  handshakeReading,
  strayNonEnvelopeMessageCount,
  children,
}: {
  backendUrl: string;
  socketState: LinkState;
  handshakeReading: HandshakeReading | null;
  strayNonEnvelopeMessageCount: number;
  children: ReactNode;
}) {
  const session = useMemo<HostSession>(
    () => ({
      backendUrl,
      socketState,
      handshakeReading,
      capabilityReading:
        handshakeReading !== null && handshakeReading.read
          ? computeCapabilityStandings(handshakeReading.handshake)
          : null,
      strayNonEnvelopeMessageCount,
    }),
    [backendUrl, socketState, handshakeReading, strayNonEnvelopeMessageCount],
  );
  return (
    <HostSessionContext.Provider value={session}>
      {children}
    </HostSessionContext.Provider>
  );
}

export function useHostSession(): HostSession | null {
  return useContext(HostSessionContext);
}

/** The connected host's implementation.name, for printing. Display only. */
export function useHostProcessName(): string {
  return hostProcessNameOf(useContext(HostSessionContext)?.handshakeReading ?? null);
}

/**
 * implementation.name exactly as the handshake carried it, or null when no
 * handshake has been read. Display only, by contract: the two callers are the
 * header, which prints it, and the flock, which uses it to decide which snippet
 * column carries the "running host" label.
 */
export function useHostImplementationName(): string | null {
  const reading = useContext(HostSessionContext)?.handshakeReading ?? null;
  return reading !== null && reading.read
    ? reading.handshake.implementation.name
    : null;
}

/**
 * The gapped capabilities among the operation ids a control declares.
 *
 * An operation id that is not a baseline capability id — session.reconnect is
 * one, because reopening a socket is a client-side action and makes no openDAQ
 * call — can never be gapped and is skipped.
 */
export function useCapabilityGapsBlocking(
  operationIds: readonly string[],
): CapabilityStanding[] {
  const session = useHostSession();
  const reading = session?.capabilityReading ?? null;
  const key = operationIds.join(" ");
  return useMemo(() => {
    if (reading === null) return [];
    const blocking: CapabilityStanding[] = [];
    for (const operationId of key.split(" ").filter((id) => id.length > 0)) {
      if (!isBaselineCapabilityId(operationId)) continue;
      const standing = reading.standingByCapabilityId.get(operationId);
      if (standing !== undefined && !standing.served) blocking.push(standing);
    }
    return blocking;
  }, [reading, key]);
}

export function useCapabilityStanding(
  capabilityId: string,
): CapabilityStanding | null {
  const session = useHostSession();
  return session?.capabilityReading?.standingByCapabilityId.get(capabilityId) ?? null;
}
