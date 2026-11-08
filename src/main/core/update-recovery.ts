/**
 * Recovery for an interrupted update (issues #12 and #17).
 *
 * The update now changes the **shared** DeepSeek Harness installation in WSL: npm
 * replaces the package below the reported prefix. If the app, the process or
 * Windows dies while npm works, the next start has to know what happened instead
 * of guessing:
 *
 * - a journal is written to the app profile *before* the installation is touched
 *   and removed after the update really finished (or was rolled back);
 * - on start, the journal plus a read-only inspection of the executable decide
 *   between `finalize` (the installation already reports the target version),
 *   `abandon` (it still reports the previous one — nothing was changed),
 *   `rollback` (reinstall the previous exact version) and `blocked` (nothing can
 *   be restored safely — the app must not start anything);
 * - a journal written by the retired private-runtime updater (version 1) is
 *   handled explicitly: that copy is no longer started, so the record is cleared
 *   with a visible note instead of being silently ignored or misapplied.
 *
 * The decision itself is pure (`decideRecovery` in `update.ts`); this module adds
 * the file-backed journal and the small orchestration around it.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from './logger.js';
import type { UpdateTransition, WslGateway } from './supervisor.js';
import {
  UpdateJournalError,
  decideRecovery,
  parseUpdateJournal,
  type SharedInstallObservation,
  type UpdateJournal,
  type UpdateJournalStore,
  type UpdateJournalV2,
} from './update.js';

export interface UpdateRecoveryResult {
  /** True when a journal was found and something was done about it. */
  handled: boolean;
  action: 'finalize' | 'rollback' | 'abandon' | 'blocked' | 'legacy' | null;
  message: string | null;
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

function detailOf(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : 'unknown error';
  return code === null ? message : `${code}: ${message}`;
}

/**
 * Journal persisted as JSON in the app profile.
 *
 * `write()` is deliberately fail-loud: the caller must not change an installation
 * it cannot repair after a crash. The content is flushed, renamed into place and
 * read back, so a full or read-only profile stops the update instead of leaving a
 * silent gap.
 *
 * `read()` distinguishes the three states a profile can be in: no journal (a
 * normal start), a valid journal (repair it) and a journal that exists but is
 * corrupt or unreadable — that last one throws, because ignoring it would start
 * the backend on an installation nobody can vouch for.
 */
export function createJournalStore(path: string, log: Logger): UpdateJournalStore {
  return {
    read(): UpdateJournal | null {
      // `existsSync` would answer `false` for a journal behind an unreadable
      // directory, so the entry is checked with lstat and the errno is inspected:
      // only a genuinely missing entry may be read as "no journal".
      try {
        lstatSync(path);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          // No entry, or a parent that cannot hold one: a normal start.
          log.debug(`update journal absent (${code})`);
          return null;
        }
        // EACCES/EPERM/ELOOP/... — the record may exist and cannot be inspected.
        const detail = detailOf(error);
        log.error(`update journal cannot be inspected: ${detail}`);
        throw new UpdateJournalError('unreadable', path, detail);
      }

      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT') {
          // The entry is a link whose target is gone: the state is unknown.
          log.error('update journal is a link to a missing file');
          throw new UpdateJournalError('unreadable', path, 'linked file does not exist');
        }
        const detail = detailOf(error);
        log.error(`update journal exists but cannot be read: ${detail}`);
        throw new UpdateJournalError('unreadable', path, detail);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        log.error('update journal exists but is not valid JSON');
        throw new UpdateJournalError('corrupt', path, 'not valid JSON');
      }

      const journal = parseUpdateJournal(parsed);
      if (journal === null) {
        log.error('update journal exists but its content is not a valid record');
        throw new UpdateJournalError('corrupt', path, 'unexpected content');
      }
      return journal;
    },
    write(journal: UpdateJournalV2): void {
      const directory = dirname(path);
      const temporary = `${path}.tmp`;
      // Errors are not swallowed: the updater must stop before it touches the
      // installation when its recovery record cannot be stored.

      mkdirSync(directory, { recursive: true });
      const descriptor = openSync(temporary, 'w');
      try {
        writeSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`);
        // Flush the content before the rename: a crash then leaves either the old
        // journal or the new one, never an empty file.
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, path);
      try {
        // Best effort: make the rename itself durable. Not supported everywhere.
        const directoryDescriptor = openSync(directory, 'r');
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      } catch {
        // Directory fsync is unavailable on some platforms; the rename is atomic.
      }
      // Read the record back: only a journal that can be parsed again protects
      // the next start, so a write that produced anything else is a failure.
      const persisted = parseUpdateJournal(JSON.parse(readFileSync(path, 'utf8')) as unknown);
      if (
        persisted === null ||
        persisted.version !== 2 ||
        persisted.transaction !== journal.transaction ||
        persisted.phase !== journal.phase
      ) {
        throw new Error('the update journal could not be verified after writing');
      }
      log.info(`update journal written (tx=${journal.transaction}, phase=${journal.phase})`);
    },
    clear(): void {
      try {
        rmSync(path, { force: true });
      } catch (error) {
        log.warn(`update journal could not be removed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    },
  };
}

export interface UpdateRecoveryDeps {
  wsl: Pick<WslGateway, 'inspectSharedDsh' | 'rollbackSharedDsh'>;
  journal: UpdateJournalStore;
  /** Start the backend from whatever installation is active after the repair. */
  resume: () => Promise<UpdateTransition>;
  log: Logger;
}

/**
 * Repair an update that was interrupted while the shared installation changed.
 *
 * Called once at start-up, before the normal backend start: if a journal exists,
 * the executable is inspected and either the new version is accepted (it is
 * already active and correct) or the previous exact version is reinstalled. The
 * backend is then started, so a completed update does not need a second restart
 * and a rollback comes back with a working WebUI.
 */
export async function recoverInterruptedUpdate(deps: UpdateRecoveryDeps): Promise<UpdateRecoveryResult> {
  let journal: UpdateJournal | null;
  try {
    journal = deps.journal.read();
  } catch (error) {
    // The file exists but cannot be trusted. Keep it (it is the only evidence of
    // what may have happened) and refuse to start DeepSeek Harness.
    const message =
      error instanceof UpdateJournalError
        ? `${error.message}. DeepSeek Harness was not started: repair or remove that file to continue.`
        : `The update journal could not be read (${error instanceof Error ? error.message : 'unknown error'}). DeepSeek Harness was not started.`;
    deps.log.error(`update recovery: ${message}`);
    return { handled: true, action: 'blocked', message };
  }
  if (journal === null) return { handled: false, action: null, message: null };

  deps.log.warn(
    `update recovery: journal found (v${journal.version}, tx=${journal.transaction}, target=${journal.target})`,
  );

  if (journal.version === 1) {
    // The private runtime this record describes is not started by this build.
    // Clearing the record is safe; pretending to repair a tree nobody runs is not.
    deps.journal.clear();
    const message =
      'An update journal from an older version of DSH WSL was found. It described the retired app-private DeepSeek Harness runtime, which this version no longer starts: the record was cleared and DeepSeek Harness from your WSL installation was started.';
    deps.log.info('update recovery: legacy journal cleared');
    const resumed = await deps.resume();
    return { handled: true, action: 'legacy', message: resumed.ok ? message : (resumed.message ?? message) };
  }

  const inspect = async (): Promise<SharedInstallObservation> => {
    const report = await deps.wsl.inspectSharedDsh({
      distro: journal.distro,
      appRoot: journal.appRoot,
      dshPath: journal.dshPath,
      nodePath: null,
      ownPid: null,
    });
    const installation = report.installation;
    return {
      present: installation !== null,
      version: installation?.version ?? null,
      realPath: installation?.realPath ?? null,
    };
  };

  let observation: SharedInstallObservation;
  try {
    observation = await inspect();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    deps.log.error(`update recovery: inspecting the installation failed (${message})`);
    // Keep the journal: the state is unknown, so the next start retries.
    return {
      handled: true,
      action: 'blocked',
      message: `The state of the last update could not be inspected: ${message}`,
    };
  }

  const decision = decideRecovery(journal, observation);
  deps.log.info(`update recovery: ${decision.action} (${decision.reason})`);

  if (decision.action === 'abandon') {
    // Nothing was changed: forget the record and continue with the normal start.
    deps.journal.clear();
    const resumed = await deps.resume();
    return {
      handled: true,
      action: 'abandon',
      message: resumed.ok ? null : (resumed.message ?? 'The backend did not start.'),
    };
  }

  if (decision.action === 'finalize') {
    const resumed = await deps.resume();
    if (resumed.ok) {
      // Proven: the new version is active and serves the WebUI.
      deps.journal.clear();
      return { handled: true, action: 'finalize', message: null };
    }
    // The new version is installed but does not serve: restore the previous one
    // and keep the journal until that is proven as well.
    deps.log.warn(`update recovery: the updated version did not start (${resumed.message ?? 'unknown'})`);
    return await restore(deps, journal, `The updated version did not start (${resumed.message ?? 'unknown error'}).`);
  }

  return await restore(
    deps,
    journal,
    decision.action === 'blocked'
      ? `An interrupted update left the installation in an unknown state: ${decision.reason}.`
      : `An interrupted update left ${observation.version ?? 'no version'} installed instead of ${journal.target}.`,
  );
}

/** Reinstall the previous exact version, then prove that its backend starts. */
async function restore(
  deps: UpdateRecoveryDeps,
  journal: UpdateJournalV2,
  reason: string,
): Promise<UpdateRecoveryResult> {
  const restored = await deps.wsl
    .rollbackSharedDsh(
      {
        distro: journal.distro,
        appRoot: journal.appRoot,
        prefix: journal.prefix,
        packageDir: journal.packageDir,
        dshPath: journal.dshPath,
        realPath: journal.realPath,
        npmPath: journal.npmPath,
        nodePath: null,
        snapshotDir: journal.backupDir,
      },
      journal.installed,
      journal.transaction,
      (line) => deps.log.info(`update recovery: ${line}`),
    )
    .catch((error: unknown) => ({
      code: null,
      tail: error instanceof Error ? error.message : 'unknown error',
    }));

  if (restored.code !== 0) {
    return {
      handled: true,
      action: 'blocked',
      message: `${reason} The previous version ${journal.installed} could not be restored from the verified snapshot at ${journal.backupDir} (${restored.tail}). The journal was kept. Restore that directory over ${journal.packageDir} inside WSL, or run "npm install -g --prefix ${journal.prefix} @deepseek-ai/dsh@${journal.installed}", then start DSH WSL again.`,
    };
  }

  const resumed = await deps.resume();
  if (!resumed.ok) {
    // Keep the record: the next start must be able to try again.
    return {
      handled: true,
      action: 'blocked',
      message: `${reason} The previous version was restored, but its backend did not start (${resumed.message ?? 'unknown error'}). The journal was kept.`,
    };
  }

  deps.journal.clear();
  return {
    handled: true,
    action: 'rollback',
    message: `${reason} The previous version ${journal.installed} was reinstalled and is running again.`,
  };
}
