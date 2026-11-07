/**
 * Update runner (issue #12): the only place that sequences an update.
 *
 * Order is fixed and each step is published to the modal window:
 *   checking  -> npm confirms the exact published version exists
 *   installing-> npm installs it into a staging prefix inside the isolated root
 *   verifying -> the script checks the staged executable
 *   activating-> the script swaps the staged tree in and keeps the old one
 *   done/failed
 *
 * Nothing here decides on its own that an update may happen: `planUpdate()`
 * has already rejected global installations, custom executables and foreign
 * runtimes. The runner only executes an accepted plan and never retries.
 */
import type { Logger } from './logger.js';
import type { WslGateway } from './supervisor.js';
import {
  createUpdateState,
  createUpdateTerminal,
  describeUpdatePhase,
  phaseFromUpdateLine,
  type UpdateState,
  type UpdatePlan,
} from './update.js';

export interface UpdateRunnerDeps {
  wsl: Pick<WslGateway, 'checkPublishedVersion' | 'installRuntime'>;
  log: Logger;
  /** Push the current state to every window that renders it. */
  publish: (state: UpdateState) => void;
  now: () => string;
}

export interface UpdateContext {
  distro: string;
  nodePath: string | null;
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
    state = { ...state, ...next, lines: terminal.lines(), updatedAt: deps.now() };
    deps.publish(state);
    return state;
  };

  const append = (line: string): void => {
    const kept = terminal.append(line);
    if (kept === null) return;
    const phase = phaseFromUpdateLine(kept);
    if (phase !== null && phase !== state.phase) {
      // One publish per real transition; repeated markers stay silent.
      // Step markers from the updater script move the phase forward.
      publish({ phase, message: describeUpdatePhase(phase) });
      return;
    }
    publish({});
  };

  const fail = (detail: string, phase: UpdateState['phase'] = 'failed'): UpdateState => {
    deps.log.error(`update failed: ${detail}`);
    return publish({ phase, message: describeUpdatePhase(phase), detail });
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

        publish({ phase: 'installing', message: describeUpdatePhase('installing') });
        const request = {
          distro: plan.distro,
          isolationRoot: plan.runtimeRoot,
          version: plan.version,
          nodePath: context.nodePath,
          npmPath: check.npmPath,
        };
        const result = await deps.wsl.installRuntime(request, append);
        if (result.code !== 0) {
          const detail = result.tail === '' ? `The updater exited with code ${result.code ?? 'unknown'}.` : result.tail;
          return { ok: false, state: fail(detail) };
        }

        // The script verified the installed version before it returned 0.
        terminal.append(`update: ${plan.version} installed and verified`);
        const done = publish({
          phase: 'done',
          message: `Updated to ${plan.version}`,
          detail: `Previous installation kept in ${plan.previousPattern} for rollback.`,
        });
        deps.log.info(`update: completed ${plan.installedVersion} -> ${plan.version}`);
        return { ok: true, state: done };
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
        return { ok: false, state: fail(detail) };
      } finally {
        busy = false;
      }
    },
  };
}
