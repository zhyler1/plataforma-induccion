const Database = require('better-sqlite3');
const db = new Database('./database.db');

// Crear tabla respuestas_modulos si no existe
db.exec(`
  CREATE TABLE IF NOT EXISTS respuestas_modulos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    modulo_id INTEGER NOT NULL,
    respuestas_json TEXT NOT NULL,
    aciertos INTEGER NOT NULL,
    total_preguntas INTEGER NOT NULL,
    porcentaje DECIMAL(5,2) NOT NULL,
    fecha_respuesta DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
    FOREIGN KEY (modulo_id) REFERENCES modulos(id)
  );
`);

// Agregar columna porcentaje_progreso si no existe
try {
  db.exec('ALTER TABLE progreso_usuarios ADD COLUMN porcentaje_progreso DECIMAL(5,2) DEFAULT 0');
  console.log('✅ Columna porcentaje_progreso agregada');
} catch(e) {
  console.log('⚠️ Columna porcentaje_progreso ya existe');
}

console.log('✅ Tablas verificadas');
db.close();
