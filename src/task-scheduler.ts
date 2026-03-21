import { ChildProcess, execFile } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

const SENTINEL_TIMEOUT_MS = 30_000;
const SENTINEL_MAINTAIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SENTINEL_MAINTAIN_RUN_COUNT = 50;

interface SentinelResult {
  triggered: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

function runSentinelScript(scriptPath: string): Promise<SentinelResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const child = execFile(
      '/bin/bash',
      [scriptPath],
      { timeout: SENTINEL_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode =
          error && 'code' in error ? (error.code as number | null) : 0;
        resolve({
          triggered: exitCode !== 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode,
          durationMs: Date.now() - startTime,
        });
      },
    );
    child.on('error', (err) => {
      resolve({
        triggered: true,
        stdout: '',
        stderr: err.message,
        exitCode: null,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

function needsSentinelMaintenance(task: ScheduledTask): boolean {
  if (!task.sentinel_maintain_at) return false;
  const lastMaintain = new Date(task.sentinel_maintain_at).getTime();
  return Date.now() - lastMaintain > SENTINEL_MAINTAIN_INTERVAL_MS;
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  // --- Sentinel pre-check: run lightweight bash script on host ---
  if (task.sentinel_script && !needsSentinelMaintenance(task)) {
    const scriptPath = path.join(groupDir, task.sentinel_script);
    if (fs.existsSync(scriptPath)) {
      logger.debug(
        { taskId: task.id, scriptPath },
        'Running sentinel pre-check',
      );
      const sentinel = await runSentinelScript(scriptPath);
      logger.info(
        {
          taskId: task.id,
          triggered: sentinel.triggered,
          exitCode: sentinel.exitCode,
          durationMs: sentinel.durationMs,
        },
        'Sentinel check completed',
      );

      if (!sentinel.triggered) {
        // No change detected — skip the full Agent invocation
        const durationMs = Date.now() - startTime;
        logTaskRun({
          task_id: task.id,
          run_at: new Date().toISOString(),
          duration_ms: durationMs,
          status: 'success',
          result: 'sentinel: no change',
          error: null,
        });
        const nextRun = computeNextRun(task);
        updateTaskAfterRun(task.id, nextRun, 'sentinel: no change');
        return;
      }

      // Sentinel triggered — inject alert context into prompt for the Agent
      task = {
        ...task,
        prompt: `[SENTINEL ALERT — Your sentinel check script detected a change. Details below.]\n\n--- Sentinel stdout ---\n${sentinel.stdout || '(empty)'}\n--- End sentinel stdout ---\n\nOriginal task: ${task.prompt}`,
      };
      logger.info(
        { taskId: task.id },
        'Sentinel triggered, invoking agent with alert context',
      );
    } else {
      logger.warn(
        { taskId: task.id, scriptPath },
        'Sentinel script not found, falling through to full agent',
      );
    }
  } else if (task.sentinel_script && needsSentinelMaintenance(task)) {
    // Time for maintenance — invoke full Agent with maintenance prompt
    task = {
      ...task,
      prompt: `[SENTINEL MAINTENANCE — Your sentinel check script has not been reviewed in a while. Please review and update it if needed, then run the original task.]\n\nSentinel script path (relative to group folder): ${task.sentinel_script}\n\nOriginal task: ${task.prompt}`,
    };
    updateTask(task.id, {
      sentinel_maintain_at: new Date().toISOString(),
    });
    logger.info(
      { taskId: task.id },
      'Sentinel maintenance triggered, invoking agent for script review',
    );
  }

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
