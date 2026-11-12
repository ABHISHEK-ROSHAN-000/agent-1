import path from "node:path"
import type { Logger } from "../core/log"
import type { Database } from "../db/database"
import { CheckpointManager } from "../checkpoints/manager"

export async function createTestCheckpointManager(
  db: Database,
  dataDir: string,
  logger: Logger,
): Promise<CheckpointManager> {
  const checkpoints = new CheckpointManager(db, logger, path.join(dataDir, "checkpoints"))
  await checkpoints.initialize()
  return checkpoints
}
