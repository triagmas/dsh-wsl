/**
 * Update runner (issues #12 and #17): the only place that sequences an update.
 *
 * Since issue #17 the update changes the **shared** DeepSeek Harness installation
 * in the selected WSL distribution — the same `dsh` an ordinary terminal runs.
 * The order below is fixed and every step is published to the modal window:
 *
 *   checking    npm confirms the exact published version exists
 *   inspecting  the installation is re-inspected and the plan re-validated with
 *               fresh evidence (path, realpath, npm prefix, writability, foreign
 *               processes) — a changed environment aborts before anything is
 *               written
 *   stopping    auto-recovery is paused and the app-owned backend is stopped
 *   installing  `npm install -g` into the reported prefix; the previous package
 *               is copied aside, npm output is streamed to the window
 *   verifying   the executable the launcher uses must report the target version
 *               and the login shell must resolve the same file
 *   starting    a full backend start (token exchange and the authenticated
 *               request) — success is only claimed after this
 *
 * A journal is written before the installation is touched, so an interruption is
 * recoverable on the next start (`update-recovery.ts`). Nothing is retried: a
 * failure reinstalls the previous exact version and starts it again. The app never
 * signals a process it does not own, and never uses sudo or UAC.
 *
 * Nothing here decides that an update may happen: `planSharedUpdate()` has already
 * rejected custom executables, non-npm managers, foreign runtimes, non-writable
 * prefixes and foreign processes.
 */
import type { Logger } from './logger.js';
import type { UpdateTransition, WslGateway } from './supervisor.js';
import {
  describeBackupFailure,
  describeUpdateReason,
  describeUpdatePhase,
  isSameVersion,
  phaseFromUpdateLine,
  planSharedUpdate,
  createUpdateState,
  createUpdateTerminal,
  UPDATE_REASONS,
  sanitizeBackupReason,
  SNAPSHOT_RETENTION,
  type SharedUpdatePlan,
  type UpdateJournalPhase,
  type UpdateJournalStore,
  type UpdateState,
} from './update.js';

/** Minimal supervisor surface the runner needs. */
export interface UpdateLifecycle {
  pauseForUpdate(): Promise<UpdateTransition>;
  resumeAfterUpdate(): Promise<UpdateTransition>;
  /** Stop a unit this update started, before the previous files are restored. */
  stopForRollback(): Promise<void>;
  releaseUpdateLock(): void;
  /** Terminal state for an installation that must not be started (failed rollback). */
  blockForRuntime(message: string): void;
  /**
   * Why an update must not start now, or `null` when it may. Checked before the
   * first npm call so an obstacle costs nothing.
   */
  updateBlocker(): Promise<string | null>;
  updateInProgress: boolean;
}

export interface UpdateRunnerDeps {
  wsl: Pick<
    WslGateway,
    | 'checkPublishedVersion'
    | 'inspectSharedDsh'
    | 'prepareSharedBackup'
    | 'pruneUpdateSnapshots'
    | 'updateSharedDsh'
    | 'rollbackSharedDsh'
  >;
  lifecycle: UpdateLifecycle;
  journal: UpdateJournalStore;
  log: Logger;
  /** Push the current state to every window that renders it. */
  publish: (state: UpdateState) => void;
  now: () => string;
}

export interface UpdateContext {
  distro: string;
  nodePath: string | null;
  transaction: string;
  /** True when the user pinned an executable in Settings. */
  customExecutable: boolean;
  /** PID of the app-owned backend, excluded from the foreign-process scan. */
  ownPid: number | null;
}

export interface UpdateOutcome {
  ok: boolean;
  state: UpdateState;
}

export interface UpdateRunner {
  snapshot(): UpdateState;
  running(): boolean;
  /** Run one accepted plan. Never runs concurrently. */
  run(plan: SharedUpdatePlan, context: UpdateContext): Promise<UpdateOutcome>;
}

export function createUpdateRunner(deps: UpdateRunnerDeps): UpdateRunner {
  const terminal = createUpdateTerminal();
  let state: UpdateState = createUpdateState(deps.now());
  let busy = false;

  const publish = (next: Partial<UpdateState>): UpdateState => {
    state = {
      ...state,
      ...next,
      lines: terminal.lines(),
      dropped: terminal.dropped(),
      updatedAt: deps.now(),
    };
    deps.publish(state);
    return state;
  };

  const append = (line: string): void => {
    const kept = terminal.append(line);
    if (kept === null) return;
    const phase = phaseFromUpdateLine(kept);
    if (phase !== null && phase !== state.phase) {
      // One publish per real transition; repeated markers stay silent.
      publish({ phase, message: describeUpdatePhase(phase) });
      return;
    }
    publish({});
  };

  const fail = (detail: string, phase: UpdateState['phase'] = 'failed'): UpdateState => {
    deps.log.error(`update failed: ${detail}`);
    return publish({ phase, message: describeUpdatePhase(phase), detail });
  };

  /**
   * Persist the journal before the step that needs it.
   *
   * A journal that cannot be written is a hard stop: without it an interruption
   * during the install would be unrecoverable, so the caller must not continue.
   */
  const writeJournal = (
    plan: SharedUpdatePlan,
    context: UpdateContext,
    phase: UpdateJournalPhase,
    startedAt: string,
    snapshotDir: string,
  ): boolean => {
    try {
      deps.journal.write({
        version: 2,
        kind: 'npm-global',
        transaction: context.transaction,
        phase,
        distro: plan.distro,
        dshPath: plan.dshPath,
        realPath: plan.realPath,
        prefix: plan.prefix,
        packageDir: plan.packageDir,
        appRoot: plan.appRoot,
        npmPath: plan.npmPath,
        backupDir: snapshotDir,
        target: plan.version,
        installed: plan.installedVersion,
        startedAt,
        updatedAt: deps.now(),
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      deps.log.error(`update: the ${phase} journal could not be written: ${message}`);
      terminal.append(`update: the update journal could not be written (${phase}): ${message}`);
      return false;
    }
  };

  /**
   * Reinstall the previous exact version after a failed update.
   *
   * The journal is the only record of what happened, so it is removed only when
   * the previous version was restored **and** its backend provably serves the
   * WebUI again. Any other outcome keeps the journal and puts the app into a
   * terminal state: starting from an unknown installation would hide it.
   */
  const rollback = async (
    plan: SharedUpdatePlan,
    context: UpdateContext,
    reason: string,
    where: string,
    snapshotDir: string,
  ): Promise<UpdateOutcome> => {
    // A backend the update started has to be stopped before the previous files
    // are written back: restoring under a running process is the same corruption
    // this coordination exists to prevent.
    await deps.lifecycle.stopForRollback();
    const restored = await deps.wsl
      .rollbackSharedDsh(
        {
          distro: plan.distro,
          appRoot: plan.appRoot,
          prefix: plan.prefix,
          packageDir: plan.packageDir,
          dshPath: plan.dshPath,
          realPath: plan.realPath,
          npmPath: plan.npmPath,
          nodePath: context.nodePath,
          snapshotDir,
        },
        plan.installedVersion,
        context.transaction,
        append,
      )
      .catch((error: unknown) => ({
        code: null,
        tail: error instanceof Error ? error.message : 'unknown error',
      }));

    if (restored.code !== 0) {
      const message = `${reason} The previous version could not be restored (${restored.tail}).`;
      deps.log.error(`update: rollback failed after ${where}; journal kept and further starts blocked`);
      deps.lifecycle.blockForRuntime(message);
      return {
        ok: false,
        state: fail(
          `${message} The app will not start from this installation: the update journal was kept and the next start tries to restore it again.`,
          'failed',
        ),
      };
    }

    const resumed = await deps.lifecycle.resumeAfterUpdate();
    if (!resumed.ok) {
      const message = `${reason} The previous version was restored, but its backend did not start (${resumed.message ?? 'unknown error'}).`;
      deps.log.error('update: restart after rollback failed; journal kept and further starts blocked');
      deps.lifecycle.blockForRuntime(message);
      return { ok: false, state: fail(`${message} The update journal was kept.`, 'failed') };
    }

    deps.journal.clear();
    return {
      ok: false,
      state: fail(
        `${reason} The previous version is installed and running again.`,
        'rolled-back',
      ),
    };
  };

  return {
    snapshot: () => state,
    running: () => busy,

    async run(plan: SharedUpdatePlan, context: UpdateContext): Promise<UpdateOutcome> {
      if (busy) return { ok: false, state };
      // Claim the runner synchronously: the obstacle check below awaits, and a
      // second request arriving meanwhile must not believe the runner is free.
      busy = true;
      terminal.clear();
      state = {
        ...createUpdateState(deps.now()),
        targetVersion: plan.version,
        installedVersion: plan.installedVersion,
      };
      // Refuse before the first expensive step. An update replaces the files the
      // running backend executes, and the self-check that used to catch this ran
      // after a minute of snapshot work, so the owner saw a failure that cost a
      // gigabyte and told him nothing he could act on.
      const blocker = await deps.lifecycle.updateBlocker();
      if (blocker !== null) {
        // The claim is released again: a run that never started must not block the
        // next attempt once the owner removes the obstacle.
        busy = false;
        deps.log.warn(`update refused before anything was read: ${blocker}`);
        return { ok: false, state: fail(blocker) };
      }
      publish({ phase: 'checking', message: describeUpdatePhase('checking'), detail: null });
      deps.log.info(`update: checking ${plan.version} on npm (distro=${plan.distro})`);
      const startedAt = deps.now();
      // True once the install may have started: from here on only a proven
      // restore may clear the journal.
      let installStarted = false;
      // Verified snapshot created before the install; needed by the error path.
      let backupDir: string | null = null;

      try {
        const check = await deps.wsl.checkPublishedVersion({
          distro: plan.distro,
          appRoot: plan.appRoot,
          version: plan.version,
          nodePath: context.nodePath,
        });
        terminal.append(`update: npm check ${check.found ? 'ok' : 'failed'}`);
        if (check.npmPath !== null) terminal.append(`update: npm ${check.npmPath}`);
        if (!check.found || check.npmPath === null) {
          return {
            ok: false,
            state: fail(check.message ?? 'The published version could not be verified on npm.'),
          };
        }

        // 1. Fresh evidence: the plan was built from an inspection minutes ago,
        //    but the prefix, the package or other running DSH processes may have
        //    changed since then.
        publish({ phase: 'inspecting', message: describeUpdatePhase('inspecting') });
        const inspection = await deps.wsl.inspectSharedDsh({
          distro: plan.distro,
          appRoot: plan.appRoot,
          dshPath: plan.dshPath,
          nodePath: context.nodePath,
          ownPid: context.ownPid,
        });
        if (inspection.installation === null) {
          return {
            ok: false,
            state: fail(
              `The DeepSeek Harness installation at ${plan.dshPath} is no longer available. Nothing was changed.`,
            ),
          };
        }
        const rechecked = planSharedUpdate({
          distro: plan.distro,
          targetVersion: plan.version,
          appRoot: plan.appRoot,
          installation: inspection.installation,
          customExecutable: context.customExecutable,
          stoppablePid: plan.stoppablePid,
        });
        if (!rechecked.ok) {
          return {
            ok: false,
            state: fail(
              `${describeUpdateReason(rechecked.reason)}${rechecked.detail === null ? '' : ` (${rechecked.detail})`} Nothing was changed.`,
            ),
          };
        }
        // Use the freshly verified values: they are the ones the script must see.
        const verified: SharedUpdatePlan = rechecked.plan;
        terminal.append(`update: installation ${verified.dshPath} (${verified.scope})`);
        terminal.append(`update: target ${verified.installedVersion} -> ${verified.version}`);

        // 2. B1: a verified, offline-restorable snapshot must exist before the
        //    shared installation is touched. Without it nothing is changed at
        //    all, and the backend is never stopped.
        terminal.append(`update: preparing a recovery snapshot of ${verified.installedVersion}`);
        const backup = await deps.wsl
          .prepareSharedBackup({
            distro: verified.distro,
            appRoot: verified.appRoot,
            prefix: verified.prefix,
            packageDir: verified.packageDir,
            dshPath: verified.dshPath,
            realPath: verified.realPath,
            installedVersion: verified.installedVersion,
            transaction: context.transaction,
            nodePath: context.nodePath,
          })
          .catch((error: unknown) => ({
            ok: false as const,
            code: null,
            detail: error instanceof Error ? error.message : 'unknown error',
          }));
        if (!backup.ok) {
          // Nothing was paused and nothing was written, so there is no lock to
          // release and no journal to clear.
          deps.journal.clear();
          // One sanitized reason for every surface: the terminal, the log and the
          // state message. The gateway already sanitizes its own output, but a
          // rejected gateway promise reaches this branch as raw text, so the
          // sanitizer is applied here as well (escapes/control characters out,
          // credentials redacted, hard length bound).
          const reason = sanitizeBackupReason(backup.detail);
          terminal.append(
            `update: the recovery snapshot failed (code=${backup.code ?? 'null'})${reason === null ? '' : `: ${reason}`}`,
          );
          deps.log.error(
            `update: no verified recovery snapshot, nothing was changed (code=${backup.code ?? 'null'}: ${
              reason ?? 'no output'
            })`,
          );
          return { ok: false, state: fail(describeBackupFailure(backup.code, reason)) };
        }
        const snapshotDir = backup.snapshot.path;
        backupDir = snapshotDir;
        terminal.append(`update: verified recovery snapshot at ${snapshotDir} (${backup.snapshot.files} files)`);

        // Every snapshot is a full copy of the package, and nothing revisits one
        // once its transaction is over: without pruning the owner's host had
        // 4.3 GB in four of them. This runs after the new snapshot is verified,
        // so the run always keeps a usable one even when pruning fails.
        if (deps.journal.read() === null) {
          const pruned = await deps.wsl
            .pruneUpdateSnapshots({
              distro: verified.distro,
              appRoot: verified.appRoot,
              keep: SNAPSHOT_RETENTION,
              transaction: context.transaction,
            })
            .catch((error: unknown) => {
              deps.log.warn(
                `update: old recovery snapshots were left in place: ${
                  error instanceof Error ? error.message : 'unknown error'
                }`,
              );
              return { removed: [] as string[] };
            });
          if (pruned.removed.length > 0) {
            terminal.append(`update: removed ${pruned.removed.length} old recovery snapshot(s)`);
          }
        }

        // 3. The journal must exist before anything can be installed.
        if (!writeJournal(verified, context, 'updating', startedAt, snapshotDir)) {
          return {
            ok: false,
            state: fail(
              'The update journal could not be written, so nothing was installed. Check free space and write access of the app profile, then try again.',
            ),
          };
        }

        // 4. Quiesce: pause recovery, stop only the app-owned backend.
        publish({ phase: 'stopping', message: describeUpdatePhase('stopping') });
        const paused = await deps.lifecycle.pauseForUpdate();
        if (!paused.ok) {
          deps.lifecycle.releaseUpdateLock();
          deps.journal.clear();
          return {
            ok: false,
            state: fail(paused.message ?? 'The app-owned backend could not be stopped, so nothing was changed.'),
          };
        }

        // 5. Update the shared installation.
        installStarted = true;
        publish({ phase: 'installing', message: describeUpdatePhase('installing') });
        const updated = await deps.wsl.updateSharedDsh(
          {
            distro: verified.distro,
            appRoot: verified.appRoot,
            prefix: verified.prefix,
            packageDir: verified.packageDir,
            dshPath: verified.dshPath,
            realPath: verified.realPath,
            npmPath: check.npmPath,
            nodePath: context.nodePath,
            transaction: context.transaction,
            version: verified.version,
            installedVersion: verified.installedVersion,
            ownPid: context.ownPid,
            snapshotDir,
          },
          append,
        );

        // The script refuses *before* touching anything for these codes, so the
        // installation is untouched and only the backend has to come back.
        if (updated.code === 79 || updated.code === 80 || updated.code === 81 || updated.code === 82) {
          const detail = updated.tail === '' ? `The updater exited with code ${updated.code}.` : updated.tail;
          deps.log.error(`update: refused before changing anything (code=${updated.code})`);
          const resumed = await deps.lifecycle.resumeAfterUpdate();
          if (!resumed.ok) {
            deps.lifecycle.blockForRuntime(detail);
            return {
              ok: false,
              state: fail(`${detail} The previous installation is still in place, but its backend did not start.`, 'failed'),
            };
          }
          deps.journal.clear();
          return { ok: false, state: fail(`${detail} Nothing was changed.`) };
        }
        if (updated.code === 72 || updated.code === 74 || updated.code === 83 || updated.code === 84) {
          // The script restored the previous installation itself and proved it;
          // the runner still verifies and restarts before clearing the journal.
          const reason =
            updated.code === 72
              ? 'npm could not install the new version.'
              : updated.code === 74
                ? 'The updated installation did not report the target version.'
                : updated.code === 83
                  ? 'The updated installation did not stay at the approved path.'
                  : 'A login shell does not run the updated version.';
          return await rollback(verified, context, reason, 'install', snapshotDir);
        }
        if (updated.code !== 0) {
          // 73/75/76/77/78 and anything unexpected: the installation may be in any
          // state, so only a proven restore may clear the journal.
          const detail = updated.tail === '' ? `The updater exited with code ${updated.code ?? 'unknown'}.` : updated.tail;
          return await rollback(verified, context, detail, 'install', snapshotDir);
        }

        // 6. Independently confirm the version the launcher will now run.
        if (!writeJournal(verified, context, 'verifying', startedAt, snapshotDir)) {
          // The previous record still describes the pending install, so a crash
          // here stays recoverable: continue instead of throwing it away.
          terminal.append('update: the journal phase could not be updated; the previous record is kept');
        }
        publish({ phase: 'verifying', message: describeUpdatePhase('verifying') });
        const after = await deps.wsl.inspectSharedDsh({
          distro: verified.distro,
          appRoot: verified.appRoot,
          dshPath: verified.dshPath,
          nodePath: context.nodePath,
          ownPid: context.ownPid,
        });
        const reported = after.installation?.version ?? null;
        if (!isSameVersion(reported, verified.version)) {
          terminal.append(`update: the installation reports ${reported ?? 'no version'} instead of ${verified.version}`);
          return await rollback(
            verified,
            context,
            `The updated installation reports ${reported ?? 'no version'} instead of ${verified.version}.`,
            'verification',
            snapshotDir,
          );
        }
        terminal.append(`update: ${verified.dshPath} reports ${reported}`);

        // B2/B3 mirror: the target version has to live at the approved real path,
        // and an ordinary login shell has to run that very file.
        if (after.installation !== null && after.installation.realPath !== verified.realPath) {
          terminal.append(
            `update: the installation resolves to ${after.installation.realPath} instead of ${verified.realPath}`,
          );
          return await rollback(
            verified,
            context,
            `The updated installation resolves to ${after.installation.realPath} instead of the approved ${verified.realPath}.`,
            'verification',
            snapshotDir,
          );
        }
        const shellReal = after.installation?.loginShellRealPath ?? null;
        const shellVersion = after.installation?.loginShellVersion ?? null;
        // C1: an unresolvable login shell is a failure, not an absence of evidence.
        const shellOk =
          shellReal !== null &&
          shellVersion !== null &&
          shellReal === verified.realPath &&
          isSameVersion(shellVersion, verified.version);
        if (!shellOk) {
          terminal.append(
            `update: a login shell resolves ${shellReal ?? 'nothing'} (${shellVersion ?? 'no version'}) instead of ${verified.realPath}`,
          );
          return await rollback(
            verified,
            context,
            'A login shell does not run the updated DeepSeek Harness, so the update was reverted.',
            'verification',
            snapshotDir,
          );
        }

        // 7. Prove the new version actually serves the WebUI.
        publish({ phase: 'starting', message: describeUpdatePhase('starting') });
        const resumed = await deps.lifecycle.resumeAfterUpdate();
        if (!resumed.ok) {
          terminal.append('update: the updated version did not start, restoring the previous version');
          return await rollback(
            verified,
            context,
            resumed.message ?? 'The updated version did not start.',
            'start',
            snapshotDir,
          );
        }

        // Only a new backend that really served the WebUI clears the journal.
        deps.journal.clear();
        terminal.append(`update: ${verified.version} is serving the WebUI`);
        const done = publish({
          phase: 'done',
          message: `Updated to ${verified.version}`,
          detail: `The shared installation at ${verified.dshPath} now reports ${verified.version}. An ordinary dsh web in WSL uses the same executable.`,
        });
        deps.log.info(`update: completed ${verified.installedVersion} -> ${verified.version} at ${verified.dshPath}`);
        return { ok: true, state: done };
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
        if (installStarted && backupDir !== null) {
          // The install may have run: only a proven restore may clear the journal.
          return await rollback(plan, context, detail, 'exception', backupDir);
        }
        if (installStarted) {
          // The install may have run and there is no verified snapshot: nothing
          // may be started from an unknown installation.
          deps.log.error('update: the install may have run without a verified snapshot');
          deps.lifecycle.blockForRuntime(detail);
          return {
            ok: false,
            state: fail(
              `${detail} The installation did not change completely and no verified snapshot is available, so the app will not start it. Reinstall DeepSeek Harness inside WSL or restore it from your own backup.`,
            ),
          };
        }
        deps.lifecycle.releaseUpdateLock();
        deps.journal.clear();
        return { ok: false, state: fail(detail) };
      } finally {
        busy = false;
      }
    },
  };
}

/** Reason shown when a plan was rejected before the runner was called. */
export function describeRejectedPlan(reason: string, detail: string | null): string {
  const description = describeUpdateReason(reason);
  return detail === null ? description : `${description} (${detail})`;
}

/** Exported for tests: the reason set the runner understands. */
export const RUNNER_REASONS = UPDATE_REASONS;
