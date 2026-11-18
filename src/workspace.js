import { join } from 'node:path';

export function sessionPaths(dataDir, id) {
  const root = join(dataDir, 'sessions', id);
  return {
    root,
    workspace: join(root, 'workspace'),
    cliData: join(root, 'open-code-data'),
  };
}
