const Database = require('bun:sqlite').Database;
const fs = require('fs');

console.log('--- Inspecting shopsite-cms.db ---');
if (fs.existsSync('shopsite-cms.db')) {
  const db = new Database('shopsite-cms.db');
  
  // Workspaces
  try {
    const workspaces = db.query('SELECT * FROM workspaces').all();
    console.log('Workspaces:', workspaces);
  } catch (err) {
    console.log('No workspaces table or error:', err.message);
  }
  
  // Field registry
  try {
    const registryCount = db.query('SELECT COUNT(*) as count FROM field_registry').get();
    console.log('Field registry entries count:', registryCount);
    const registrySample = db.query('SELECT * FROM field_registry LIMIT 5').all();
    console.log('Field registry sample:', registrySample);
  } catch (err) {
    console.log('No field_registry table or error:', err.message);
  }
} else {
  console.log('shopsite-cms.db does not exist.');
}

console.log('--- Inspecting workspaces/Bay State/app.db ---');
const path = 'workspaces/Bay State/app.db';
if (fs.existsSync(path)) {
  const db = new Database(path);
  
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables:', tables.map(t => t.name));
  } catch (err) {
    console.log('Error reading tables:', err.message);
  }
  
  try {
    const count = db.query('SELECT COUNT(*) as count FROM product_index').get();
    console.log('product_index count:', count);
  } catch (err) {
    console.log('No product_index table or error:', err.message);
  }
} else {
  console.log('app.db does not exist at that path.');
}
