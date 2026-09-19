/**
 * Everything that needs the OpenSync client, loaded on demand.
 *
 * `index.ts` imports this with `import()` only when a vault is enrolled or a
 * sync screen opens, so the client, its signing library and the 1.2 MB wasm
 * stay out of the app for everyone who does not sync. The wasm is a Vite
 * asset, compiled while it streams; the client's inline base64 copy is
 * aliased away (`no-inline-wasm.ts`).
 */
import wasmUrl from "@opensync/wasm/opensync_wasm_bg.wasm?url";
import {
  drawInvitation,
  endpointsFor,
  FREE_EXTENSIONS,
  generateAccountKey,
  grantAccount,
  Invitation,
  isMetered,
  joinAccount,
  Namespace,
  PairingCode,
  parseAccountKey,
  readRecoveryKit,
  ready,
  renderRecoveryKit,
  Signer,
  today,
  VaultSync,
  type Enrollment,
  type SyncOutcome,
} from "@opensync/client";
import { AppVaultHost } from "./host";
import { stateStore, type DeviceRecord, type Secrets } from "./store";
import { HOSTED_WS, type Endpoint } from "./words";

export type { SyncOutcome, VaultSync };
export { FREE_EXTENSIONS, isMetered };

export const NAMESPACE = "vault:main";

export function start(): Promise<void> {
  return ready(wasmUrl);
}

/** A brand-new account: both keys made here, never shown, fingerprinted by the kit. */
export async function createAccount(deviceLabel: string): Promise<{ secrets: Secrets; accountId: string }> {
  await start();
  const secrets = { accountSecret: generateAccountKey(), namespaceKey: Namespace.generateKey() };
  const kit = readRecoveryKit(renderRecoveryKit(secrets.accountSecret, secrets.namespaceKey, NAMESPACE, deviceLabel, today())) as { fingerprint: string };
  return { secrets, accountId: kit.fingerprint };
}

export interface Joined {
  secrets: Secrets;
  accountId: string;
  namespace: string;
  endpoint: Endpoint;
  grantedBy: string;
}

/** Join from ten characters (or the `opensync://pair` form, which carries its own server). */
export async function join(code: string, relayWs: string): Promise<Joined> {
  await start();
  const granted = (await joinAccount(relayWs, code.trim())) as Enrollment;
  // A scanned invitation names its own relay; keep the address that worked.
  let used = relayWs;
  if (/^opensync:/i.test(code.trim())) {
    try {
      used = Invitation.parse(code.trim()).relayWs;
    } catch {
      /* the typed address it is */
    }
  }
  const endpoint = endpointsFor(used, granted);
  return {
    secrets: { accountSecret: granted.accountSecret, namespaceKey: granted.namespaceKey },
    accountId: granted.accountId,
    namespace: granted.namespace,
    endpoint,
    grantedBy: granted.grantedBy,
  };
}

/** Restore from a printed kit. The fingerprint is shown back for the person to compare. */
export async function readKit(text: string): Promise<{ secrets: Secrets; namespace: string; accountId: string }> {
  await start();
  const kit = readRecoveryKit(text) as { accountSecret: string; namespaceKey: string; namespace: string; fingerprint: string };
  return { secrets: { accountSecret: kit.accountSecret, namespaceKey: kit.namespaceKey }, namespace: kit.namespace, accountId: kit.fingerprint };
}

export async function renderKit(secrets: Secrets, record: DeviceRecord): Promise<{ text: string; fingerprint: string }> {
  await start();
  const text = renderRecoveryKit(secrets.accountSecret, secrets.namespaceKey, record.namespace, record.deviceLabel, today());
  const back = readRecoveryKit(text) as { fingerprint: string };
  return { text, fingerprint: back.fingerprint };
}

/** The account's public key, hex — what a sync server's roster admits. Not a secret. */
export async function publicId(secrets: Secrets): Promise<string> {
  await start();
  return Signer.fromHex(parseAccountKey(secrets.accountSecret)).pubkey;
}

export interface Offer {
  code: string;
  uri: string;
  draw(canvas: HTMLCanvasElement): void;
  /** Resolves when a device joined; rejects on timeout or a wrong code. */
  done: Promise<void>;
}

/** Show a code and hand the account to whoever answers it. One code, one attempt. */
export async function offer(secrets: Secrets, record: DeviceRecord): Promise<Offer> {
  await start();
  const code = PairingCode.generate();
  const invitation = new Invitation(record.relayWs, code);
  const done = grantAccount(
    record.relayWs,
    code,
    {
      accountSecret: secrets.accountSecret,
      namespaceKey: secrets.namespaceKey,
      namespace: record.namespace,
      relayWs: record.relayWs,
      relayHttp: record.relayHttp,
      grantedBy: record.deviceLabel,
    },
    parseAccountKey(secrets.accountSecret),
    { timeoutMs: 5 * 60_000 },
  );
  return {
    code: code.text,
    uri: invitation.uri,
    draw: (canvas) => drawInvitation(canvas, invitation, { moduleSize: 5 }),
    done,
  };
}

/** Is there a sync server at this address? Answers with its NIP-11 name, or throws a sentence. */
export async function probe(endpoint: Endpoint): Promise<string> {
  let res: Response;
  try {
    res = await fetch(endpoint.http, { headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error(`Nothing answered at ${endpoint.http}. Check the address, and that the server is running.`);
  }
  if (!res.ok) throw new Error(`${endpoint.http} answered ${res.status}; that is not a sync server.`);
  try {
    const doc = (await res.json()) as { name?: string };
    return doc.name ?? endpoint.http;
  } catch {
    throw new Error(`${endpoint.http} is a web server, not a sync server.`);
  }
}

export function carryAll(record: DeviceRecord): boolean {
  return record.carryAttachments && !isMetered(record.relayWs, HOSTED_WS, record.plan);
}

export async function openSync(app: any, record: DeviceRecord, secrets: Secrets, onLocalChange: (path: string) => void): Promise<{ sync: VaultSync; host: AppVaultHost }> {
  await start();
  const host = new AppVaultHost(app);
  const sync = await VaultSync.open({
    keys: secrets,
    endpoint: { ws: record.relayWs, http: record.relayHttp },
    namespace: record.namespace,
    device: record.deviceLabel,
    carryAll: carryAll(record),
    host,
    state: stateStore(record.vaultId),
    onLocalChange,
  });
  return { sync, host };
}
