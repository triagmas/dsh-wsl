/**
 * Product identity and profile continuity (issue #14).
 *
 * The application was renamed to "DSH WSL". These checks pin the boundary between
 * what may change (user-facing names, artifact names) and what must not change
 * (the Windows application id and the `%APPDATA%\wsl-web-shell` profile directory,
 * which holds the user's config, logs, registry and update journal).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APP_DISPLAY_NAME, APP_ID, PROFILE_DIRECTORY } from '../src/main/core/branding.js';

const root = join(import.meta.dirname, '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

const collect = (directory: string, extensions: RegExp): string[] => {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (extensions.test(entry)) {
        found.push(full);
      }
    }
  };
  walk(join(root, directory));
  return found;
};

describe('product identity', () => {
  it('uses the new display name without touching stable identifiers', () => {
    expect(APP_DISPLAY_NAME).toBe('DSH WSL');
    // The profile directory is user data: its name stays for good.
    expect(PROFILE_DIRECTORY).toBe('wsl-web-shell');
    // The installer identity is what lets a new Setup EXE upgrade an old install.
    expect(APP_ID).toBe('com.triagmas.wslwebshell');
  });

  it('pins the profile before anything reads userData', () => {
    const source = read('src/main/index.ts');
    expect(source).toContain('app.setName(APP_DISPLAY_NAME)');
    expect(source).toContain("app.setPath('userData', join(app.getPath('appData'), PROFILE_DIRECTORY))");
    // The pin must come before the application bootstrap, not inside it.
    expect(source.indexOf('app.setPath')).toBeLessThan(source.indexOf('async function bootstrap'));
    expect(source).toContain('--profile-probe=');
  });

  it('renames every user-facing surface', () => {
    const pages = ['src/chrome/index.html', 'src/splash/index.html', 'src/settings/index.html', 'src/popover/index.html'];
    for (const page of pages) {
      expect(read(page)).toContain('DSH WSL');
    }
    expect(read('src/main/core/tray-model.ts')).toContain('DSH WSL —');
    expect(read('src/main/electron/tray.ts')).toContain("setToolTip('DSH WSL')");
    expect(read('src/main/electron/windows.ts')).toContain("title: 'DSH WSL'");
  });

  it('leaves no old product name in the shipped sources', () => {
    const offenders: string[] = [];
    for (const file of collect('src', /\.(ts|js|html|css)$/)) {
      const text = readFileSync(file, 'utf8');
      if (/WSL Web Shell|WSL-Web-Shell/.test(text)) offenders.push(file.replace(`${root}/`, ''));
    }
    expect(offenders).toEqual([]);
  });

  it('names the packages, shortcuts and artifacts consistently', () => {
    const builder = read('electron-builder.yml');
    expect(builder).toContain('productName: DSH WSL');
    expect(builder).toContain('artifactName: DSH-WSL-${version}-x64-Portable.${ext}');
    expect(builder).toContain('artifactName: DSH-WSL-${version}-x64-Setup.${ext}');
    expect(builder).toContain('shortcutName: DSH WSL');
    expect(builder).toContain('uninstallDisplayName: DSH WSL ${version}');
    expect(JSON.parse(read('package.json'))).toMatchObject({ name: 'wsl-web-shell', productName: 'DSH WSL' });
  });
});
