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
  describeUpdateReason,
  describeUpdatePhase,
  isSameVersion,
  phaseFromUpdateLine,
  planSharedUpdate,
  createUpdateState,
  createUpdateTerminal,
  UPDATE_REASONS,
  type SharedUpdatePlan,
  type UpdateJournalPhase,
  type UpdateJournalStore,
  type UpdateState,
} from './update.js';

/** Minimal supervisor surface the runner needs. */
export interface UpdateLifecycle {
  pauseForUpdate(): Promise<UpdateTransition>;
  resumeAfterUpdate(): Promise<UpdateTransition>;
  releaseUpdateLock(): void;
  /** Terminal state for an installation that must not be started (failed rollback). */
  blockForRuntime(message: string): void;
  updateInProgress: boolean;
}

export interface UpdateRunnerDeps {
  wsl: Pick<WslGateway, 'checkPublishedVersion' | 'inspectSharedDsh' | 'updateSharedDsh' | 'rollbackSharedDsh'>;
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
  ): Promise<UpdateOutcome> => {
    const restored = await deps.wsl
      .rollbackSharedDsh(
        {
          distro: plan.distro,
          appRoot: plan.appRoot,
          prefix: plan.prefix,
          packageDir: plan.packageDir,
          dshPath: plan.dshPath,
          npmPath: plan.npmPath,
          nodePath: context.nodePath,
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
      busy = true;
      terminal.clear();
      state = {
        ...createUpdateState(deps.now()),
        targetVersion: plan.version,
        installedVersion: plan.installedVersion,
      };
      publish({ phase: 'checking', message: describeUpdatePhase('checking'), detail: null });
      deps.log.info(`update: checking ${plan.version} on npm (distro=${plan.distro})`);
      const startedAt = deps.now();
      // True once the install may have started: from here on only a proven
      // restore may clear the journal.
      let installStarted = false;

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

        // 2. The journal must exist before anything can be installed.
        if (!writeJournal(verified, context, 'updating', startedAt)) {
          return {
            ok: false,
            state: fail(
              'The update journal could not be written, so nothing was installed. Check free space and write access of the app profile, then try again.',
            ),
          };
        }

        // 3. Quiesce: pause recovery, stop only the app-owned backend.
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

        // 4. Update the shared installation.
        installStarted = true;
        publish({ phase: 'installing', message: describeUpdatePhase('installing') });
        const updated = await deps.wsl.updateSharedDsh(
          {
            distro: verified.distro,
            appRoot: verified.appRoot,
            prefix: verified.prefix,
            packageDir: verified.packageDir,
            dshPath: verified.dshPath,
            npmPath: check.npmPath,
            nodePath: context.nodePath,
            transaction: context.transaction,
            version: verified.version,
            installedVersion: verified.installedVersion,
            ownPid: context.ownPid,
          },
          append,
        );

        if (updated.code === 72 || updated.code === 74) {
          // The script already reinstalled the previous version and proved it.
          const outcome = await rollback(
            verified,
            context,
            updated.code === 72
              ? 'npm could not install the new version.'
              : 'The updated installation did not report the target version.',
            'install',
          );
          return outcome;
        }
        if (updated.code !== 0) {
          // 73/75/76/77/78 and anything unexpected: the installation may be in any
          // state, so only a proven restore may clear the journal.
          const detail = updated.tail === '' ? `The updater exited with code ${updated.code ?? 'unknown'}.` : updated.tail;
          return await rollback(verified, context, detail, 'install');
        }

        // 5. Independently confirm the version the launcher will now run.
        if (!writeJournal(verified, context, 'verifying', startedAt)) {
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
          );
        }
        terminal.append(`update: ${verified.dshPath} reports ${reported}`);

        // 6. Prove the new version actually serves the WebUI.
        publish({ phase: 'starting', message: describeUpdatePhase('starting') });
        const resumed = await deps.lifecycle.resumeAfterUpdate();
        if (!resumed.ok) {
          terminal.append('update: the updated version did not start, restoring the previous version');
          return await rollback(verified, context, resumed.message ?? 'The updated version did not start.', 'start');
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
        if (installStarted) {
          // The install may have run: only a proven restore may clear the journal.
          return await rollback(plan, context, detail, 'exception');
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
