const Database = require('bun:sqlite').Database;
const path = 'workspaces/Bay State/.shopsite-cms/app.db';
const db = new Database(path);

const registry = db.query('SELECT xml_field, label, kind, data_type FROM field_registry ORDER BY xml_field ASC').all();
console.log('All field_registry entries:');
for (const entry of registry) {
  console.log(`  xml_field: "${entry.xml_field}", label: "${entry.label}", kind: "${entry.kind}", data_type: "${entry.data_type}"`);
}
