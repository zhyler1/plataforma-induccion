const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const db = new Database('./database.db');

async function actualizarHashes() {
  const empleados = db.prepare('SELECT cedula, nombre_completo FROM empleados').all();
  
  console.log(`Actualizando ${empleados.length} empleados...`);
  
  for (const emp of empleados) {
    const hash = await bcrypt.hash(emp.cedula, 12);
    db.prepare('UPDATE empleados SET cedula_hash = ? WHERE cedula = ?').run(hash, emp.cedula);
    console.log(`✓ Hash generado para ${emp.nombre_completo}`);
  }
  
  console.log('✅ Todos los hashes actualizados');
  db.close();
}

actualizarHashes();
