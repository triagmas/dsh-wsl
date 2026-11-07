/**
 * Update runner (issue #12): the only place that sequences an update.
 *
 * Order is fixed and every step is published to the modal window:
 *
 *   checking    npm confirms the exact published version exists
 *   installing  npm installs it into `<root>/update/stage-<tx>` (backend keeps
 *               running: nothing it uses is touched yet)
 *   verifying   the staged executable must report exactly the target version
 *   stopping    auto-recovery is paused and the app-owned backend is stopped
 *   activating  the staged tree replaces `runtime/`, the old tree is kept as
 *               `update/previous-<tx>`, the activated executable is re-checked
 *   starting    a full backend start (runtime resolution, token exchange and the
 *               authenticated request) — success is only claimed after this
 *
 * A journal is written before the swap, so an interruption between the two
 * renames is recoverable on the next start (`update-recovery.ts`). Nothing is
 * retried: a failure restores the previous installation and starts the old
 * backend again.
 *
 * Nothing here decides that an update may happen: `planUpdate()` has already
 * rejected global installations, custom executables, foreign runtimes, unsafe
 * roots and non-exact versions.
 */
import type { Logger } from './logger.js';
import type { UpdateTransition, WslGateway } from './supervisor.js';
import {
  createUpdateState,
  createUpdateTerminal,
  describeUpdatePhase,
  phaseFromUpdateLine,
  type UpdateJournalPhase,
  type UpdateJournalStore,
  type UpdatePlan,
  type UpdateState,
} from './update.js';

/** Minimal supervisor surface the runner needs. */
export interface UpdateLifecycle {
  pauseForUpdate(): Promise<UpdateTransition>;
  resumeAfterUpdate(): Promise<UpdateTransition>;
  releaseUpdateLock(): void;
  updateInProgress: boolean;
}

export interface UpdateRunnerDeps {
  wsl: Pick<
    WslGateway,
    'checkPublishedVersion' | 'stageRuntime' | 'activateRuntime' | 'restoreRuntime'
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
}

export interface UpdateOutcome {
  ok: boolean;
  state: UpdateState;
}

export interface UpdateRunner {
  snapshot(): UpdateState;
  running(): boolean;
  /** Run one accepted plan. Never runs concurrently. */
  run(plan: UpdatePlan, context: UpdateContext): Promise<UpdateOutcome>;
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

  const journal = (
    plan: UpdatePlan,
    context: UpdateContext,
    phase: UpdateJournalPhase,
    startedAt: string,
  ): void => {
    deps.journal.write({
      version: 1,
      transaction: context.transaction,
      phase,
      distro: plan.distro,
      runtimeRoot: plan.runtimeRoot,
      canonicalRoot: plan.canonicalRoot,
      target: plan.version,
      installed: plan.installedVersion,
      startedAt,
      updatedAt: deps.now(),
    });
  };

  return {
    snapshot: () => state,
    running: () => busy,

    async run(plan: UpdatePlan, context: UpdateContext): Promise<UpdateOutcome> {
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
      let activated = false;

      try {
        const check = await deps.wsl.checkPublishedVersion({
          distro: plan.distro,
          isolationRoot: plan.runtimeRoot,
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

        // 1. Stage the new version next to the running one.
        journal(plan, context, 'staging', startedAt);
        publish({ phase: 'installing', message: describeUpdatePhase('installing') });
        const request = {
          distro: plan.distro,
          isolationRoot: plan.runtimeRoot,
          version: plan.version,
          nodePath: context.nodePath,
          npmPath: check.npmPath,
          transaction: context.transaction,
        };
        const staged = await deps.wsl.stageRuntime(request, append);
        if (staged.code !== 0) {
          deps.journal.clear();
          const detail =
            staged.tail === '' ? `The updater exited with code ${staged.code ?? 'unknown'}.` : staged.tail;
          return { ok: false, state: fail(detail) };
        }
        terminal.append(`update: ${plan.version} staged and verified`);

        // 2. Quiesce: pause recovery, stop only the app-owned backend.
        publish({ phase: 'stopping', message: describeUpdatePhase('stopping') });
        const paused = await deps.lifecycle.pauseForUpdate();
        if (!paused.ok) {
          deps.journal.clear();
          return {
            ok: false,
            state: fail(paused.message ?? 'The app-owned backend could not be stopped, so nothing was replaced.'),
          };
        }

        // 3. Swap. The journal already says "activating": a crash from here on is
        //    repaired by the recovery path on the next start.
        journal(plan, context, 'activating', startedAt);
        const swap = await deps.wsl.activateRuntime(request, append);
        activated = swap.code === 0;
        if (!activated) {
          // The script restores the previous install itself; do it again (it is
          // idempotent) in case the swap died halfway through.
          const restored = await deps.wsl.restoreRuntime(
            {
              distro: plan.distro,
              isolationRoot: plan.runtimeRoot,
              transaction: context.transaction,
              nodePath: context.nodePath,
            },
            append,
          );
          const resumed = await deps.lifecycle.resumeAfterUpdate();
          deps.journal.clear();
          const detail =
            swap.tail === '' ? `Activation failed with code ${swap.code ?? 'unknown'}.` : swap.tail;
          const extra = [
            restored.code === 0 ? 'The previous installation was restored.' : 'The previous installation could not be restored automatically.',
            resumed.ok ? 'The previous version is running again.' : (resumed.message ?? 'The backend did not start again.'),
          ].join(' ');
          return { ok: false, state: fail(`${detail} ${extra}`, 'rolled-back') };
        }

        // 4. Prove the new version actually serves the WebUI.
        journal(plan, context, 'verifying-backend', startedAt);
        publish({ phase: 'starting', message: describeUpdatePhase('starting') });
        const resumed = await deps.lifecycle.resumeAfterUpdate();
        if (!resumed.ok) {
          terminal.append('update: the new version did not start, restoring the previous installation');
          const restored = await deps.wsl.restoreRuntime(
            {
              distro: plan.distro,
              isolationRoot: plan.runtimeRoot,
              transaction: context.transaction,
              nodePath: context.nodePath,
            },
            append,
          );
          const recovered = await deps.lifecycle.resumeAfterUpdate();
          deps.journal.clear();
          const extra = [
            restored.code === 0
              ? 'The previous installation was restored.'
              : 'The previous installation could not be restored automatically.',
            recovered.ok
              ? 'The previous version is running again.'
              : (recovered.message ?? 'The previous version could not be started either.'),
          ].join(' ');
          return {
            ok: false,
            state: fail(`${resumed.message ?? 'The new version did not start.'} ${extra}`, 'rolled-back'),
          };
        }

        deps.journal.clear();
        terminal.append(`update: ${plan.version} is serving the WebUI`);
        const done = publish({
          phase: 'done',
          message: `Updated to ${plan.version}`,
          detail: `Previous installation kept in ${plan.previousPattern} for rollback.`,
        });
        deps.log.info(`update: completed ${plan.installedVersion} -> ${plan.version}`);
        return { ok: true, state: done };
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
        if (activated) {
          // The swap happened, so never leave the lock or the journal behind.
          await deps.wsl
            .restoreRuntime(
              {
                distro: plan.distro,
                isolationRoot: plan.runtimeRoot,
                transaction: context.transaction,
                nodePath: context.nodePath,
              },
              append,
            )
            .catch(() => undefined);
          deps.journal.clear();
          await deps.lifecycle.resumeAfterUpdate().catch(() => undefined);
        } else {
          deps.lifecycle.releaseUpdateLock();
        }
        return { ok: false, state: fail(detail) };
      } finally {
        busy = false;
      }
    },
  };
}
