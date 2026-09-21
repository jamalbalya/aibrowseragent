/**
 * TEST-TASK-001 — Task state machine (REQ-TASK-001).
 */
import { describe, expect, it } from 'vitest';
import {
  TASK_STATES,
  TERMINAL_STATES,
  canTransition,
  createTask,
  isTerminal,
  outcomeForState,
  type TaskState,
} from '@/tasks/task-model';
import { recoveryStateFor } from '@/tasks/task-store';

const LIVE_STATES = TASK_STATES.filter((state) => !isTerminal(state));

describe('task state machine', () => {
  it('creates a task in QUEUED with empty history', () => {
    const task = createTask({
      id: 'task_1',
      sessionId: 's1',
      objective: 'Read the page',
      providerId: 'fake',
      modelId: 'm',
      permissionMode: 'auto',
      now: 1000,
    });
    expect(task.state).toBe('QUEUED');
    expect(task.steps).toEqual([]);
    expect(task.usage.toolCalls).toBe(0);
    expect(task.createdAt).toBe(1000);
  });

  it('allows every live state to reach CANCELLED', () => {
    // "Never leave a task permanently stuck in RUNNING" requires that cancel
    // is reachable from anywhere that is not already finished.
    for (const state of LIVE_STATES) {
      expect(canTransition(state, 'CANCELLED'), `${state} -> CANCELLED`).toBe(true);
    }
  });

  it('allows every live state to reach FAILED', () => {
    for (const state of LIVE_STATES) {
      expect(canTransition(state, 'FAILED'), `${state} -> FAILED`).toBe(true);
    }
  });

  it('makes terminal states absorbing', () => {
    for (const state of TERMINAL_STATES) {
      for (const target of TASK_STATES) {
        expect(canTransition(state, target), `${state} -> ${target}`).toBe(false);
      }
    }
  });

  it('rejects a jump straight from QUEUED to RUNNING', () => {
    // Planning always happens first, so the UI can show a plan.
    expect(canTransition('QUEUED', 'RUNNING')).toBe(false);
    expect(canTransition('QUEUED', 'PLANNING')).toBe(true);
  });

  it('allows the normal execution cycle', () => {
    expect(canTransition('PLANNING', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'WAITING_FOR_TOOL')).toBe(true);
    expect(canTransition('WAITING_FOR_TOOL', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(true);
  });

  it('allows pause and resume', () => {
    expect(canTransition('RUNNING', 'PAUSED')).toBe(true);
    expect(canTransition('PAUSED', 'RUNNING')).toBe(true);
  });

  it('allows every live state to reach PAUSED', () => {
    // Pausing a task that has not started executing yet must still be
    // recorded, or the record is stuck with nothing running it.
    for (const state of LIVE_STATES) {
      expect(canTransition(state, 'PAUSED') || state === 'PAUSED', `${state} -> PAUSED`).toBe(true);
    }
  });

  it('does not allow resuming a cancelled task', () => {
    expect(canTransition('CANCELLED', 'RUNNING')).toBe(false);
  });

  it('maps every terminal state to an outcome and every live state to null', () => {
    for (const state of TASK_STATES) {
      const outcome = outcomeForState(state);
      if (isTerminal(state)) expect(outcome).toBe(state);
      else expect(outcome).toBeNull();
    }
  });
});

describe('recoveryStateFor', () => {
  it('parks actively executing tasks rather than resuming them blind', () => {
    // The page may have moved on during the restart, so silently continuing
    // could act on the wrong thing.
    for (const state of ['RUNNING', 'PLANNING', 'WAITING_FOR_TOOL', 'RECOVERING'] as TaskState[]) {
      expect(recoveryStateFor(state), state).toBe('PAUSED');
    }
  });

  it('parks a task whose permission prompt died with the panel', () => {
    expect(recoveryStateFor('WAITING_FOR_PERMISSION')).toBe('PAUSED');
  });

  it('leaves queued and already-paused tasks alone', () => {
    expect(recoveryStateFor('QUEUED')).toBe('QUEUED');
    expect(recoveryStateFor('PAUSED')).toBe('PAUSED');
    expect(recoveryStateFor('WAITING_FOR_USER')).toBe('WAITING_FOR_USER');
  });

  it('never changes a terminal state', () => {
    for (const state of TERMINAL_STATES) {
      expect(recoveryStateFor(state), state).toBe(state);
    }
  });
});
