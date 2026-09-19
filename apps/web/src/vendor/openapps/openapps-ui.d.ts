// The slice of the vendored bundle's API the account page uses.
export interface AccountClient {
  readonly baseUrl: string;
  readonly isLoggedIn: boolean;
}
export function configure(options: { baseUrl: string }): AccountClient;
export function getClient(): AccountClient | null;
/** "The session or the balance may have changed." Returns an unsubscribe. */
export function onChange(listener: () => void): () => void;
