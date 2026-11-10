import 'dotenv/config';
if (!process.env.A11Y_DATA_DIR) throw new Error('请显式设置 A11Y_DATA_DIR，防止操作错误数据库。');
const {initializeAccounts} = await import('../apps/api/auth');
const {DATA,db,now} = await import('../apps/api/storage');
await initializeAccounts();
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--list') {
  console.log(JSON.stringify({
    dataDir:DATA,
    unclaimed:db.prepare('SELECT id,name,created_at FROM projects WHERE owner_user_id IS NULL ORDER BY created_at').all(),
    users:db.prepare('SELECT id,email FROM user WHERE coalesce(isAnonymous,0)=0 ORDER BY createdAt').all(),
  },null,2));
} else {
  const [action,projectId,userId] = args;
  if (action !== '--apply' || args.length !== 3 || !projectId || !userId) {
    throw new Error('用法：--list 或 --apply <项目ID> <用户ID>。');
  }
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM user WHERE id=? AND coalesce(isAnonymous,0)=0').get(userId)) throw new Error('目标账号不存在。');
    const result = db.prepare('UPDATE projects SET owner_user_id=? WHERE id=? AND owner_user_id IS NULL').run(userId,projectId);
    if (result.changes!==1) throw new Error('项目不存在或已有归属。');
    db.prepare('INSERT INTO legacy_project_claims VALUES (?,?,?)').run(projectId,userId,now());
  })();
  console.log('已认领项目 '+projectId+' → '+userId);
}
