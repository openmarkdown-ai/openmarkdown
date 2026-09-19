/**
 * Whether this build includes sync. Vite aliases `@opensync/in-build` to this
 * file when `../opensync` exists beside the repository, and to
 * `unavailable/in-build.ts` when it does not.
 */
export const SYNC_IN_BUILD: boolean = true;
