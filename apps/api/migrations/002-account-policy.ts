import type Database from 'better-sqlite3';

export function checkEmailUniqueness(db:Database.Database) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'").get()) return;
  if (db.prepare('SELECT 1 FROM user GROUP BY lower(trim(email)) HAVING count(*) > 1 LIMIT 1').get()) {
    throw new Error('检测到历史重复邮箱，已停止账号迁移。请先备份并核对账号归属，再通过受控流程为重复账号绑定不同邮箱。');
  }
}

export function migrateAccountPolicy(db:Database.Database) {
  db.transaction(() => {
    checkEmailUniqueness(db);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS user_normalized_email ON user(lower(trim(email)));
      CREATE TABLE IF NOT EXISTS guest_usage (
        user_id TEXT NOT NULL REFERENCES user(id), kind TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(user_id, kind)
      );`);
  })();
}
