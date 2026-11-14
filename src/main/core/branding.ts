/**
 * Product identity (issue #14).
 *
 * The application is now called **DSH WSL**. Only user-facing names change:
 * window titles, tray tooltip, installer, shortcuts and artifact names.
 *
 * Two identifiers must NOT change, because they are not just labels:
 *
 * - `APP_ID` — the Windows application id the installer and shortcuts use. Keeping
 *   it lets a new Setup EXE upgrade an existing installation instead of creating a
 *   second, unrelated one.
 * - `PROFILE_DIRECTORY` — the on-disk profile (`%APPDATA%\wsl-web-shell`) that holds
 *   `config.json`, logs, the owned-server registry and the versions cache. Renaming
 *   it would silently orphan the user's settings and port choice, so the directory
 *   keeps its original name forever.
 */

/** User-facing product name. */
export const APP_DISPLAY_NAME = 'DSH WSL';

/** Windows application id (installer identity and shortcut AUMID). Never rename. */
export const APP_ID = 'com.triagmas.wslwebshell';

/** Profile directory name inside `%APPDATA%`. Never rename: it holds user data. */
export const PROFILE_DIRECTORY = 'wsl-web-shell';
