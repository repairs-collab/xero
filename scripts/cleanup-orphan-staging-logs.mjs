import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const stagingLogGroups = [
  '/bill-chaser-5000/staging/web',
  '/bill-chaser-5000/staging/worker',
];

const execFileAsync = promisify(execFile);

async function runCommand(command, args) {
  return execFileAsync(command, args);
}

export async function cleanupOrphanStagingLogs(run = runCommand) {
  try {
    await run('aws', [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      'staging-bill-chaser-services',
      '--query',
      'Stacks[0].StackStatus',
      '--output',
      'text',
    ]);
    return { deleted: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('does not exist')) {
      throw error;
    }
  }

  for (const logGroupName of stagingLogGroups) {
    await run('aws', [
      'logs',
      'delete-log-group',
      '--log-group-name',
      logGroupName,
    ]);
  }

  return { deleted: stagingLogGroups };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await cleanupOrphanStagingLogs();
  if (result.deleted.length === 0) {
    process.stdout.write(
      'Staging service stack exists; retained logs were left intact.\n'
    );
  } else {
    process.stdout.write(
      `Deleted orphaned staging log groups: ${result.deleted.join(', ')}\n`
    );
  }
}
