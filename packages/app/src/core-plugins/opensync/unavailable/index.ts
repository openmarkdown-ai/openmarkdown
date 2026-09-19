/**
 * What `@opensync/client` resolves to in a build without `../opensync`.
 *
 * Nothing here runs: `SYNC_IN_BUILD` is false in such a build, so the Sync
 * feature never imports its engine. The names exist so the app still
 * typechecks in a clone that has only this repository.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const missing: any = new Proxy(function () {}, {
  get: () => missing,
  apply: () => {
    throw new Error("This build of OpenMarkdown does not include sync.");
  },
  construct: () => {
    throw new Error("This build of OpenMarkdown does not include sync.");
  },
});

export type VaultHost = any;
export type StateStore = any;
export type SyncState = any;
export type SyncOutcome = any;
export type FileStat = any;
export type Enrollment = any;
export type Keys = any;
export type ManifestJson = any;

export const ready: any = missing;
export const VaultSync: any = missing;
export type VaultSync = any;
export const Signer: any = missing;
export const joinAccount: any = missing;
export const grantAccount: any = missing;
export const endpointsFor: any = missing;
export const PairingCode: any = missing;
export const Invitation: any = missing;
export const drawInvitation: any = missing;
export const renderRecoveryKit: any = missing;
export const readRecoveryKit: any = missing;
export const generateAccountKey: any = missing;
export const Namespace: any = missing;
export const parseAccountKey: any = missing;
export const assumeTls: any = missing;
export const storageFor: any = missing;
export const isMetered: any = missing;
export const today: any = missing;
export const canScan: any = missing;
export const whyNotScannable: any = missing;
export const QuotaError: any = missing;
export const NotAdmittedError: any = missing;
export const RelayUnreachableError: any = missing;
export const FREE_EXTENSIONS: readonly string[] = [];
export const HOSTED_RELAY_HOST = "";
export const HOSTED_RELAY_WS = "";
export const HOSTED_RELAY_HTTP = "";
