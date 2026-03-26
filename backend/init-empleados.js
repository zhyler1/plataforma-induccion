const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

async function initEmpleados() {
  const db = new Database('./database.db');
  
  // PRIMERO: Agregar columna si no existe
  try {
    db.exec('ALTER TABLE usuarios ADD COLUMN cedula_hash TEXT');
    console.log('✅ Columna cedula_hash agregada');
  } catch (error) {
    console.log('⚠️ Columna cedula_hash ya existe');
  }
  
  const count = db.prepare('SELECT COUNT(*) as total FROM usuarios').get();
  
  if (count.total > 0) {
    console.log('✅ Ya hay usuarios registrados:', count.total);
    db.close();
    return;
  }
  
  console.log('📝 Creando usuario admin inicial...');
  
  const cedulaHash = await bcrypt.hash('79689057', 12);
  
  db.prepare(`
    INSERT INTO usuarios (cedula, nombre, email, cedula_hash, rol) 
    VALUES (?, ?, ?, ?, ?)
  `).run('79689057', 'SERGIO LOPEZ', 'sergiolopez@presidencia.gov.co', cedulaHash, 'admin');
  
  const usuario = db.prepare('SELECT * FROM usuarios WHERE cedula = ?').get('79689057');
  db.prepare('INSERT INTO progreso_usuarios (usuario_id) VALUES (?)').run(usuario.id);
  
  console.log('✅ Usuario admin creado: sergiolopez@presidencia.gov.co');
  db.close();
}

initEmpleados().catch(console.error);
