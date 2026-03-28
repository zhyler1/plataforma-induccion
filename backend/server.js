const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));

const dbPath = process.env.DB_PATH || path.join(__dirname, 'database.db');
let db;

try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  console.log('✅ Conectado a SQLite: ' + dbPath);
} catch (error) {
  console.error('❌ Error conectando a la base de datos:', error.message);
  process.exit(1);
}

const MIGRACIONES = [
  { tabla: 'progreso_usuarios', columna: 'porcentaje_progreso', sql: 'ALTER TABLE progreso_usuarios ADD COLUMN porcentaje_progreso REAL DEFAULT 0' },
  { tabla: 'progreso_usuarios', columna: 'fecha_actualizacion', sql: 'ALTER TABLE progreso_usuarios ADD COLUMN fecha_actualizacion DATETIME' },
  { tabla: 'usuarios', columna: 'cedula', sql: 'ALTER TABLE usuarios ADD COLUMN cedula TEXT' },
  { tabla: 'usuarios', columna: 'password_hash', sql: 'ALTER TABLE usuarios ADD COLUMN password_hash TEXT' },
  { tabla: 'respuestas_modulos', columna: 'intentos', sql: 'ALTER TABLE respuestas_modulos ADD COLUMN intentos INTEGER DEFAULT 1' }
];

const aplicarMigraciones = () => {
  console.log('🔄 Aplicando migraciones automáticas...');
  let migradas = 0;
  MIGRACIONES.forEach(function(m) {
    try {
      const info = db.prepare('PRAGMA table_info(' + m.tabla + ')').all();
      const existe = info.some(function(col) { return col.name === m.columna; });
      if (!existe) {
        db.exec(m.sql);
        console.log('✅ Migración aplicada: ' + m.tabla + '.' + m.columna);
        migradas++;
      }
    } catch (error) {
      if (!error.message.includes('no such table')) {
        console.error('⚠️  Error en migración ' + m.tabla + '.' + m.columna + ':', error.message);
      }
    }
  });
  if (migradas === 0) {
    console.log('✅ Base de datos al día');
  } else {
    console.log('✅ ' + migradas + ' migración(es) aplicada(s)');
  }
};

const initializeDatabase = () => {
  console.log('🗄️  Inicializando base de datos...');
  const tables = [
    `CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      cedula TEXT,
      password_hash TEXT,
      fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP,
      ultima_actividad DATETIME DEFAULT CURRENT_TIMESTAMP,
      activo BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS modulos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      descripcion TEXT,
      orden INTEGER NOT NULL,
      activo BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS respuestas_modulos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      modulo_id INTEGER NOT NULL,
      respuestas_json TEXT NOT NULL,
      aciertos INTEGER NOT NULL,
      total_preguntas INTEGER NOT NULL,
      porcentaje DECIMAL(5,2) NOT NULL,
      intentos INTEGER DEFAULT 1,
      fecha_respuesta DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
      FOREIGN KEY (modulo_id) REFERENCES modulos(id),
      UNIQUE(usuario_id, modulo_id)
    )`,
    `CREATE TABLE IF NOT EXISTS progreso_usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      modulos_completados INTEGER DEFAULT 0,
      total_modulos INTEGER DEFAULT 11,
      calificacion_global DECIMAL(5,2) DEFAULT 0,
      porcentaje_progreso REAL DEFAULT 0,
      estado_certificacion TEXT DEFAULT 'En Progreso',
      fecha_inicio DATETIME DEFAULT CURRENT_TIMESTAMP,
      fecha_ultima_actividad DATETIME DEFAULT CURRENT_TIMESTAMP,
      fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
      UNIQUE(usuario_id)
    )`,
    `CREATE TABLE IF NOT EXISTS certificados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      codigo_verificacion TEXT UNIQUE NOT NULL,
      calificacion_final DECIMAL(5,2) NOT NULL,
      fecha_emision DATETIME DEFAULT CURRENT_TIMESTAMP,
      valido BOOLEAN DEFAULT 1,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )`,
    `CREATE TABLE IF NOT EXISTS auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER,
      accion TEXT NOT NULL,
      detalles TEXT,
      ip_address TEXT,
      user_agent TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )`
  ];
  try {
    tables.forEach(function(query, index) {
      db.exec(query);
      console.log('✅ Tabla ' + (index + 1) + '/6 lista');
    });
    console.log('✅ Todas las tablas listas');
    aplicarMigraciones();
    insertDefaultModules();
  } catch (error) {
    console.error('❌ Error inicializando BD:', error.message);
    process.exit(1);
  }
};

const insertDefaultModules = () => {
  const modulos = [
    { nombre: 'Introducción', orden: 1 },
    { nombre: 'Puntos de Encuentro', orden: 2 },
    { nombre: 'Talento Humano', orden: 3 },
    { nombre: 'Seguridad y Salud en el Trabajo', orden: 4 },
    { nombre: 'Dirección Administrativa y Financiera (DAF)', orden: 5 },
    { nombre: 'Sistemas y Tecnologías de la Información', orden: 6 },
    { nombre: 'Control Interno Disciplinario', orden: 7 },
    { nombre: 'Oficina de Planeación', orden: 8 },
    { nombre: 'Oficina de Control Interno', orden: 9 },
    { nombre: 'Relacionamiento con el Ciudadano', orden: 10 },
    { nombre: 'Recorrido por el Palacio', orden: 11 }
  ];
  try {
    const count = db.prepare('SELECT COUNT(*) as count FROM modulos').get();
    if (count.count === 0) {
      const stmt = db.prepare('INSERT INTO modulos (nombre, orden) VALUES (?, ?)');
      const insertMany = db.transaction(function() {
        modulos.forEach(function(m) { stmt.run(m.nombre, m.orden); });
      });
      insertMany();
      console.log('📚 11 módulos insertados');
    } else {
      console.log('📚 Módulos ya existentes: ' + count.count);
    }
  } catch (error) {
    console.error('❌ Error insertando módulos:', error.message);
  }
};

const auditAction = function(req, userId, action, details) {
  const ip = req.ip || 'unknown';
  const userAgent = req.get('User-Agent') || 'unknown';
  try {
    db.prepare('INSERT INTO auditoria (usuario_id, accion, detalles, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)').run(userId, action, details || null, ip, userAgent);
  } catch (error) {
    console.error('❌ Error en auditoría:', error.message);
  }
};

// ==================== LOGIN PRINCIPAL ====================

app.post('/api/login', function(req, res) {
  const email = req.body.email;
  const cedula = req.body.cedula;

  console.log('🔐 Intento de login:', email);

  if (!email || !cedula) {
    return res.status(400).json({ success: false, message: 'Email y cédula son requeridos' });
  }

  if (!email.toLowerCase().endsWith('@presidencia.gov.co')) {
    return res.status(400).json({ success: false, message: 'El email debe ser del dominio @presidencia.gov.co' });
  }

  if (!/^\d+$/.test(cedula)) {
    return res.status(400).json({ success: false, message: 'La cédula solo debe contener números' });
  }

  const emailLower = email.toLowerCase().trim();

  try {
    const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(emailLower);

    if (usuario) {
      if (usuario.cedula && usuario.cedula !== cedula) {
        return res.status(401).json({ success: false, message: 'Cédula incorrecta' });
      }
      db.prepare('UPDATE usuarios SET ultima_actividad = CURRENT_TIMESTAMP, cedula = COALESCE(cedula, ?) WHERE id = ?').run(cedula, usuario.id);
      auditAction(req, usuario.id, 'LOGIN', 'Sesión iniciada');
      console.log('✅ Login exitoso:', usuario.id);
      return res.json({
        success: true,
        message: 'Login exitoso',
        user: { id: usuario.id, nombre: usuario.nombre, email: emailLower, cedula: cedula }
      });
    } else {
      const nombreDefault = req.body.nombre || emailLower.split('@')[0].replace(/./g, ' ');
      const result = db.prepare('INSERT INTO usuarios (nombre, email, cedula) VALUES (?, ?, ?)').run(nombreDefault, emailLower, cedula);
      const userId = result.lastInsertRowid;
      db.prepare("INSERT INTO progreso_usuarios (usuario_id, modulos_completados, total_modulos, calificacion_global, porcentaje_progreso, estado_certificacion, fecha_actualizacion) VALUES (?, 0, 11, 0, 0, 'En Progreso', CURRENT_TIMESTAMP)").run(userId);
      auditAction(req, userId, 'REGISTRO', 'Nuevo usuario registrado');
      console.log('✅ Nuevo usuario creado:', userId);
      return res.status(201).json({
        success: true,
        message: 'Usuario registrado exitosamente',
        user: { id: userId, nombre: nombreDefault, email: emailLower, cedula: cedula }
      });
    }
  } catch (error) {
    console.error('❌ Error en login:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Alias
app.post('/api/auth/login', function(req, res) {
  const email = req.body.email;
  const nombre = req.body.nombre;
  if (!email) return res.status(400).json({ success: false, message: 'Email requerido' });
  req.body.cedula = req.body.cedula || '00000000';
  req.url = '/api/login';
  app.handle(req, res);
});

// ==================== MÓDULOS ====================

app.get('/api/modulos/progreso/:email', function(req, res) {
  const email = req.params.email;
  try {
    const usuario = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email.toLowerCase());
    if (!usuario) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    const respuestas = db.prepare('SELECT modulo_id, aciertos, total_preguntas, porcentaje, fecha_respuesta FROM respuestas_modulos WHERE usuario_id = ? ORDER BY modulo_id').all(usuario.id);
    const progreso = db.prepare('SELECT * FROM progreso_usuarios WHERE usuario_id = ?').get(usuario.id);
    res.json({ success: true, data: { respuestas: respuestas, progreso: progreso || {} } });
  } catch (error) {
    console.error('❌ Error obteniendo progreso:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/modulos/respuesta', function(req, res) {
  const usuarioEmail = req.body.usuarioEmail;
  const moduloId = req.body.moduloId;
  const respuestas = req.body.respuestas;
  const aciertos = req.body.aciertos;
  const totalPreguntas = req.body.totalPreguntas;
  const porcentaje = req.body.porcentaje;

  console.log('📝 Guardando respuesta:', { usuarioEmail, moduloId, aciertos, totalPreguntas });

  if (!usuarioEmail || !moduloId || aciertos === undefined || !totalPreguntas) {
    return res.status(400).json({ success: false, message: 'Datos incompletos' });
  }

  const pct = porcentaje !== undefined ? porcentaje : (aciertos / totalPreguntas) * 100;

  try {
    const usuario = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(usuarioEmail.toLowerCase());
    if (!usuario) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });

    const userId = usuario.id;
    db.prepare('INSERT OR REPLACE INTO respuestas_modulos (usuario_id, modulo_id, respuestas_json, aciertos, total_preguntas, porcentaje) VALUES (?, ?, ?, ?, ?, ?)').run(userId, moduloId, JSON.stringify(respuestas || []), aciertos, totalPreguntas, pct);
    console.log('✅ Respuesta guardada');
    updateUserProgress(userId);
    auditAction(req, userId, 'MODULO_COMPLETADO', 'Módulo ' + moduloId + ' - ' + aciertos + '/' + totalPreguntas + ' (' + pct.toFixed(1) + '%)');
    res.json({ success: true, message: 'Respuesta guardada exitosamente', data: { porcentaje: pct, aciertos: aciertos, totalPreguntas: totalPreguntas } });
  } catch (error) {
    console.error('❌ Error guardando respuesta:', error.message);
    return res.status(500).json({ success: false, message: 'Error guardando respuesta del módulo' });
  }
});

const updateUserProgress = function(userId) {
  try {
    const stats = db.prepare('SELECT COUNT(*) as modulos_completados, COALESCE(SUM(aciertos), 0) as total_aciertos, COALESCE(SUM(total_preguntas), 0) as total_preguntas FROM respuestas_modulos WHERE usuario_id = ?').get(userId);
    const calificacionGlobal = stats.total_preguntas > 0 ? (stats.total_aciertos / stats.total_preguntas) * 100 : 0;
    const porcentajeProgreso = (stats.modulos_completados / 11) * 100;
    let estadoCertificacion = 'En Progreso';
    if (stats.modulos_completados >= 11) {
      estadoCertificacion = calificacionGlobal >= 80 ? 'Aprobado' : 'Reprobado';
    }
    const existe = db.prepare('SELECT id FROM progreso_usuarios WHERE usuario_id = ?').get(userId);
    if (existe) {
      db.prepare('UPDATE progreso_usuarios SET modulos_completados = ?, calificacion_global = ?, porcentaje_progreso = ?, estado_certificacion = ?, fecha_ultima_actividad = CURRENT_TIMESTAMP, fecha_actualizacion = CURRENT_TIMESTAMP WHERE usuario_id = ?').run(stats.modulos_completados, calificacionGlobal, porcentajeProgreso, estadoCertificacion, userId);
    } else {
      db.prepare("INSERT INTO progreso_usuarios (usuario_id, modulos_completados, calificacion_global, porcentaje_progreso, estado_certificacion, fecha_actualizacion) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").run(userId, stats.modulos_completados, calificacionGlobal, porcentajeProgreso, estadoCertificacion);
    }
    console.log('✅ Progreso actualizado - Usuario ' + userId + ': ' + stats.modulos_completados + '/11, ' + calificacionGlobal.toFixed(1) + '%');
  } catch (error) {
    console.error('❌ Error actualizando progreso:', error.message);
  }
};

// ==================== CERTIFICADOS ====================

app.post('/api/certificados/generar', function(req, res) {
  const usuarioEmail = req.body.usuarioEmail;
  if (!usuarioEmail) return res.status(400).json({ success: false, message: 'Email requerido' });
  try {
    const usuario = db.prepare('SELECT u.id, u.nombre, u.email, p.calificacion_global, p.modulos_completados FROM usuarios u JOIN progreso_usuarios p ON u.id = p.usuario_id WHERE u.email = ?').get(usuarioEmail.toLowerCase());
    if (!usuario) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    if (usuario.calificacion_global < 80) return res.status(400).json({ success: false, message: 'Calificación insuficiente: ' + usuario.calificacion_global.toFixed(1) + '%. Requiere 80% mínimo.' });
    if (usuario.modulos_completados < 11) return res.status(400).json({ success: false, message: 'Módulos incompletos: ' + usuario.modulos_completados + '/11.' });
    const certExistente = db.prepare('SELECT codigo_verificacion, fecha_emision FROM certificados WHERE usuario_id = ? AND valido = 1').get(usuario.id);
    if (certExistente) return res.json({ success: true, message: 'Certificado ya emitido', data: { codigoVerificacion: certExistente.codigo_verificacion, usuario: { nombre: usuario.nombre, email: usuario.email }, calificacion: usuario.calificacion_global, fechaEmision: certExistente.fecha_emision } });
    const codigoVerificacion = 'PRCO-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    db.prepare('INSERT INTO certificados (usuario_id, codigo_verificacion, calificacion_final) VALUES (?, ?, ?)').run(usuario.id, codigoVerificacion, usuario.calificacion_global);
    auditAction(req, usuario.id, 'CERTIFICADO_GENERADO', 'Código: ' + codigoVerificacion);
    console.log('✅ Certificado generado:', codigoVerificacion);
    res.json({ success: true, message: 'Certificado generado', data: { codigoVerificacion: codigoVerificacion, usuario: { nombre: usuario.nombre, email: usuario.email }, calificacion: usuario.calificacion_global, fechaEmision: new Date().toISOString() } });
  } catch (error) {
    console.error('❌ Error generando certificado:', error.message);
    return res.status(500).json({ success: false, message: 'Error generando certificado' });
  }
});

app.get('/api/certificados/verificar/:codigo', function(req, res) {
  try {
    const certificado = db.prepare('SELECT c.*, u.nombre, u.email FROM certificados c JOIN usuarios u ON c.usuario_id = u.id WHERE c.codigo_verificacion = ? AND c.valido = 1').get(req.params.codigo.toUpperCase());
    if (!certificado) return res.status(404).json({ success: false, message: 'Certificado no encontrado o inválido' });
    res.json({ success: true, data: { valido: true, usuario: { nombre: certificado.nombre, email: certificado.email }, calificacion: certificado.calificacion_final, fechaEmision: certificado.fecha_emision, codigoVerificacion: certificado.codigo_verificacion } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== ADMIN ====================

app.get('/api/admin/estadisticas', function(req, res) {
  try {
    const resumen = db.prepare('SELECT COUNT(DISTINCT u.id) as total_usuarios, COUNT(DISTINCT CASE WHEN p.calificacion_global >= 80 THEN u.id END) as usuarios_aprobados, COUNT(DISTINCT c.usuario_id) as usuarios_certificados, ROUND(AVG(p.calificacion_global), 2) as promedio_calificacion FROM usuarios u LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id LEFT JOIN certificados c ON u.id = c.usuario_id AND c.valido = 1').get() || {};
    const modulos = db.prepare('SELECT m.nombre as modulo_nombre, m.orden, COUNT(rm.id) as total_respuestas, ROUND(AVG(rm.porcentaje), 2) as promedio_calificacion FROM modulos m LEFT JOIN respuestas_modulos rm ON m.id = rm.modulo_id GROUP BY m.id ORDER BY m.orden').all() || [];
    const actividad_reciente = db.prepare("SELECT DATE(u.fecha_registro) as fecha, COUNT(*) as nuevos_usuarios FROM usuarios u WHERE u.fecha_registro >= date('now', '-30 days') GROUP BY DATE(u.fecha_registro) ORDER BY fecha DESC LIMIT 30").all() || [];
    res.json({ success: true, data: { resumen, modulos, actividad_reciente } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/usuarios', function(req, res) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const search = req.query.search || '';
  const estado = req.query.estado || '';
  const offset = (page - 1) * limit;
  try {
    let whereClause = '1=1';
    let params = [];
    if (search) { whereClause += ' AND (u.nombre LIKE ? OR u.email LIKE ?)'; params.push('%' + search + '%', '%' + search + '%'); }
    if (estado) { whereClause += ' AND p.estado_certificacion = ?'; params.push(estado); }
    const usuarios = db.prepare('SELECT u.id, u.nombre, u.email, u.fecha_registro, u.ultima_actividad, COALESCE(p.modulos_completados, 0) as modulos_completados, COALESCE(p.total_modulos, 11) as total_modulos, COALESCE(p.calificacion_global, 0) as calificacion_global, COALESCE(p.estado_certificacion, "Sin Progreso") as estado_certificacion, COALESCE(p.porcentaje_progreso, 0) as porcentaje_progreso, c.codigo_verificacion, c.fecha_emision as fecha_certificado FROM usuarios u LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id LEFT JOIN certificados c ON u.id = c.usuario_id AND c.valido = 1 WHERE ' + whereClause + ' ORDER BY u.fecha_registro DESC LIMIT ? OFFSET ?').all(...params, limit, offset);
    const total = db.prepare('SELECT COUNT(*) as total FROM usuarios u LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id WHERE ' + whereClause).get(...params).total || 0;
    res.json({ success: true, data: { usuarios, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});
app.get('/api/migrar', function(req, res) {
  try {
    db.exec('ALTER TABLE progreso_usuarios ADD COLUMN fecha_actualizacion DATETIME');
    res.json({ success: true, message: 'Migración aplicada' });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});
// ==================== DEBUG ====================

app.get('/api/debug', function(req, res) {
  try {
    const tablas = ['usuarios', 'modulos', 'respuestas_modulos', 'progreso_usuarios', 'certificados', 'auditoria'];
    const info = {};
    tablas.forEach(function(tabla) {
      try {
        const columns = db.prepare('PRAGMA table_info(' + tabla + ')').all();
        const count = db.prepare('SELECT COUNT(*) as total FROM ' + tabla).get();
        info[tabla] = { columnas: columns.map(function(c) { return c.name + ' (' + c.type + ')'; }), total_registros: count.total };
      } catch (e) { info[tabla] = { error: e.message }; }
    });
    res.json({ success: true, dbPath: dbPath, nodeEnv: process.env.NODE_ENV, tablas: info, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ESTÁTICAS ====================

app.get('/', function(req, res) { res.sendFile(path.join(__dirname, '../frontend/index.html')); });
app.get('/admin', function(req, res) { res.sendFile(path.join(__dirname, '../admin/dashboard.html')); });
app.get('/api/test', function(req, res) { res.json({ success: true, message: 'API funcionando correctamente', timestamp: new Date().toISOString(), environment: process.env.NODE_ENV || 'development', dbPath: dbPath }); });

app.use(function(err, req, res, next) {
  console.error('❌ Error no manejado:', err);
  res.status(500).json({ success: false, message: error.message });
});

app.use('*', function(req, res) { res.status(404).json({ success: false, message: 'Endpoint no encontrado' }); });

// ==================== ARRANQUE ====================

initializeDatabase();

app.listen(PORT, HOST, function() {
  console.log('🚀 Servidor corriendo en ' + HOST + ':' + PORT);
  console.log('🗄️  BD: ' + dbPath);
  console.log('🔧 Ambiente: ' + (process.env.NODE_ENV || 'development'));
});

process.on('SIGINT', function() { try { db.close(); } catch(e) {} process.exit(0); });
process.on('SIGTERM', function() { try { db.close(); } catch(e) {} process.exit(0); });
process.on('uncaughtException', function(err) { console.error('❌ Error no capturado:', err.message); process.exit(1); });
process.on('unhandledRejection', function(reason) { console.error('❌ Promesa rechazada:', reason); process.exit(1); });

module.exports = app;
