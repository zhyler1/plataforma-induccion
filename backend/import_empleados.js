const XLSX = require('xlsx');
const Database = require('better-sqlite3');

// Configuración
const excelFile = './Libro1.xlsx';
const dbFile = './users.db';

// Conectar a la base de datos
const db = new Database(dbFile);

// Crear tabla de empleados si no existe
db.exec(`
    CREATE TABLE IF NOT EXISTS empleados (
        cedula TEXT PRIMARY KEY,
        nombre_completo TEXT UNIQUE NOT NULL,
        estado TEXT DEFAULT 'activo',
        fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Leer el archivo Excel
console.log('📖 Leyendo archivo Excel...');
const workbook = XLSX.readFile(excelFile);
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet);

console.log(`✅ Se encontraron ${data.length} registros\n`);

// Preparar statement de inserción
const insert = db.prepare(`
    INSERT OR REPLACE INTO empleados (cedula, nombre_completo, estado)
    VALUES (?, ?, 'activo')
`);

// Importar datos
let importados = 0;
let errores = 0;

data.forEach((row, index) => {
    try {
        const cedula = String(row['Identificación']).trim();
        const nombres = (row['Nombres'] || '').trim();
        const apellidos = (row['Apellidos'] || '').trim();
        const nombreCompleto = `${nombres} ${apellidos}`.trim();
        
        if (cedula && nombreCompleto) {
            insert.run(cedula, nombreCompleto);
            importados++;
            console.log(`✓ ${importados}. ${nombreCompleto} (${cedula})`);
        } else {
            console.log(`✗ Fila ${index + 2}: Datos incompletos`);
            errores++;
        }
    } catch (error) {
        console.log(`✗ Error en fila ${index + 2}: ${error.message}`);
        errores++;
    }
});

console.log(`\n📊 Resumen:`);
console.log(`   ✅ Importados: ${importados}`);
console.log(`   ❌ Errores: ${errores}`);
console.log(`\n🎉 Importación completada!`);

db.close();
