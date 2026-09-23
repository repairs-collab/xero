export type CommandResult = {
  stdout: string | Buffer;
  stderr?: string | Buffer;
};

export type CommandRunner = (
  command: string,
  args: string[]
) => Promise<CommandResult>;

export const stagingLogGroups: string[];

export function cleanupOrphanStagingLogs(
  run?: CommandRunner
): Promise<{ deleted: string[] }>;
