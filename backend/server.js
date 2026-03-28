const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ==================== MIDDLEWARE ====================

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));

// ==================== BASE DE DATOS ====================

const dbPath = process.env.DB_PATH || './database.db';
let db;

try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  console.log(`✅ Conectado a SQLite: ${dbPath}`);
} catch (error) {
  console.error('❌ Error conectando a la base de datos:', error.message);
  process.exit(1);
}

// ==================== MIGRACIONES AUTOMÁTICAS ====================

const MIGRACIONES = [
  {
    tabla: 'progreso_usuarios',
    columna: 'porcentaje_progreso',
    sql: 'ALTER TABLE progreso_usuarios ADD COLUMN porcentaje_progreso REAL DEFAULT 0'
  },
  {
    tabla: 'progreso_usuarios',
    columna: 'fecha_actualizacion',
    sql: 'ALTER TABLE progreso_usuarios ADD COLUMN fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP'
  },
  {
    tabla: 'usuarios',
    columna: 'cedula',
    sql: 'ALTER TABLE usuarios ADD COLUMN cedula TEXT'
  },
  {
    tabla: 'usuarios',
    columna: 'password_hash',
    sql: 'ALTER TABLE usuarios ADD COLUMN password_hash TEXT'
  },
  {
    tabla: 'respuestas_modulos',
    columna: 'intentos',
    sql: 'ALTER TABLE respuestas_modulos ADD COLUMN intentos INTEGER DEFAULT 1'
  }
];

const aplicarMigraciones = () => {
  console.log('🔄 Aplicando migraciones automáticas...');
  let migradas = 0;

  MIGRACIONES.forEach(({ tabla, columna, sql }) => {
    try {
      // Verificar si la columna ya existe
      const info = db.prepare(`PRAGMA table_info(${tabla})`).all();
      const existe = info.some(col => col.name === columna);

      if (!existe) {
        db.exec(sql);
        console.log(`✅ Migración aplicada: ${tabla}.${columna}`);
        migradas++;
      }
    } catch (error) {
      // Si la tabla no existe aún, la migración se aplicará después de crearla
      if (!error.message.includes('no such table')) {
        console.error(`⚠️  Error en migración ${tabla}.${columna}:`, error.message);
      }
    }
  });

  if (migradas === 0) {
    console.log('✅ Base de datos al día, no se requieren migraciones');
  } else {
    console.log(`✅ ${migradas} migración(es) aplicada(s) exitosamente`);
  }
};

// ==================== INICIALIZACIÓN DE TABLAS ====================

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
    tables.forEach((query, index) => {
      db.exec(query);
      console.log(`✅ Tabla ${index + 1}/6 creada/verificada`);
    });

    console.log('✅ Todas las tablas listas');

    // Aplicar migraciones DESPUÉS de crear tablas
    aplicarMigraciones();

    insertDefaultModules();
  } catch (error) {
    console.error('❌ Error inicializando BD:', error.message);
    process.exit(1);
  }
};

// ==================== MÓDULOS PREDEFINIDOS ====================

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
      const insertMany = db.transaction(() => {
        modulos.forEach(m => stmt.run(m.nombre, m.orden));
      });
      insertMany();
      console.log('📚 11 módulos predefinidos insertados');
    } else {
      console.log(`📚 Módulos ya existentes: ${count.count}`);
    }
  } catch (error) {
    console.error('❌ Error insertando módulos:', error.message);
  }
};

// ==================== AUDITORÍA ====================

const auditAction = (req, userId, action, details = null) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const userAgent = req.get('User-Agent') || 'unknown';

  try {
    db.prepare(
      'INSERT INTO auditoria (usuario_id, accion, detalles, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, action, details, ip, userAgent);
  } catch (error) {
    console.error('❌ Error en auditoría:', error.message);
  }
};

// ==================== AUTENTICACIÓN ====================

app.post('/api/auth/login', (req, res) => {
  const { nombre, email } = req.body;

  console.log('🔐 Intento de login:', { nombre, email });

  if (!nombre || !email) {
    return res.status(400).json({
      success: false,
      message: 'Nombre y email son requeridos'
    });
  }

  if (!email.toLowerCase().endsWith('@presidencia.gov.co')) {
    return res.status(400).json({
      success: false,
      message: 'El email debe ser del dominio @presidencia.gov.co'
    });
  }

  const emailLower = email.toLowerCase().trim();

  try {
    const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(emailLower);

    if (usuario) {
      db.prepare(
        'UPDATE usuarios SET ultima_actividad = CURRENT_TIMESTAMP, nombre = ? WHERE id = ?'
      ).run(nombre, usuario.id);

      auditAction(req, usuario.id, 'LOGIN', 'Sesión iniciada');

      console.log('✅ Login exitoso - usuario existente:', usuario.id);

      return res.json({
        success: true,
        message: 'Login exitoso',
        data: {
          usuario: { id: usuario.id, nombre: nombre, email: emailLower }
        }
      });
    } else {
      const result = db.prepare(
        'INSERT INTO usuarios (nombre, email) VALUES (?, ?)'
      ).run(nombre, emailLower);

      const userId = result.lastInsertRowid;

      // Crear progreso inicial con todas las columnas
      db.prepare(`
        INSERT INTO progreso_usuarios 
          (usuario_id, modulos_completados, total_modulos, calificacion_global, 
           porcentaje_progreso, estado_certificacion, fecha_actualizacion)
        VALUES (?, 0, 11, 0, 0, 'En Progreso', CURRENT_TIMESTAMP)
      `).run(userId);

      auditAction(req, userId, 'REGISTRO', 'Nuevo usuario registrado');

      console.log('✅ Nuevo usuario creado:', userId);

      return res.status(201).json({
        success: true,
        message: 'Usuario registrado exitosamente',
        data: {
          usuario: { id: userId, nombre: nombre, email: emailLower }
        }
      });
    }
  } catch (error) {
    console.error('❌ Error en login:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// ==================== MÓDULOS ====================

app.get('/api/modulos/progreso/:email', (req, res) => {
  const { email } = req.params;

  console.log('📊 Solicitando progreso:', email);

  try {
    const usuario = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email.toLowerCase());

    if (!usuario) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    const respuestas = db.prepare(`
      SELECT modulo_id, aciertos, total_preguntas, porcentaje, fecha_respuesta
      FROM respuestas_modulos
      WHERE usuario_id = ?
      ORDER BY modulo_id
    `).all(usuario.id);

    const progreso = db.prepare('SELECT * FROM progreso_usuarios WHERE usuario_id = ?').get(usuario.id);

    res.json({
      success: true,
      data: {
        respuestas: respuestas,
        progreso: progreso || {}
      }
    });
  } catch (error) {
    console.error('❌ Error obteniendo progreso:', error.message);
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

app.post('/api/modulos/respuesta', (req, res) => {
  const { usuarioEmail, moduloId, respuestas, aciertos, totalPreguntas, porcentaje } = req.body;

  console.log('📝 Guardando respuesta:', { usuarioEmail, moduloId, aciertos, totalPreguntas });

  if (!usuarioEmail || !moduloId || aciertos === undefined || !totalPreguntas) {
    return res.status(400).json({
      success: false,
      message: 'Datos incompletos: se requiere usuarioEmail, moduloId, aciertos, totalPreguntas'
    });
  }

  const pct = porcentaje !== undefined ? porcentaje : (aciertos / totalPreguntas) * 100;

  try {
    const usuario = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(usuarioEmail.toLowerCase());

    if (!usuario) {
      console.error('❌ Usuario no encontrado:', usuarioEmail);
      return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    const userId = usuario.id;

    // INSERT OR REPLACE para manejar duplicados
    db.prepare(`
      INSERT OR REPLACE INTO respuestas_modulos 
        (usuario_id, modulo_id, respuestas_json, aciertos, total_preguntas, porcentaje)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, moduloId, JSON.stringify(respuestas || []), aciertos, totalPreguntas, pct);

    console.log('✅ Respuesta guardada exitosamente');

    updateUserProgress(userId);

    auditAction(req, userId, 'MODULO_COMPLETADO',
      `Módulo ${moduloId} - ${aciertos}/${totalPreguntas} aciertos (${pct.toFixed(1)}%)`);

    res.json({
      success: true,
      message: 'Respuesta guardada exitosamente',
      data: { porcentaje: pct, aciertos, totalPreguntas }
    });
  } catch (error) {
    console.error('❌ Error guardando respuesta:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error guardando respuesta del módulo',
      detail: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==================== ACTUALIZACIÓN DE PROGRESO ====================

const updateUserProgress = (userId) => {
  try {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as modulos_completados,
        COALESCE(SUM(aciertos), 0) as total_aciertos,
        COALESCE(SUM(total_preguntas), 0) as total_preguntas
      FROM respuestas_modulos
      WHERE usuario_id = ?
    `).get(userId);

    const calificacionGlobal = stats.total_preguntas > 0
      ? (stats.total_aciertos / stats.total_preguntas) * 100
      : 0;

    const porcentajeProgreso = (stats.modulos_completados / 11) * 100;

    let estadoCertificacion = 'En Progreso';
    if (stats.modulos_completados >= 11) {
      estadoCertificacion = calificacionGlobal >= 80 ? 'Aprobado' : 'Reprobado';
    }

    // Verificar si existe el registro de progreso
    const existe = db.prepare('SELECT id FROM progreso_usuarios WHERE usuario_id = ?').get(userId);

    if (existe) {
      // UPDATE con ON CONFLICT para robustez
      db.prepare(`
        UPDATE progreso_usuarios SET
          modulos_completados = ?,
          calificacion_global = ?,
          porcentaje_progreso = ?,
          estado_certificacion = ?,
          fecha_ultima_actividad = CURRENT_TIMESTAMP,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE usuario_id = ?
      `).run(stats.modulos_completados, calificacionGlobal, porcentajeProgreso, estadoCertificacion, userId);
    } else {
      // Crear si no existe (fallback)
      db.prepare(`
        INSERT INTO progreso_usuarios 
          (usuario_id, modulos_completados, calificacion_global, porcentaje_progreso,
           estado_certificacion, fecha_actualizacion)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(userId, stats.modulos_completados, calificacionGlobal, porcentajeProgreso, estadoCertificacion);
    }

    console.log(`✅ Progreso actualizado - Usuario ${userId}: ${stats.modulos_completados}/11 módulos, ${calificacionGlobal.toFixed(1)}%`);
  } catch (error) {
    console.error('❌ Error actualizando progreso:', error.message);
  }
};

// ==================== CERTIFICADOS ====================

app.post('/api/certificados/generar', (req, res) => {
  const { usuarioEmail } = req.body;

  console.log('🏆 Solicitud de certificado:', usuarioEmail);

  if (!usuarioEmail) {
    return res.status(400).json({ success: false, message: 'Email de usuario requerido' });
  }

  try {
    const usuario = db.prepare(`
      SELECT u.id, u.nombre, u.email, p.calificacion_global, p.estado_certificacion, p.modulos_completados
      FROM usuarios u
      JOIN progreso_usuarios p ON u.id = p.usuario_id
      WHERE u.email = ?
    `).get(usuarioEmail.toLowerCase());

    if (!usuario) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    if (usuario.calificacion_global < 80) {
      return res.status(400).json({
        success: false,
        message: `Calificación insuficiente: ${usuario.calificacion_global.toFixed(1)}%. Requiere 80% mínimo.`
      });
    }

    if (usuario.modulos_completados < 11) {
      return res.status(400).json({
        success: false,
        message: `Módulos incompletos: ${usuario.modulos_completados}/11.`
      });
    }

    // Verificar certificado existente
    const certExistente = db.prepare(
      'SELECT codigo_verificacion, fecha_emision FROM certificados WHERE usuario_id = ? AND valido = 1'
    ).get(usuario.id);

    if (certExistente) {
      return res.json({
        success: true,
        message: 'Certificado ya emitido previamente',
        data: {
          codigoVerificacion: certExistente.codigo_verificacion,
          usuario: { nombre: usuario.nombre, email: usuario.email },
          calificacion: usuario.calificacion_global,
          fechaEmision: certExistente.fecha_emision
        }
      });
    }

    const codigoVerificacion = `PRCO-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    db.prepare(
      'INSERT INTO certificados (usuario_id, codigo_verificacion, calificacion_final) VALUES (?, ?, ?)'
    ).run(usuario.id, codigoVerificacion, usuario.calificacion_global);

    auditAction(req, usuario.id, 'CERTIFICADO_GENERADO',
      `Código: ${codigoVerificacion} - ${usuario.calificacion_global.toFixed(1)}%`);

    console.log('✅ Certificado generado:', codigoVerificacion);

    res.json({
      success: true,
      message: 'Certificado generado exitosamente',
      data: {
        codigoVerificacion,
        usuario: { nombre: usuario.nombre, email: usuario.email },
        calificacion: usuario.calificacion_global,
        fechaEmision: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Error generando certificado:', error.message);
    return res.status(500).json({ success: false, message: 'Error generando certificado' });
  }
});

app.get('/api/certificados/verificar/:codigo', (req, res) => {
  const { codigo } = req.params;

  try {
    const certificado = db.prepare(`
      SELECT c.*, u.nombre, u.email
      FROM certificados c
      JOIN usuarios u ON c.usuario_id = u.id
      WHERE c.codigo_verificacion = ? AND c.valido = 1
    `).get(codigo.toUpperCase());

    if (!certificado) {
      return res.status(404).json({ success: false, message: 'Certificado no encontrado o inválido' });
    }

    res.json({
      success: true,
      message: 'Certificado válido',
      data: {
        valido: true,
        usuario: { nombre: certificado.nombre, email: certificado.email },
        calificacion: certificado.calificacion_final,
        fechaEmision: certificado.fecha_emision,
        codigoVerificacion: certificado.codigo_verificacion
      }
    });
  } catch (error) {
    console.error('❌ Error verificando certificado:', error.message);
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// ==================== PANEL ADMINISTRATIVO ====================

app.get('/api/admin/estadisticas', (req, res) => {
  console.log('📊 Solicitando estadísticas administrativas');

  try {
    const estadisticas = {};

    estadisticas.resumen = db.prepare(`
      SELECT 
        COUNT(DISTINCT u.id) as total_usuarios,
        COUNT(DISTINCT CASE WHEN p.calificacion_global >= 80 THEN u.id END) as usuarios_aprobados,
        COUNT(DISTINCT c.usuario_id) as usuarios_certificados,
        ROUND(AVG(p.calificacion_global), 2) as promedio_calificacion
      FROM usuarios u
      LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id
      LEFT JOIN certificados c ON u.id = c.usuario_id AND c.valido = 1
    `).get() || {};

    estadisticas.modulos = db.prepare(`
      SELECT 
        m.nombre as modulo_nombre,
        m.orden,
        COUNT(rm.id) as total_respuestas,
        ROUND(AVG(rm.porcentaje), 2) as promedio_calificacion
      FROM modulos m
      LEFT JOIN respuestas_modulos rm ON m.id = rm.modulo_id
      GROUP BY m.id, m.nombre, m.orden
      ORDER BY m.orden
    `).all() || [];

    estadisticas.actividad_reciente = db.prepare(`
      SELECT 
        DATE(u.fecha_registro) as fecha,
        COUNT(*) as nuevos_usuarios
      FROM usuarios u
      WHERE u.fecha_registro >= date('now', '-30 days')
      GROUP BY DATE(u.fecha_registro)
      ORDER BY fecha DESC
      LIMIT 30
    `).all() || [];

    res.json({ success: true, data: estadisticas });
  } catch (error) {
    console.error('❌ Error calculando estadísticas:', error.message);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

app.get('/api/admin/usuarios', (req, res) => {
  const { page = 1, limit = 50, search = '', estado = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let whereClause = '1=1';
    let params = [];

    if (search) {
      whereClause += ' AND (u.nombre LIKE ? OR u.email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (estado) {
      whereClause += ' AND p.estado_certificacion = ?';
      params.push(estado);
    }

    const usuarios = db.prepare(`
      SELECT 
        u.id, u.nombre, u.email, u.fecha_registro, u.ultima_actividad,
        COALESCE(p.modulos_completados, 0) as modulos_completados,
        COALESCE(p.total_modulos, 11) as total_modulos,
        COALESCE(p.calificacion_global, 0) as calificacion_global,
        COALESCE(p.estado_certificacion, 'Sin Progreso') as estado_certificacion,
        COALESCE(p.porcentaje_progreso, 0) as porcentaje_progreso,
        c.codigo_verificacion,
        c.fecha_emision as fecha_certificado
      FROM usuarios u
      LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id
      LEFT JOIN certificados c ON u.id = c.usuario_id AND c.valido = 1
      WHERE ${whereClause}
      ORDER BY u.fecha_registro DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const total = db.prepare(`
      SELECT COUNT(*) as total
      FROM usuarios u
      LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id
      WHERE ${whereClause}
    `).get(...params)?.total || 0;

    res.json({
      success: true,
      data: {
        usuarios,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('❌ Error obteniendo usuarios:', error.message);
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// ==================== DEBUG (TEMPORAL - ELIMINAR EN PRODUCCIÓN FINAL) ====================

app.get('/api/debug', (req, res) => {
  try {
    const tablas = ['usuarios', 'modulos', 'respuestas_modulos', 'progreso_usuarios', 'certificados', 'auditoria'];
    const info = {};

    tablas.forEach(tabla => {
      try {
        const columns = db.prepare(`PRAGMA table_info(${tabla})`).all();
        const count = db.prepare(`SELECT COUNT(*) as total FROM ${tabla}`).get();
        info[tabla] = {
          columnas: columns.map(c => `${c.name} (${c.type})`),
          total_registros: count.total
        };
      } catch (e) {
        info[tabla] = { error: e.message };
      }
    });

    res.json({
      success: true,
      dbPath,
      nodeEnv: process.env.NODE_ENV,
      tablas: info,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== RUTAS ESTÁTICAS ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../admin/dashboard.html'));
});

app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'API funcionando correctamente',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    dbPath
  });
});

// ==================== MANEJO DE ERRORES ====================

app.use((err, req, res, next) => {
  console.error('❌ Error no manejado:', err);
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint no encontrado' });
});

// ==================== ARRANQUE ====================

initializeDatabase();

app.listen(PORT, HOST, () => {
  console.log(`
🚀 ========================================
   PLATAFORMA DE INDUCCIÓN - PRESIDENCIA
========================================
🌐 Servidor: http://${HOST}:${PORT}
🎯 Frontend: http://localhost:${PORT}
⚙️  Admin:    http://localhost:${PORT}/admin
🔍 Debug:    http://localhost:${PORT}/api/debug
🗄️  BD:       ${dbPath}
📅 Inicio:   ${new Date().toLocaleString('es-CO')}
🔧 Ambiente: ${process.env.NODE_ENV || 'development'}
========================================
  `);
});

// ==================== CIERRE GRACEFUL ====================

process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando servidor...');
  try { db.close(); console.log('✅ BD cerrada'); } catch (e) { /* ignorar */ }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM recibido. Cerrando servidor...');
  try { db.close(); } catch (e) { /* ignorar */ }
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada:', reason);
  process.exit(1);
});

module.exports = app;
