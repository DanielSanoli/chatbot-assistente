import Database from "better-sqlite3";

const db = new Database("./data/chatbot.db");
const rows = db
  .prepare(
    `SELECT tipo, payload_json, criado_em
       FROM events
      WHERE tipo IN ('brain.claude_error', 'brain.error', 'handoff.transferido', 'brain.turno')
      ORDER BY id DESC
      LIMIT 25`,
  )
  .all();

for (const r of rows) {
  let p = {};
  try {
    p = JSON.parse(r.payload_json);
  } catch {
    /* ignore */
  }
  const out = { criado: r.criado_em, tipo: r.tipo };
  if (p.motivo) out.motivo = p.motivo;
  if (p.error) out.error = String(p.error).slice(0, 400);
  if (p.error_name) out.error_name = p.error_name;
  if (p.model) out.model = p.model;
  if (p.ferramentas) out.ferramentas = p.ferramentas;
  console.log(JSON.stringify(out));
}

const conv = db
  .prepare(
    `SELECT wa_id, estado, substr(estado_payload, 1, 220) AS p
       FROM conversations
      WHERE wa_id = ?`,
  )
  .get("5511999990001");
console.log("CONV", JSON.stringify(conv));
db.close();
