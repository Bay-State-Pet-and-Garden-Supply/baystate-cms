const Database = require('bun:sqlite').Database;
const db = new Database('/Users/nickborrello/Desktop/Projects/shopsite-cms/workspaces/Bay State/.shopsite-cms/app.db');

try {
  const runs = db.query(`SELECT * FROM curation_runs`).all();
  console.log("Curation Runs:");
  console.log(JSON.stringify(runs, null, 2));

  const runItems = db.query(`SELECT * FROM curation_run_items LIMIT 5`).all();
  console.log("\nCuration Run Items:");
  console.log(JSON.stringify(runItems, null, 2));

  // Let's also check what classification config files or curation targets are in the cache
  const configFiles = db.query(`SELECT file_name, schema_version FROM classification_config_files`).all();
  console.log("\nConfig Files:");
  console.log(JSON.stringify(configFiles, null, 2));

  // Let's print the curation targets configured for this workspace
  const targets = db.query(`SELECT * FROM classification_config_files WHERE file_name = 'curation-targets.json'`).get();
  if (targets) {
    console.log("\nCuration Targets Config:");
    console.log(JSON.stringify(JSON.parse(targets.content_json), null, 2));
  }
} catch (err) {
  console.error("Database query failed:", err);
} finally {
  db.close();
}
