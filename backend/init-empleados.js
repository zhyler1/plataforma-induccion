const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

async function initEmpleados() {
  const db = new Database('./database.db');
  
  // Verificar si ya existen empleados
  const count = db.prepare('SELECT COUNT(*) as total FROM empleados').get();
  
  if (count.total > 0) {
    console.log('✅ Empleados ya existen:', count.total);
    db.close();
    return;
  }
  
  console.log('📝 Creando empleados iniciales...');
  
  // Empleados para agregar
  const empleados = [
    { cedula: '79689057', nombre: 'SERGIO LOPEZ' },
    { cedula: '66971658', nombre: 'NHORA YHANET MONDRAGON ORTIZ' },
    { cedula: '1019031092', nombre: 'PAULA ANDREA CAÑON RODRIGUEZ' }
  ];
  
  for (const emp of empleados) {
    const hash = await bcrypt.hash(emp.cedula, 12);
    db.prepare('INSERT OR IGNORE INTO empleados (cedula, cedula_hash, nombre_completo, estado) VALUES (?, ?, ?, ?)')
      .run(emp.cedula, hash, emp.nombre, 'activo');
    console.log('✅', emp.nombre);
  }
  
  console.log('🎉 Empleados creados exitosamente');
  db.close();
}

initEmpleados().catch(console.error);
