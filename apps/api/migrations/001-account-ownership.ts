import type Database from 'better-sqlite3';

export function migrateOwnership(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, type TEXT, status TEXT, result TEXT, error TEXT, created_at TEXT
    );`);
    const hasColumn = (table: 'projects' | 'jobs', column: string) =>
      db.prepare('PRAGMA table_info('+table+')').all().some(row => (row as {name:string}).name === column);
    if (!hasColumn('projects','owner_user_id')) db.exec('ALTER TABLE projects ADD COLUMN owner_user_id TEXT REFERENCES user(id)');
    if (!hasColumn('projects','updated_at')) db.exec('ALTER TABLE projects ADD COLUMN updated_at TEXT');
    if (!hasColumn('jobs','project_id')) db.exec('ALTER TABLE jobs ADD COLUMN project_id TEXT REFERENCES projects(id)');
    db.exec(`CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_user_id);
      CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id);
      CREATE TRIGGER IF NOT EXISTS project_version_timestamp AFTER UPDATE OF current_snapshot ON projects
        WHEN OLD.current_snapshot <> NEW.current_snapshot BEGIN
        UPDATE projects SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS project_rename_timestamp AFTER UPDATE OF name ON snapshots
        WHEN OLD.name IS NOT NEW.name BEGIN
        UPDATE projects SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.project_id;
      END;
      CREATE TABLE IF NOT EXISTS legacy_project_claims (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES user(id), claimed_at TEXT NOT NULL
      );`);
  })();
}
