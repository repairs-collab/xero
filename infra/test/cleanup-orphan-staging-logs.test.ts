import { describe, expect, it } from 'vitest';

import {
  cleanupOrphanStagingLogs,
  stagingLogGroups,
} from '../../scripts/cleanup-orphan-staging-logs.mjs';
import type { CommandRunner } from '../../scripts/cleanup-orphan-staging-logs.mjs';

describe('cleanupOrphanStagingLogs', () => {
  it('deletes the retained staging log groups when the service stack is absent', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: CommandRunner = (command, args) => {
      calls.push({ command, args });

      if (args[0] === 'cloudformation') {
        return Promise.reject(
          new Error(
            'ValidationError: Stack with id staging-bill-chaser-services does not exist'
          )
        );
      }

      return Promise.resolve({ stdout: '' });
    };

    const result = await cleanupOrphanStagingLogs(run);

    expect(result).toEqual({ deleted: stagingLogGroups });
    expect(calls).toEqual([
      {
        command: 'aws',
        args: [
          'cloudformation',
          'describe-stacks',
          '--stack-name',
          'staging-bill-chaser-services',
          '--query',
          'Stacks[0].StackStatus',
          '--output',
          'text',
        ],
      },
      ...stagingLogGroups.map((logGroupName) => ({
        command: 'aws',
        args: ['logs', 'delete-log-group', '--log-group-name', logGroupName],
      })),
    ]);
  });

  it('leaves log groups intact while the staging service stack exists', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: CommandRunner = (command, args) => {
      calls.push({ command, args });
      return Promise.resolve({ stdout: 'CREATE_COMPLETE\n' });
    };

    const result = await cleanupOrphanStagingLogs(run);

    expect(result).toEqual({ deleted: [] });
    expect(calls).toEqual([
      {
        command: 'aws',
        args: [
          'cloudformation',
          'describe-stacks',
          '--stack-name',
          'staging-bill-chaser-services',
          '--query',
          'Stacks[0].StackStatus',
          '--output',
          'text',
        ],
      },
    ]);
  });

  it('deletes a rolled-back staging service stack before its retained logs', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: CommandRunner = (command, args) => {
      calls.push({ command, args });
      return Promise.resolve({
        stdout:
          args[0] === 'cloudformation' && args[1] === 'describe-stacks'
            ? 'ROLLBACK_COMPLETE\n'
            : '',
      });
    };

    const result = await cleanupOrphanStagingLogs(run);

    expect(result).toEqual({ deleted: stagingLogGroups });
    expect(calls).toEqual([
      {
        command: 'aws',
        args: [
          'cloudformation',
          'describe-stacks',
          '--stack-name',
          'staging-bill-chaser-services',
          '--query',
          'Stacks[0].StackStatus',
          '--output',
          'text',
        ],
      },
      {
        command: 'aws',
        args: [
          'cloudformation',
          'delete-stack',
          '--stack-name',
          'staging-bill-chaser-services',
        ],
      },
      {
        command: 'aws',
        args: [
          'cloudformation',
          'wait',
          'stack-delete-complete',
          '--stack-name',
          'staging-bill-chaser-services',
        ],
      },
      ...stagingLogGroups.map((logGroupName) => ({
        command: 'aws',
        args: ['logs', 'delete-log-group', '--log-group-name', logGroupName],
      })),
    ]);
  });

  it('does not delete logs when the stack check fails for another reason', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: CommandRunner = (command, args) => {
      calls.push({ command, args });
      return Promise.reject(
        new Error('AccessDenied: not authorized to describe stacks')
      );
    };

    await expect(cleanupOrphanStagingLogs(run)).rejects.toThrow('AccessDenied');
    expect(calls).toHaveLength(1);
  });
});
