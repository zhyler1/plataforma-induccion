// ==========================================
// PLATAFORMA DE INDUCCIÓN - PRESIDENCIA
// Server.js con Auto-Registro y Seguridad
// ==========================================

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const winston = require('winston');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 12;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('❌ ERROR: JWT_SECRET debe tener al menos 32 caracteres');
  process.exit(1);
}

// ==========================================
// LOGGER
// ==========================================
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.File({ filename: 'security.log', level: 'warn' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

// ==========================================
// MIDDLEWARE DE SEGURIDAD
// ==========================================

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "https://media.presidencia.gov.co", "data:"],
      mediaSrc: ["'self'", "https://media.presidencia.gov.co"],
      connectSrc: ["'self'"],
      formAction: ["'self'"]  // ← AGREGAR ESTA LÍNEA
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || true,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  logger.info({
    method: req.method,
    path: req.path,
    ip: req.ip
  });
  next();
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Demasiadas peticiones.' }
});

app.use('/api/', generalLimiter);

const loginLimiter = rateLimit({
  windowMs: parseInt(process.env.LOGIN_RATE_WINDOW) || 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT) || 5,
  message: { success: false, message: 'Demasiados intentos. Intente en 15 minutos.' },
  skipSuccessfulRequests: true
});

// ==========================================
// BASE DE DATOS
// ==========================================
const dbPath = process.env.DB_PATH || './database_v2.db';
let db;

try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  logger.info('✅ Base de datos conectada');
} catch (error) {
  logger.error('❌ Error con base de datos:', error);
  process.exit(1);
}

// Inicializar tablas
function initializeDatabase() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cedula TEXT NOT NULL UNIQUE,
        cedula_hash TEXT NOT NULL,
        nombre TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        rol TEXT DEFAULT 'usuario',
        fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP,
        ultima_actividad DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS modulos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        orden INTEGER NOT NULL UNIQUE,
        activo INTEGER DEFAULT 1
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS respuestas_modulos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER NOT NULL,
        modulo_id INTEGER NOT NULL,
        respuestas_json TEXT NOT NULL,
        aciertos INTEGER NOT NULL,
        total_preguntas INTEGER NOT NULL,
        porcentaje REAL NOT NULL,
        fecha_respuesta DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
        FOREIGN KEY (modulo_id) REFERENCES modulos(id) ON DELETE CASCADE,
        UNIQUE(usuario_id, modulo_id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS progreso_usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER NOT NULL UNIQUE,
        modulos_completados INTEGER DEFAULT 0,
        calificacion_global REAL DEFAULT 0,
        porcentaje_progreso REAL DEFAULT 0,
        estado_certificacion TEXT DEFAULT 'En Progreso',
        fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS certificados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER NOT NULL UNIQUE,
        codigo_verificacion TEXT UNIQUE NOT NULL,
        calificacion_final REAL NOT NULL,
        fecha_emision DATETIME DEFAULT CURRENT_TIMESTAMP,
        valido INTEGER DEFAULT 1,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        accion TEXT NOT NULL,
        detalles TEXT,
        ip TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
      )
    `);

    const modulosCount = db.prepare('SELECT COUNT(*) as count FROM modulos').get();
    if (modulosCount.count === 0) {
      const modulos = [
        'Introducción', 'Puntos de Encuentro', 'Talento Humano', 
        'Seguridad y Salud en el Trabajo', 'Dirección Administrativa y Financiera',
        'Sistemas y Tecnologías de la Información', 'Control Interno Disciplinario',
        'Oficina de Planeación', 'Oficina de Control Interno',
        'Relacionamiento con el Ciudadano', 'Recorrido por el Palacio'
      ];
      
      const insert = db.prepare('INSERT INTO modulos (nombre, orden) VALUES (?, ?)');
      modulos.forEach((nombre, index) => {
        insert.run(nombre, index + 1);
      });
      
      logger.info('✅ Módulos inicializados');
    }

    // === MIGRACIONES AUTOMÁTICAS ===
    const migraciones = [
      {
        tabla: 'progreso_usuarios',
        columna: 'porcentaje_progreso',
        sql: 'ALTER TABLE progreso_usuarios ADD COLUMN porcentaje_progreso REAL DEFAULT 0'
      }
    ];

    for (const m of migraciones) {
      try {
        const cols = db.pragma(`table_info(${m.tabla})`);
        const existe = cols.some(c => c.name === m.columna);
        if (!existe) {
          db.exec(m.sql);
          logger.info(`✅ Migración aplicada: ${m.tabla}.${m.columna}`);
        }
      } catch (migError) {
        logger.warn(`⚠️ Migración ${m.tabla}.${m.columna}: ${migError.message}`);
      }
    }

    logger.info('✅ Base de datos inicializada');
  } catch (error) {
    logger.error('❌ Error inicializando BD:', error);
    throw error;
  }
}

initializeDatabase();

// ==========================================
// FUNCIONES DE SEGURIDAD
// ==========================================

const failedAttempts = new Map();

function registrarIntentoFallido(identifier, ip) {
  const key = `${identifier}_${ip}`;
  const attempts = failedAttempts.get(key) || { count: 0, firstAttempt: Date.now() };
  
  attempts.count++;
  attempts.lastAttempt = Date.now();
  
  if (!attempts.firstAttempt) {
    attempts.firstAttempt = Date.now();
  }
  
  failedAttempts.set(key, attempts);
  
  logger.warn({
    type: 'failed_login',
    identifier,
    ip,
    attempts: attempts.count
  });
  
  setTimeout(() => {
    const current = failedAttempts.get(key);
    if (current && Date.now() - current.lastAttempt > 3600000) {
      failedAttempts.delete(key);
    }
  }, 3600000);
}

function cuentaBloqueada(identifier, ip) {
  const key = `${identifier}_${ip}`;
  const attempts = failedAttempts.get(key);
  
  if (!attempts) return false;
  
  if (attempts.count >= 5 && Date.now() - attempts.firstAttempt < 900000) {
    return true;
  }
  
  return false;
}

function limpiarIntentosFallidos(identifier, ip) {
  const key = `${identifier}_${ip}`;
  failedAttempts.delete(key);
}

function verificarToken(req, res, next) {
  const token = req.cookies.auth_token || req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'No autenticado' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.usuario = decoded;
    
    db.prepare('UPDATE usuarios SET ultima_actividad = CURRENT_TIMESTAMP WHERE id = ?')
      .run(decoded.id);
    
    next();
  } catch (error) {
    logger.warn({ type: 'invalid_token', ip: req.ip });
    return res.status(401).json({ success: false, message: 'Token inválido' });
  }
}

function verificarAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') {
    logger.warn({ type: 'unauthorized_admin', usuario: req.usuario.email, ip: req.ip });
    return res.status(403).json({ success: false, message: 'Acceso denegado' });
  }
  next();
}

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN
// ==========================================

// AUTO-REGISTRO
app.post('/api/registro',
  loginLimiter,
  body('email').isEmail().normalizeEmail(),
  body('nombre').trim().escape().isLength({ min: 3, max: 100 }),
  body('cedula').trim().isLength({ min: 6, max: 20 }).matches(/^[0-9]+$/),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Datos inválidos' });
    }

    const { email, nombre, cedula } = req.body;
    const nombreCompleto = nombre.toUpperCase();

    try {
      if (!email.endsWith('@presidencia.gov.co')) {
        return res.status(400).json({ 
          success: false, 
          message: 'Solo correos @presidencia.gov.co' 
        });
      }

      const existe = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
      if (existe) {
        return res.status(400).json({ 
          success: false, 
          message: 'Correo ya registrado. Usa login.' 
        });
      }

      const cedulaHash = await bcrypt.hash(cedula, 12);

      const result = db.prepare(`
        INSERT INTO usuarios (cedula, nombre, email, cedula_hash) 
        VALUES (?, ?, ?, ?)
      `).run(cedula, nombreCompleto, email, cedulaHash);

      const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(result.lastInsertRowid);

      db.prepare('INSERT INTO progreso_usuarios (usuario_id) VALUES (?)').run(usuario.id);

      const token = jwt.sign(
        { id: usuario.id, email: usuario.email, nombre: usuario.nombre, rol: 'usuario' },
        JWT_SECRET,
        { expiresIn: '8h' }
      );

      res.cookie('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 8 * 60 * 60 * 1000
      });

      db.prepare('INSERT INTO auditoria (usuario_id, accion, ip) VALUES (?, ?, ?)')
        .run(usuario.id, 'registro_exitoso', req.ip);

      logger.info({ type: 'registro_exitoso', usuario: usuario.email, ip: req.ip });

      res.json({
        success: true,
        message: 'Registro exitoso',
        user: { id: usuario.id, nombre: usuario.nombre, email: usuario.email },
        token
      });

    } catch (error) {
      logger.error('Error en registro:', error);
      res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
  }
);

// LOGIN
app.post('/api/login',
  loginLimiter,
  body('email').isEmail().normalizeEmail(),
  body('cedula').trim().matches(/^[0-9]+$/),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Datos inválidos' });
    }

    const { email, cedula } = req.body;

    try {
      if (cuentaBloqueada(email, req.ip)) {
        return res.status(429).json({ 
          success: false, 
          message: 'Cuenta bloqueada temporalmente' 
        });
      }

      const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);

      if (!usuario || !usuario.cedula_hash) {
        registrarIntentoFallido(email, req.ip);
        return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
      }

      const validCedula = await bcrypt.compare(cedula, usuario.cedula_hash);

      if (!validCedula) {
        registrarIntentoFallido(email, req.ip);
        return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
      }

      limpiarIntentosFallidos(email, req.ip);

      db.prepare('UPDATE usuarios SET ultima_actividad = CURRENT_TIMESTAMP WHERE id = ?')
        .run(usuario.id);

      const token = jwt.sign(
        { id: usuario.id, email: usuario.email, nombre: usuario.nombre, rol: usuario.rol || 'usuario' },
        JWT_SECRET,
        { expiresIn: '8h' }
      );

      res.cookie('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 8 * 60 * 60 * 1000
      });

      db.prepare('INSERT INTO auditoria (usuario_id, accion, ip) VALUES (?, ?, ?)')
        .run(usuario.id, 'login_exitoso', req.ip);

      logger.info({ type: 'login_exitoso', usuario: usuario.email, ip: req.ip });

      res.json({
        success: true,
        user: { id: usuario.id, nombre: usuario.nombre, email: usuario.email },
        token
      });

    } catch (error) {
      logger.error('Error en login:', error);
      res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
  }
);

app.post('/api/logout', verificarToken, (req, res) => {
  res.clearCookie('auth_token');
  db.prepare('INSERT INTO auditoria (usuario_id, accion, ip) VALUES (?, ?, ?)')
    .run(req.usuario.id, 'logout', req.ip);
  res.json({ success: true });
});

// ==========================================
// ENDPOINTS DE MÓDULOS
// ==========================================

app.get('/api/modulos', verificarToken, (req, res) => {
  try {
    const modulos = db.prepare('SELECT * FROM modulos WHERE activo = 1 ORDER BY orden').all();
    res.json({ success: true, data: modulos });
  } catch (error) {
    logger.error('Error obteniendo módulos:', error);
    res.status(500).json({ success: false });
  }
});

app.post('/api/modulos/respuesta',
  verificarToken,
  body('moduloId').isInt(),
  body('respuestas').isArray(),
  body('aciertos').isInt(),
  body('totalPreguntas').isInt(),
  body('porcentaje').isNumeric(),
  async (req, res) => {
    const { moduloId, respuestas, aciertos, totalPreguntas, porcentaje } = req.body;

    try {
      // INSERT OR REPLACE por si el usuario repite el módulo
      db.prepare(`
        INSERT OR REPLACE INTO respuestas_modulos 
        (usuario_id, modulo_id, respuestas_json, aciertos, total_preguntas, porcentaje) 
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(req.usuario.id, moduloId, JSON.stringify(respuestas), aciertos, totalPreguntas, porcentaje);

      const modulosCompletados = db.prepare(`
        SELECT COUNT(DISTINCT modulo_id) as count 
        FROM respuestas_modulos 
        WHERE usuario_id = ?
      `).get(req.usuario.id).count;

      const calificacionGlobal = db.prepare(`
        SELECT AVG(porcentaje) as promedio 
        FROM respuestas_modulos 
        WHERE usuario_id = ?
      `).get(req.usuario.id).promedio || 0;

      const porcentajeProgreso = (modulosCompletados / 11) * 100;
      const estadoCertificacion = modulosCompletados === 11 
        ? (calificacionGlobal >= 80 ? 'Aprobado' : 'Reprobado')
        : 'En Progreso';

      // Upsert: crea el registro si no existe, actualiza si sí existe
      db.prepare(`
        INSERT INTO progreso_usuarios 
          (usuario_id, modulos_completados, calificacion_global, porcentaje_progreso, estado_certificacion, fecha_actualizacion)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(usuario_id) DO UPDATE SET
          modulos_completados = excluded.modulos_completados,
          calificacion_global = excluded.calificacion_global,
          porcentaje_progreso = excluded.porcentaje_progreso,
          estado_certificacion = excluded.estado_certificacion,
          fecha_actualizacion = CURRENT_TIMESTAMP
      `).run(req.usuario.id, modulosCompletados, calificacionGlobal, porcentajeProgreso, estadoCertificacion);

      const progreso = db.prepare('SELECT * FROM progreso_usuarios WHERE usuario_id = ?')
        .get(req.usuario.id);

      res.json({ success: true, data: { progreso_usuario: progreso } });

    } catch (error) {
      logger.error('Error guardando respuesta:', error);
      res.status(500).json({ success: false, error: error.message, code: error.code });
    }
  }
);

// ==========================================
// ENDPOINTS DE CERTIFICADOS
// ==========================================

app.post('/api/certificados/generar', verificarToken, async (req, res) => {
  try {
    const progreso = db.prepare('SELECT * FROM progreso_usuarios WHERE usuario_id = ?')
      .get(req.usuario.id);

    if (!progreso || progreso.calificacion_global < 80) {
      return res.status(400).json({ 
        success: false, 
        message: 'Requiere mínimo 80% de calificación' 
      });
    }

    let certificado = db.prepare('SELECT * FROM certificados WHERE usuario_id = ? AND valido = 1')
      .get(req.usuario.id);

    if (!certificado) {
      const codigo = `CERT-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

      db.prepare('INSERT INTO certificados (usuario_id, codigo_verificacion, calificacion_final) VALUES (?, ?, ?)')
        .run(req.usuario.id, codigo, progreso.calificacion_global);

      certificado = db.prepare('SELECT * FROM certificados WHERE usuario_id = ?')
        .get(req.usuario.id);

      logger.info({ type: 'certificado_generado', usuario: req.usuario.email, codigo });
    }

    res.json({ 
      success: true,
      data: {
        codigo: certificado.codigo_verificacion,
        calificacion: certificado.calificacion_final,
        fecha: certificado.fecha_emision
      }
    });

  } catch (error) {
    logger.error('Error generando certificado:', error);
    res.status(500).json({ success: false });
  }
});

// ==========================================
// RUTAS ESTÁTICAS Y DEBUG
// ==========================================

app.get('/api/debug', (req, res) => {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const cols = db.pragma('table_info(respuestas_modulos)');
    res.json({ tables, cols_respuestas_modulos: cols });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('🚀 ========================================');
  console.log('   PLATAFORMA DE INDUCCIÓN - PRESIDENCIA');
  console.log('   Versión Segura con JWT + bcrypt');
  console.log('========================================');
  console.log(`🌐 Servidor corriendo en: http://${HOST}:${PORT}`);
  console.log(`📊 Panel de administración: http://${HOST}:${PORT}/admin`);
  console.log(`🔒 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📝 Registros: error.log, combined.log, security.log`);
  console.log('========================================');
  console.log('');
});

process.on('SIGTERM', () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
