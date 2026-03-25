const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();

// Configuración de seguridad
app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: true,
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Configuración de la base de datos
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'plataforma_induccion',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Pool de conexiones
const pool = mysql.createPool(dbConfig);

// Middleware para inyectar conexión de DB
app.use((req, res, next) => {
  req.db = pool;
  next();
});

// Middleware de logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ====================================
// RUTAS DE AUTENTICACIÓN
// ====================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { nombre, email } = req.body;

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

    let [usuarios] = await pool.execute(
      'SELECT * FROM usuarios WHERE email = ?',
      [email.toLowerCase()]
    );

    if (usuarios.length === 0) {
      await pool.execute(
        'INSERT INTO usuarios (nombre, email, created_at) VALUES (?, ?, NOW())',
        [nombre, email.toLowerCase()]
      );

      [usuarios] = await pool.execute(
        'SELECT * FROM usuarios WHERE email = ?',
        [email.toLowerCase()]
      );

      await pool.execute(
        'INSERT INTO progreso_usuarios (usuario_id, porcentaje_progreso, calificacion_global, modulos_completados) VALUES (?, 0, 0, 0)',
        [usuarios[0].id]
      );
    } else {
      await pool.execute(
        'UPDATE usuarios SET ultima_actividad = NOW(), nombre = ? WHERE id = ?',
        [nombre, usuarios[0].id]
      );
    }

    await pool.execute(
      'INSERT INTO auditoria (usuario_id, accion, detalles, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)',
      [usuarios[0].id, 'login', 'Usuario inició sesión', req.ip, req.get('User-Agent')]
    );

    res.json({
      success: true,
      message: 'Login exitoso',
      data: {
        usuario: {
          id: usuarios[0].id,
          nombre: nombre,
          email: email.toLowerCase()
        }
      }
    });

  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// ====================================
// RUTAS DE MÓDULOS
// ====================================

app.post('/api/modulos/respuesta', async (req, res) => {
  try {
    const { usuario_id, modulo_id, respuestas, puntuacion_total } = req.body;

    if (!usuario_id || !modulo_id || !Array.isArray(respuestas)) {
      return res.status(400).json({
        success: false,
        message: 'Datos incompletos'
      });
    }

    const [usuario] = await pool.execute(
      'SELECT id FROM usuarios WHERE id = ?',
      [usuario_id]
    );

    if (usuario.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    await pool.execute(
      'DELETE FROM respuestas_modulos WHERE usuario_id = ? AND modulo_id = ?',
      [usuario_id, modulo_id]
    );

    for (let i = 0; i < respuestas.length; i++) {
      const respuesta = respuestas[i];
      await pool.execute(`
        INSERT INTO respuestas_modulos 
        (usuario_id, modulo_id, pregunta_numero, pregunta_texto, respuesta_seleccionada, respuesta_correcta, es_correcta, puntuacion, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        usuario_id,
        modulo_id,
        i + 1,
        respuesta.pregunta || '',
        respuesta.respuesta_seleccionada || '',
        respuesta.respuesta_correcta || '',
        respuesta.es_correcta ? 1 : 0,
        respuesta.es_correcta ? 1 : 0
      ]);
    }

    await actualizarProgreso(usuario_id);

    await pool.execute(
      'INSERT INTO auditoria (usuario_id, accion, detalles, ip_address) VALUES (?, ?, ?, ?)',
      [usuario_id, 'respuesta_modulo', `Módulo ${modulo_id} completado con ${puntuacion_total} aciertos`, req.ip]
    );

    res.json({
      success: true,
      message: 'Respuestas guardadas exitosamente',
      data: { puntuacion_total, modulo_id }
    });

  } catch (error) {
    console.error('Error guardando respuestas:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// ====================================
// RUTAS DE CERTIFICADOS
// ====================================

app.post('/api/certificados/generar', async (req, res) => {
  try {
    const { usuario_id } = req.body;

    if (!usuario_id) {
      return res.status(400).json({
        success: false,
        message: 'ID de usuario requerido'
      });
    }

    const [progreso] = await pool.execute(
      'SELECT * FROM progreso_usuarios WHERE usuario_id = ?',
      [usuario_id]
    );

    if (progreso.length === 0 || progreso[0].calificacion_global < 80) {
      return res.status(400).json({
        success: false,
        message: 'El usuario no cumple con el 80% mínimo requerido'
      });
    }

    const codigoVerificacion = 'CERT-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase();

    const [certificadoExistente] = await pool.execute(
      'SELECT * FROM certificados WHERE usuario_id = ?',
      [usuario_id]
    );

    if (certificadoExistente.length > 0) {
      await pool.execute(
        'UPDATE certificados SET codigo_verificacion = ?, fecha_generacion = NOW() WHERE usuario_id = ?',
        [codigoVerificacion, usuario_id]
      );
    } else {
      await pool.execute(
        'INSERT INTO certificados (usuario_id, codigo_verificacion, fecha_generacion) VALUES (?, ?, NOW())',
        [usuario_id, codigoVerificacion]
      );
    }

    await pool.execute(
      'INSERT INTO auditoria (usuario_id, accion, detalles, ip_address) VALUES (?, ?, ?, ?)',
      [usuario_id, 'certificado_generado', `Certificado generado con código: ${codigoVerificacion}`, req.ip]
    );

    res.json({
      success: true,
      message: 'Certificado generado exitosamente',
      data: { codigo_verificacion: codigoVerificacion }
    });

  } catch (error) {
    console.error('Error generando certificado:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// ====================================
// RUTAS DE ADMINISTRACIÓN
// ====================================

const adminRoutes = require('./admin-routes');
app.use('/api/admin', adminRoutes);

// ====================================
// FUNCIÓN AUXILIAR
// ====================================

async function actualizarProgreso(usuario_id) {
  try {
    const [respuestas] = await pool.execute(`
      SELECT 
        modulo_id,
        COUNT(*) as total_preguntas,
        SUM(puntuacion) as puntos_obtenidos
      FROM respuestas_modulos 
      WHERE usuario_id = ? 
      GROUP BY modulo_id
    `, [usuario_id]);

    if (respuestas.length === 0) return;

    const totalModulos = 11;
    const modulosCompletados = respuestas.length;
    const porcentajeProgreso = Math.round((modulosCompletados / totalModulos) * 100);

    const totalPuntos = respuestas.reduce((sum, r) => sum + r.puntos_obtenidos, 0);
    const totalPreguntas = respuestas.reduce((sum, r) => sum + r.total_preguntas, 0);
    const calificacionGlobal = totalPreguntas > 0 ? Math.round((totalPuntos / (totalPreguntas * 2)) * 100) : 0;

    await pool.execute(`
      UPDATE progreso_usuarios 
      SET porcentaje_progreso = ?, calificacion_global = ?, modulos_completados = ?, updated_at = NOW()
      WHERE usuario_id = ?
    `, [porcentajeProgreso, calificacionGlobal, modulosCompletados, usuario_id]);

  } catch (error) {
    console.error('Error actualizando progreso:', error);
  }
}

// ====================================
// ARCHIVOS ESTÁTICOS
// ====================================

app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../admin/dashboard.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ====================================
// MANEJO DE ERRORES
// ====================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada'
  });
});

app.use((error, req, res, next) => {
  console.error('Error no manejado:', error);
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor'
  });
});

// ====================================
// INICIALIZACIÓN
// ====================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📊 Dashboard Admin: http://localhost:${PORT}/admin`);
  console.log(`🌐 Frontend: http://localhost:${PORT}`);
  console.log(`📡 API Base: http://localhost:${PORT}/api`);
});

process.on('SIGINT', async () => {
  console.log('\n🔄 Cerrando servidor...');
  try {
    await pool.end();
    console.log('✅ Conexiones cerradas');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error cerrando pool:', error);
    process.exit(1);
  }
});

module.exports = app;