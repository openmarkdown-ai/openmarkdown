/**
 * Enrolling a vault on this device: a new account, a join from a code, or a
 * restore from a printed kit. Each ends with a device record in IndexedDB —
 * keys wrapped, nothing in the vault folder — and no key ever on screen.
 */
import { device as devices, wrap, type DeviceRecord, type Secrets } from "./store";
import { defaultDeviceLabel, endpointFor, HOSTED_WS, mixedContentProblem, type Endpoint } from "./words";

export interface ServerChoice {
  /** Empty for the hosted server. */
  address: string;
}

export function endpointOf(choice: ServerChoice): Endpoint {
  const endpoint = choice.address.trim() ? endpointFor(choice.address) : endpointFor(HOSTED_WS);
  const problem = mixedContentProblem(endpoint.ws);
  if (problem) throw new Error(problem);
  return endpoint;
}

async function record(vaultId: string, secrets: Secrets, accountId: string, namespace: string, endpoint: Endpoint, deviceLabel: string, extra: Partial<DeviceRecord> = {}): Promise<DeviceRecord> {
  const others = (await devices.vaultsForAccount(accountId)).filter((id) => id !== vaultId);
  if (others.length) {
    // One namespace per account: a second vault here would merge into the first.
    throw new Error("This account already syncs another vault in this browser. Open that vault instead — one account syncs one vault.");
  }
  const r: DeviceRecord = {
    v: 1,
    vaultId,
    accountId,
    namespace,
    relayWs: endpoint.ws,
    relayHttp: endpoint.http,
    deviceLabel: deviceLabel.trim() || defaultDeviceLabel(),
    carryAttachments: false,
    plan: "free",
    paused: false,
    enrolledAt: Date.now(),
    wrapped: await wrap(secrets),
    ...extra,
  };
  await devices.set(r);
  return r;
}

/** A new account for this vault. Returns the record; the caller shows the kit step. */
export async function setUpNew(vaultId: string, server: ServerChoice, deviceLabel: string): Promise<DeviceRecord> {
  const engine = await import("./engine");
  const endpoint = endpointOf(server);
  await engine.probe(endpoint);
  const { secrets, accountId } = await engine.createAccount(deviceLabel);
  // Carry attachments by default on a server of your own, where nothing is metered.
  const own = !!server.address.trim();
  return record(vaultId, secrets, accountId, engine.NAMESPACE, endpoint, deviceLabel, { carryAttachments: own });
}

/** Join an account from a code shown on another device. */
export async function joinWithCode(
  target: string | ((grantedBy: string) => Promise<string>),
  code: string,
  server: ServerChoice,
  deviceLabel: string,
): Promise<{ record: DeviceRecord; grantedBy: string }> {
  const engine = await import("./engine");
  const trimmed = code.trim();
  if (!trimmed) throw new Error("Type the code shown on the other device.");
  const endpoint = /^opensync:/i.test(trimmed) ? { ws: "", http: "" } : endpointOf(server);
  if (/^opensync:/i.test(trimmed)) {
    const ws = decodeURIComponent(/[?&]ws=([^#&]+)/.exec(trimmed)?.[1] ?? "");
    const problem = ws ? mixedContentProblem(ws) : null;
    if (problem) throw new Error(problem);
  }
  let joined;
  try {
    joined = await engine.join(trimmed, endpoint.ws || HOSTED_WS);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/nothing answered/i.test(msg)) throw new Error("Nothing answered that code. Check it, keep the other device's code screen open, and make sure both use the same sync server.");
    if (/did not prove|did not match|could not verify/i.test(msg)) throw new Error("That code did not match. Codes work once — show a new code on the other device and try again.");
    if (/cannot reach/i.test(msg)) throw new Error(`Cannot reach the sync server. ${msg}`);
    throw e;
  }
  // A new vault is only created once the other device has answered, so a
  // mistyped code leaves nothing behind.
  if (typeof target !== "string" && (await devices.vaultsForAccount(joined.accountId)).length) {
    throw new Error("This account already syncs a vault in this browser. Open that vault from the list instead — one account syncs one vault.");
  }
  const vaultId = typeof target === "string" ? target : await target(joined.grantedBy);
  const r = await record(vaultId, joined.secrets, joined.accountId, joined.namespace, joined.endpoint, deviceLabel, {
    pullOnOpen: true,
    kitSaved: true,
    carryAttachments: !!server.address.trim() || !joined.endpoint.ws.includes("relay.opensync.network"),
  });
  return { record: r, grantedBy: joined.grantedBy };
}

/** Restore from the printed kit: the last copy of an account. */
export async function restoreFromKit(vaultId: string, kitText: string, server: ServerChoice, deviceLabel: string): Promise<DeviceRecord> {
  const engine = await import("./engine");
  const kit = await engine.readKit(kitText);
  const endpoint = endpointOf(server);
  await engine.probe(endpoint);
  return record(vaultId, kit.secrets, kit.accountId, kit.namespace, endpoint, deviceLabel, { pullOnOpen: true, kitSaved: true, carryAttachments: !!server.address.trim() });
}
