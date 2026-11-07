/**
 * Recovery for an interrupted update (issue #12).
 *
 * The swap replaces `runtime/` with the staged tree in two renames. If the app,
 * the process or Windows dies between them, the next start has to know what
 * happened instead of guessing:
 *
 * - a journal is written to the app profile *before* the swap and removed after
 *   the update really finished (or was rolled back);
 * - on start, the journal plus a read-only inspection of the isolated root decide
 *   between `finalize` (the new runtime is already active and correct),
 *   `rollback` (restore the kept previous installation) and `blocked` (nothing can
 *   be restored safely — the app must not start anything).
 *
 * The decision itself is pure (`decideRecovery` in `update.ts`); this module adds
 * the file-backed journal and the small orchestration around it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from './logger.js';
import type { UpdateTransition, WslGateway } from './supervisor.js';
import {
  decideRecovery,
  parseUpdateJournal,
  type RuntimeObservation,
  type UpdateJournal,
  type UpdateJournalStore,
} from './update.js';

export interface UpdateRecoveryResult {
  /** True when a journal was found and something was done about it. */
  handled: boolean;
  action: 'finalize' | 'rollback' | 'abandon' | 'blocked' | null;
  message: string | null;
}

/** Journal persisted as JSON in the app profile. Corrupt content means "none". */
export function createJournalStore(path: string, log: Logger): UpdateJournalStore {
  return {
    read(): UpdateJournal | null {
      try {
        if (!existsSync(path)) return null;
        const parsed = parseUpdateJournal(JSON.parse(readFileSync(path, 'utf8')) as unknown);
        if (parsed === null) {
          log.warn('update journal is not readable and is ignored');
          return null;
        }
        return parsed;
      } catch (error) {
        log.warn(`update journal could not be read: ${error instanceof Error ? error.message : 'unknown'}`);
        return null;
      }
    },
    write(journal: UpdateJournal): void {
      try {
        mkdirSync(dirname(path), { recursive: true });
        // Write-then-rename: a crash never leaves a half-written journal behind.
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
        renameSync(temporary, path);
      } catch (error) {
        log.error(`update journal could not be written: ${error instanceof Error ? error.message : 'unknown'}`);
      }
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
  wsl: Pick<WslGateway, 'inspectRuntime' | 'restoreRuntime'>;
  journal: UpdateJournalStore;
  /** Start the backend from whatever runtime is active after the repair. */
  resume: () => Promise<UpdateTransition>;
  log: Logger;
}

/**
 * Repair an update that was interrupted after the staging step.
 *
 * Called once at start-up, before the normal backend start: if a journal exists,
 * the isolated root is inspected and either the new runtime is accepted (it is
 * already active and correct) or the previous installation is restored. The
 * backend is then started, so a completed update does not need a second restart
 * and a rollback comes back with a working WebUI.
 */
export async function recoverInterruptedUpdate(deps: UpdateRecoveryDeps): Promise<UpdateRecoveryResult> {
  const journal = deps.journal.read();
  if (journal === null) return { handled: false, action: null, message: null };

  deps.log.warn(
    `update recovery: journal found (tx=${journal.transaction}, phase=${journal.phase}, target=${journal.target})`,
  );

  let observation: RuntimeObservation;
  try {
    observation = await deps.wsl.inspectRuntime(journal.distro, journal.runtimeRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    deps.log.error(`update recovery: inspecting the isolated root failed (${message})`);
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
    // Only staging happened: the runtime was never replaced, so there is nothing
    // to undo. The staged tree stays for a later attempt and is reused by name.
    deps.journal.clear();
    const resumed = await deps.resume();
    return {
      handled: true,
      action: 'abandon',
      message: resumed.ok ? null : (resumed.message ?? 'The backend did not start.'),
    };
  }

  if (decision.action === 'finalize') {
    deps.journal.clear();
    const resumed = await deps.resume();
    return {
      handled: true,
      action: 'finalize',
      message: resumed.ok ? null : (resumed.message ?? 'The updated backend did not start.'),
    };
  }

  if (decision.action === 'rollback') {
    const restored = await deps.wsl
      .restoreRuntime(
        {
          distro: journal.distro,
          isolationRoot: journal.runtimeRoot,
          transaction: journal.transaction,
          nodePath: null,
        },
        (line) => deps.log.info(`update recovery: ${line}`),
      )
      .catch((error: unknown) => ({ code: null, tail: error instanceof Error ? error.message : 'unknown' }));
    if (restored.code !== 0) {
      // Keep the journal so a later start can try again, and do not start a
      // backend whose runtime may be the half-swapped tree.
      return {
        handled: true,
        action: 'blocked',
        message: `The previous installation could not be restored: ${restored.tail}`,
      };
    }
    deps.journal.clear();
    const resumed = await deps.resume();
    return {
      handled: true,
      action: 'rollback',
      message: resumed.ok ? null : (resumed.message ?? 'The restored backend did not start.'),
    };
  }

  return {
    handled: true,
    action: 'blocked',
    message: `An interrupted update left no usable runtime: ${decision.reason}. Reinstall DeepSeek Harness into the isolated runtime, or restore it from ${journal.canonicalRoot}/update.`,
  };
}
