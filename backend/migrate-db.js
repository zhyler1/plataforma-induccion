const Database = require('better-sqlite3');
const db = new Database('./database.db');

try {
  db.exec('ALTER TABLE usuarios ADD COLUMN cedula_hash TEXT');
  console.log('✅ Columna cedula_hash agregada');
} catch (error) {
  console.log('⚠️ Columna ya existe o error:', error.message);
}

db.close();
