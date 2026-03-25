// ==========================================
// PLATAFORMA DE INDUCCIÓN - PRESIDENCIA
// Server.js con Medidas de Seguridad Implementadas
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

// ==========================================
// CONFIGURACIÓN
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 12;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('❌ ERROR CRÍTICO: JWT_SECRET no está definido o es muy corto en .env');
  console.error('   Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
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

// Helmet para headers seguros
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "https://media.presidencia.gov.co", "data:"],
      mediaSrc: ["'self'", "https://media.presidencia.gov.co"],
      connectSrc: ["'self'"]
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || true,
  credentials: true
}));

// Parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Logging de requests
app.use((req, res, next) => {
  logger.info({
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Rate limiting general
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Demasiadas peticiones. Intente más tarde.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', generalLimiter);

// Rate limiting para login
const loginLimiter = rateLimit({
  windowMs: parseInt(process.env.LOGIN_RATE_WINDOW) || 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT) || 5,
  message: { success: false, message: 'Demasiados intentos de login. Intente en 15 minutos.' },
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false
});

// ==========================================
// BASE DE DATOS
// ==========================================
const dbPath = process.env.DB_PATH || './database.db';
let db;

try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  logger.info('✅ Base de datos conectada exitosamente');
} catch (error) {
  logger.error('❌ Error conectando a base de datos:', error);
  process.exit(1);
}

// Inicializar tablas
function initializeDatabase() {
  try {
    // Tabla empleados
    db.exec(`
      CREATE TABLE IF NOT EXISTS empleados (
        cedula TEXT PRIMARY KEY,
        cedula_hash TEXT NOT NULL,
        nombre_completo TEXT UNIQUE NOT NULL,
        estado TEXT DEFAULT 'activo' CHECK(estado IN ('activo', 'inactivo')),
        fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabla usuarios
    db.exec(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cedula TEXT NOT NULL,
        nombre TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP,
        ultima_actividad DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (cedula) REFERENCES empleados(cedula) ON DELETE CASCADE
      )
    `);

    // Tabla módulos
    db.exec(`
      CREATE TABLE IF NOT EXISTS modulos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        orden INTEGER NOT NULL UNIQUE,
        activo INTEGER DEFAULT 1
      )
    `);

    // Tabla respuestas_modulos
    db.exec(`
      CREATE TABLE IF NOT EXISTS respuestas_modulos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER NOT NULL,
        modulo_id INTEGER NOT NULL,
        respuestas TEXT NOT NULL,
        aciertos INTEGER NOT NULL,
        total_preguntas INTEGER NOT NULL,
        porcentaje REAL NOT NULL,
        fecha_respuesta DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
        FOREIGN KEY (modulo_id) REFERENCES modulos(id) ON DELETE CASCADE
      )
    `);

    // Tabla progreso_usuarios
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

    // Tabla certificados
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

    // Tabla auditoría
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

    // Insertar módulos si no existen
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

    logger.info('✅ Base de datos inicializada');
  } catch (error) {
    logger.error('❌ Error inicializando base de datos:', error);
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
  
  // Registrar en auditoría
  try {
    db.prepare('INSERT INTO auditoria (accion, detalles, ip) VALUES (?, ?, ?)')
      .run('intento_login_fallido', `Intentos: ${attempts.count} para ${identifier}`, ip);
  } catch (error) {
    logger.error('Error registrando auditoría:', error);
  }
  
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
    
    // Actualizar última actividad
    db.prepare('UPDATE usuarios SET ultima_actividad = CURRENT_TIMESTAMP WHERE id = ?')
      .run(decoded.id);
    
    next();
  } catch (error) {
    logger.warn({
      type: 'invalid_token',
      ip: req.ip,
      error: error.message
    });
    return res.status(401).json({ success: false, message: 'Token inválido o expirado' });
  }
}

function verificarAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') {
    logger.warn({
      type: 'unauthorized_admin_access',
      usuario: req.usuario.email,
      ip: req.ip
    });
    return res.status(403).json({ success: false, message: 'Acceso denegado' });
  }
  next();
}

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN
// ==========================================

app.post('/api/login',
  loginLimiter,
  body('username').trim().escape().isLength({ min: 3, max: 100 }).withMessage('Nombre inválido'),
  body('password').trim().isLength({ min: 6, max: 20 }).matches(/^[0-9]+$/).withMessage('Cédula inválida'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Datos inválidos',
        errors: errors.array() 
      });
    }

    const { username, password } = req.body;
    const nombreCompleto = username.toUpperCase();
    const cedula = password;

    try {
      // Verificar bloqueo
      if (cuentaBloqueada(nombreCompleto, req.ip)) {
        logger.warn({
          type: 'blocked_login_attempt',
          username: nombreCompleto,
          ip: req.ip
        });
        return res.status(429).json({ 
          success: false, 
          message: 'Cuenta bloqueada temporalmente por múltiples intentos fallidos' 
        });
      }

      // Buscar empleado
      const empleado = db.prepare(`
        SELECT * FROM empleados 
        WHERE nombre_completo = ? AND estado = 'activo'
      `).get(nombreCompleto);

      if (!empleado || !empleado.cedula_hash) {
        registrarIntentoFallido(nombreCompleto, req.ip);
        return res.status(401).json({ 
          success: false, 
          message: 'Credenciales inválidas' 
        });
      }

      // Verificar contraseña
      const validPassword = await bcrypt.compare(cedula, empleado.cedula_hash);

      if (!validPassword) {
        registrarIntentoFallido(nombreCompleto, req.ip);
        return res.status(401).json({ 
          success: false, 
          message: 'Credenciales inválidas' 
        });
      }

      // Limpiar intentos fallidos
      limpiarIntentosFallidos(nombreCompleto, req.ip);

      // Crear o actualizar usuario
      const email = `${cedula}@presidencia.gov.co`;
      let usuario = db.prepare('SELECT * FROM usuarios WHERE cedula = ?').get(cedula);

      if (!usuario) {
        const result = db.prepare(`
          INSERT INTO usuarios (cedula, nombre, email) 
          VALUES (?, ?, ?)
        `).run(cedula, nombreCompleto, email);
        
        usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(result.lastInsertRowid);

        // Crear registro de progreso
        db.prepare(`
          INSERT INTO progreso_usuarios (usuario_id) 
          VALUES (?)
        `).run(usuario.id);
      } else {
        // Actualizar última actividad
        db.prepare(`
          UPDATE usuarios 
          SET ultima_actividad = CURRENT_TIMESTAMP 
          WHERE id = ?
        `).run(usuario.id);
      }

      // Generar token JWT
      const token = jwt.sign(
        { 
          id: usuario.id, 
          email: usuario.email, 
          nombre: usuario.nombre,
          cedula: usuario.cedula,
          rol: 'usuario'
        },
        JWT_SECRET,
        { expiresIn: '8h' }
      );

      // Enviar token en cookie segura
      res.cookie('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 8 * 60 * 60 * 1000
      });

      // Registrar en auditoría
      db.prepare('INSERT INTO auditoria (usuario_id, accion, ip) VALUES (?, ?, ?)')
        .run(usuario.id, 'login_exitoso', req.ip);

      logger.info({
        type: 'successful_login',
        usuario: usuario.email,
        ip: req.ip
      });

      res.json({
        success: true,
        user: {
          id: usuario.id,
          nombre: usuario.nombre,
          email: usuario.email,
          cedula: usuario.cedula
        },
        token
      });

    } catch (error) {
      logger.error('Error en login:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error en el servidor' 
      });
    }
  }
);

app.post('/api/logout', verificarToken, (req, res) => {
  res.clearCookie('auth_token');
  
  // Registrar en auditoría
  db.prepare('INSERT INTO auditoria (usuario_id, accion, ip) VALUES (?, ?, ?)')
    .run(req.usuario.id, 'logout', req.ip);
  
  res.json({ success: true, message: 'Sesión cerrada' });
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
    res.status(500).json({ success: false, message: 'Error obteniendo módulos' });
  }
});

app.post('/api/modulos/respuesta',
  verificarToken,
  body('usuarioEmail').isEmail(),
  body('moduloId').isInt(),
  body('respuestas').isArray(),
  body('aciertos').isInt(),
  body('totalPreguntas').isInt(),
  body('porcentaje').isNumeric(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Datos inválidos',
        errors: errors.array() 
      });
    }

    const { usuarioEmail, moduloId, respuestas, aciertos, totalPreguntas, porcentaje } = req.body;

    try {
      const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(usuarioEmail);

      if (!usuario) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }

      // Verificar que el usuario del token coincida
      if (usuario.id !== req.usuario.id) {
        return res.status(403).json({ success: false, message: 'No autorizado' });
      }

      // Guardar respuesta
      const respuestasJSON = JSON.stringify(respuestas);
      
      db.prepare(`
        INSERT INTO respuestas_modulos 
        (usuario_id, modulo_id, respuestas, aciertos, total_preguntas, porcentaje) 
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(usuario.id, moduloId, respuestasJSON, aciertos, totalPreguntas, porcentaje);

      // Actualizar progreso
      const modulosCompletados = db.prepare(`
        SELECT COUNT(DISTINCT modulo_id) as count 
        FROM respuestas_modulos 
        WHERE usuario_id = ?
      `).get(usuario.id).count;

      const calificacionGlobal = db.prepare(`
        SELECT AVG(porcentaje) as promedio 
        FROM respuestas_modulos 
        WHERE usuario_id = ?
      `).get(usuario.id).promedio || 0;

      const porcentajeProgreso = (modulosCompletados / 11) * 100;

      let estadoCertificacion = 'En Progreso';
      if (modulosCompletados === 11) {
        estadoCertificacion = calificacionGlobal >= 80 ? 'Aprobado' : 'Reprobado';
      }

      db.prepare(`
        UPDATE progreso_usuarios 
        SET modulos_completados = ?, 
            calificacion_global = ?, 
            porcentaje_progreso = ?,
            estado_certificacion = ?,
            fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE usuario_id = ?
      `).run(modulosCompletados, calificacionGlobal, porcentajeProgreso, estadoCertificacion, usuario.id);

      // Obtener progreso actualizado
      const progreso = db.prepare(`
        SELECT * FROM progreso_usuarios WHERE usuario_id = ?
      `).get(usuario.id);

      // Registrar en auditoría
      db.prepare('INSERT INTO auditoria (usuario_id, accion, detalles) VALUES (?, ?, ?)')
        .run(usuario.id, 'respuesta_modulo', `Módulo ${moduloId}: ${porcentaje}%`);

      res.json({ 
        success: true, 
        message: 'Respuesta guardada',
        data: {
          progreso_usuario: {
            modulos_completados: progreso.modulos_completados,
            calificacion_global: progreso.calificacion_global,
            porcentaje_progreso: progreso.porcentaje_progreso,
            estado_certificacion: progreso.estado_certificacion
          }
        }
      });

    } catch (error) {
      logger.error('Error guardando respuesta:', error);
      res.status(500).json({ success: false, message: 'Error guardando respuesta' });
    }
  }
);

// ==========================================
// ENDPOINTS DE CERTIFICADOS
// ==========================================

app.post('/api/certificados/generar',
  verificarToken,
  body('usuarioEmail').isEmail(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Datos inválidos',
        errors: errors.array() 
      });
    }

    const { usuarioEmail } = req.body;

    try {
      const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(usuarioEmail);

      if (!usuario || usuario.id !== req.usuario.id) {
        return res.status(403).json({ success: false, message: 'No autorizado' });
      }

      const progreso = db.prepare(`
        SELECT * FROM progreso_usuarios WHERE usuario_id = ?
      `).get(usuario.id);

      if (!progreso || progreso.calificacion_global < 80) {
        return res.status(400).json({ 
          success: false, 
          message: 'Se requiere mínimo 80% de calificación global' 
        });
      }

      // Verificar si ya tiene certificado
      let certificado = db.prepare(`
        SELECT * FROM certificados WHERE usuario_id = ? AND valido = 1
      `).get(usuario.id);

      if (!certificado) {
        // Generar código único
        const codigo = `CERT-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

        db.prepare(`
          INSERT INTO certificados 
          (usuario_id, codigo_verificacion, calificacion_final) 
          VALUES (?, ?, ?)
        `).run(usuario.id, codigo, progreso.calificacion_global);

        certificado = db.prepare(`
          SELECT * FROM certificados WHERE usuario_id = ?
        `).get(usuario.id);

        // Registrar en auditoría
        db.prepare('INSERT INTO auditoria (usuario_id, accion, detalles) VALUES (?, ?, ?)')
          .run(usuario.id, 'certificado_generado', codigo);

        logger.info({
          type: 'certificado_generado',
          usuario: usuario.email,
          codigo: codigo
        });
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
      res.status(500).json({ success: false, message: 'Error generando certificado' });
    }
  }
);

// ==========================================
// ENDPOINTS ADMINISTRATIVOS
// ==========================================

app.get('/api/admin/estadisticas', verificarToken, verificarAdmin, (req, res) => {
  try {
    const stats = {
      total_usuarios: db.prepare('SELECT COUNT(*) as count FROM usuarios').get().count,
      usuarios_aprobados: db.prepare(`
        SELECT COUNT(*) as count FROM progreso_usuarios 
        WHERE estado_certificacion = 'Aprobado'
      `).get().count,
      usuarios_certificados: db.prepare('SELECT COUNT(*) as count FROM certificados WHERE valido = 1').get().count,
      promedio_calificacion: db.prepare(`
        SELECT AVG(calificacion_global) as promedio FROM progreso_usuarios
      `).get().promedio || 0
    };

    res.json({ 
      success: true, 
      data: { resumen: stats } 
    });
  } catch (error) {
    logger.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo estadísticas' });
  }
});

app.get('/api/admin/usuarios', verificarToken, verificarAdmin, (req, res) => {
  try {
    const { limit = 100 } = req.query;
    
    const usuarios = db.prepare(`
      SELECT 
        u.id,
        u.nombre,
        u.email,
        u.cedula,
        u.fecha_registro,
        u.ultima_actividad,
        p.modulos_completados,
        p.calificacion_global,
        p.porcentaje_progreso,
        p.estado_certificacion,
        c.codigo_verificacion,
        c.fecha_emision
      FROM usuarios u
      LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id
      LEFT JOIN certificados c ON u.id = c.usuario_id AND c.valido = 1
      ORDER BY u.fecha_registro DESC
      LIMIT ?
    `).all(parseInt(limit));

    res.json({ 
      success: true, 
      data: { usuarios } 
    });
  } catch (error) {
    logger.error('Error obteniendo usuarios:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo usuarios' });
  }
});

app.delete('/api/admin/usuarios/:id', verificarToken, verificarAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    db.prepare('DELETE FROM respuestas_modulos WHERE usuario_id = ?').run(id);
    db.prepare('DELETE FROM progreso_usuarios WHERE usuario_id = ?').run(id);
    db.prepare('DELETE FROM certificados WHERE usuario_id = ?').run(id);
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
    
    // Registrar en auditoría
    db.prepare('INSERT INTO auditoria (usuario_id, accion, detalles, ip) VALUES (?, ?, ?, ?)')
      .run(req.usuario.id, 'usuario_eliminado', `Usuario ID: ${id}`, req.ip);
    
    res.json({ success: true, message: 'Usuario eliminado correctamente' });
  } catch (error) {
    logger.error('Error eliminando usuario:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar usuario' });
  }
});

app.post('/api/admin/usuarios/:id/reset', verificarToken, verificarAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    db.prepare('DELETE FROM respuestas_modulos WHERE usuario_id = ?').run(id);
    db.prepare('DELETE FROM certificados WHERE usuario_id = ?').run(id);
    db.prepare(`
      UPDATE progreso_usuarios 
      SET modulos_completados = 0, 
          calificacion_global = 0, 
          porcentaje_progreso = 0,
          estado_certificacion = "En Progreso",
          fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE usuario_id = ?
    `).run(id);
    
    // Registrar en auditoría
    db.prepare('INSERT INTO auditoria (usuario_id, accion, detalles, ip) VALUES (?, ?, ?, ?)')
      .run(req.usuario.id, 'progreso_reseteado', `Usuario ID: ${id}`, req.ip);
    
    res.json({ success: true, message: 'Progreso reseteado correctamente' });
  } catch (error) {
    logger.error('Error reseteando progreso:', error);
    res.status(500).json({ success: false, message: 'Error al resetear progreso' });
  }
});

app.put('/api/admin/usuarios/:id', verificarToken, verificarAdmin, (req, res) => {
  const { id } = req.params;
  const { nombre, email } = req.body;
  
  try {
    db.prepare('UPDATE usuarios SET nombre = ?, email = ? WHERE id = ?').run(nombre, email, id);
    
    // Registrar en auditoría
    db.prepare('INSERT INTO auditoria (usuario_id, accion, detalles, ip) VALUES (?, ?, ?, ?)')
      .run(req.usuario.id, 'usuario_editado', `Usuario ID: ${id}`, req.ip);
    
    res.json({ success: true, message: 'Usuario actualizado correctamente' });
  } catch (error) {
    logger.error('Error actualizando usuario:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar usuario' });
  }
});

app.get('/api/admin/empleados', verificarToken, verificarAdmin, (req, res) => {
  try {
    const empleados = db.prepare('SELECT cedula, nombre_completo, estado, fecha_registro FROM empleados ORDER BY nombre_completo').all();
    res.json({ success: true, data: empleados });
  } catch (error) {
    logger.error('Error obteniendo empleados:', error);
    res.status(500).json({ success: false, message: 'Error al obtener empleados' });
  }
});

app.post('/api/admin/empleados', verificarToken, verificarAdmin, async (req, res) => {
  const { cedula, nombre_completo } = req.body;
  
  try {
    const hashedCedula = await bcrypt.hash(cedula, SALT_ROUNDS);
    db.prepare('INSERT INTO empleados (cedula, cedula_hash, nombre_completo) VALUES (?, ?, ?)')
      .run(cedula, hashedCedula, nombre_completo);
    
    // Registrar en auditoría
    db.prepare('INSERT INTO auditoria (usuario_id, accion, detalles, ip) VALUES (?, ?, ?, ?)')
      .run(req.usuario.id, 'empleado_agregado', nombre_completo, req.ip);
    
    res.json({ success: true, message: 'Empleado agregado correctamente' });
  } catch (error) {
    logger.error('Error agregando empleado:', error);
    res.status(500).json({ success: false, message: 'Error al agregar empleado' });
  }
});

app.put('/api/admin/empleados/:cedula/desactivar', verificarToken, verificarAdmin, (req, res) => {
  const { cedula } = req.params;
  
  try {
    db.prepare('UPDATE empleados SET estado = "inactivo" WHERE cedula = ?').run(cedula);
    
    // Registrar en auditoría
    db.prepare('INSERT INTO auditoria (usuario_id, accion, detalles, ip) VALUES (?, ?, ?, ?)')
      .run(req.usuario.id, 'empleado_desactivado', cedula, req.ip);
    
    res.json({ success: true, message: 'Empleado desactivado correctamente' });
  } catch (error) {
    logger.error('Error desactivando empleado:', error);
    res.status(500).json({ success: false, message: 'Error al desactivar empleado' });
  }
});

app.get('/api/admin/usuarios/:id/detalle', verificarToken, verificarAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    const usuario = db.prepare(`
      SELECT u.*, p.*, c.codigo_verificacion, c.fecha_emision
      FROM usuarios u
      LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id
      LEFT JOIN certificados c ON u.id = c.usuario_id
      WHERE u.id = ?
    `).get(id);
    
    const respuestas = db.prepare(`
      SELECT rm.*, m.nombre as modulo_nombre
      FROM respuestas_modulos rm
      JOIN modulos m ON rm.modulo_id = m.id
      WHERE rm.usuario_id = ?
      ORDER BY m.orden
    `).all(id);
    
    res.json({ success: true, data: { usuario, respuestas } });
  } catch (error) {
    logger.error('Error obteniendo detalle:', error);
    res.status(500).json({ success: false, message: 'Error al obtener detalle' });
  }
});

app.get('/api/admin/estadisticas/periodo', verificarToken, verificarAdmin, (req, res) => {
  const { inicio, fin } = req.query;
  
  try {
    const stats = db.prepare(`
      SELECT 
        DATE(fecha_registro) as fecha,
        COUNT(*) as registros,
        SUM(CASE WHEN EXISTS(SELECT 1 FROM certificados WHERE usuario_id = usuarios.id) THEN 1 ELSE 0 END) as certificados
      FROM usuarios
      WHERE fecha_registro BETWEEN ? AND ?
      GROUP BY DATE(fecha_registro)
      ORDER BY fecha
    `).all(inicio, fin);
    
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ success: false, message: 'Error al obtener estadísticas' });
  }
});

app.get('/api/admin/modulos/rendimiento', verificarToken, verificarAdmin, (req, res) => {
  try {
    const rendimiento = db.prepare(`
      SELECT 
        m.nombre,
        COUNT(rm.id) as total_respuestas,
        AVG(rm.porcentaje) as promedio,
        SUM(CASE WHEN rm.porcentaje = 100 THEN 1 ELSE 0 END) as perfectos,
        SUM(CASE WHEN rm.porcentaje = 0 THEN 1 ELSE 0 END) as ceros
      FROM modulos m
      LEFT JOIN respuestas_modulos rm ON m.id = rm.modulo_id
      GROUP BY m.id, m.nombre
      ORDER BY promedio ASC
    `).all();
    
    res.json({ success: true, data: rendimiento });
  } catch (error) {
    logger.error('Error obteniendo rendimiento:', error);
    res.status(500).json({ success: false, message: 'Error al obtener rendimiento' });
  }
});

app.get('/api/admin/logs', verificarToken, verificarAdmin, (req, res) => {
  const { limit = 100 } = req.query;
  
  try {
    const logs = db.prepare(`
      SELECT a.*, u.nombre
      FROM auditoria a
      LEFT JOIN usuarios u ON a.usuario_id = u.id
      ORDER BY a.fecha DESC
      LIMIT ?
    `).all(parseInt(limit));
    
    res.json({ success: true, data: logs });
  } catch (error) {
    logger.error('Error obteniendo logs:', error);
    res.status(500).json({ success: false, message: 'Error al obtener logs' });
  }
});

// ==========================================
// RUTAS ESTÁTICAS
// ==========================================

app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../admin/dashboard.html'));
});

// ==========================================
// MANEJO DE ERRORES
// ==========================================

app.use((err, req, res, next) => {
  logger.error({
    type: 'unhandled_error',
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip
  });

  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' 
      ? 'Error interno del servidor' 
      : err.message
  });
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
  console.log(`📊 Admin panel: http://${HOST}:${PORT}/admin`);
  console.log(`🔒 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📝 Logs: error.log, combined.log, security.log`);
  console.log('========================================');
  console.log('');
  
  logger.info('Servidor iniciado exitosamente', {
    host: HOST,
    port: PORT,
    env: process.env.NODE_ENV
  });
});

// Manejo de cierre graceful
process.on('SIGTERM', () => {
  logger.info('🛑 Señal de interrupción recibida. Cerrando servidor...');
  
  server.close(() => {
    logger.info('✅ Servidor cerrado correctamente');
    db.close();
    logger.info('✅ Base de datos cerrada correctamente');
    logger.info('👋 Servidor cerrado. ¡Hasta luego!');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('🛑 Señal de interrupción recibida. Cerrando servidor...');
  
  server.close(() => {
    logger.info('✅ Servidor cerrado correctamente');
    db.close();
    logger.info('✅ Base de datos cerrada correctamente');
    logger.info('👋 Servidor cerrado. ¡Hasta luego!');
    process.exit(0);
  });
});

