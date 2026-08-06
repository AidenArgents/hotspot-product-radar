import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../config.ts";
import { callGemini } from "../f/radar/gemini.ts";

const config = loadConfig();
const database = new DatabaseSync(config.database_file, { readOnly: true });
try {
  const row = database.prepare(`
    SELECT request_payload FROM source_executions
    WHERE source_kind = 'gemini' AND status = 'failed' AND request_payload IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get();
  if (!row) throw new Error("没有可重试的 Gemini 失败记录");
  const prompt = JSON.parse(String(row.request_payload)).prompt;
  const result = await callGemini(config, prompt);
  console.log(JSON.stringify({ ok: true, events: result.events.length, response_chars: result.rawText.length }));
} finally {
  database.close();
}
