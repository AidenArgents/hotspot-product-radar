import type { RadarConfig } from "./types.ts";
import { connectDatabase, ensureSchema } from "./database.ts";

export async function main(config: RadarConfig) {
  const sql = connectDatabase(config);
  try {
    await ensureSchema(sql);
    return { ok: true, database_file: config.database_file };
  } finally {
    sql.close();
  }
}
