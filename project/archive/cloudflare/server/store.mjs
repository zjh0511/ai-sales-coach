export const schema = `CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS records_expires ON records(expires);`;
export class SqlStore {
  constructor(db, cloud = false) { this.db = db; this.cloud = cloud; }
  statement(sql, args = []) { const stmt = this.db.prepare(sql); return this.cloud ? stmt.bind(...args) : { first: () => stmt.get(...args), all: () => ({ results: stmt.all(...args) }), run: () => stmt.run(...args) }; }
  async get(id) {
    const row = await this.statement('SELECT value, revision FROM records WHERE id = ? AND (expires = 0 OR expires > ?)', [id, Date.now()]).first();
    return row ? { ...JSON.parse(row.value), _revision: row.revision } : null;
  }
  async put(id, value, ttl = 0) {
    const { _revision, ...clean } = value;
    await this.statement('INSERT INTO records(id,value,expires) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, expires=excluded.expires, revision=records.revision+1', [id, JSON.stringify(clean), ttl ? Date.now() + ttl : 0]).run();
  }
  async cas(id, revision, value, ttl = 7200000) {
    const { _revision, ...clean } = value;
    const result = await this.statement('UPDATE records SET value=?, expires=?, revision=revision+1 WHERE id=? AND revision=?', [JSON.stringify(clean), Date.now() + ttl, id, revision]).run();
    return Number(result.changes ?? result.meta?.changes ?? 0) === 1;
  }
  async delete(id) { await this.statement('DELETE FROM records WHERE id=?', [id]).run(); }
  async list(prefix) {
    const rows = await this.statement('SELECT id,value,revision FROM records WHERE substr(id,1,?)=? AND (expires=0 OR expires>?)', [prefix.length, prefix, Date.now()]).all();
    return rows.results.map(r => ({ ...JSON.parse(r.value), _revision: r.revision, _id: r.id }));
  }
  async purge() { await this.statement('DELETE FROM records WHERE expires>0 AND expires<?', [Date.now()]).run(); }
}
