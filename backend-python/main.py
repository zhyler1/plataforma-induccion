import sqlite3
import bcrypt
import secrets
import os
import base64
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from time import time

from fastapi import FastAPI, Request, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ==================== CONFIGURACION ====================

BASE_DIR = Path(__file__).parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
ADMIN_DIR = BASE_DIR.parent / "admin"

DB_PATH = os.environ.get("DB_PATH", str(BASE_DIR.parent / "backend" / "database.db"))
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("ADMIN_PASS")
PORT = int(os.environ.get("PORT", 3000))

app = FastAPI(docs_url=None, redoc_url=None)  # sin Swagger en produccion

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://induccion-presidencia.onrender.com",
        "https://media.presidencia.gov.co",
        "https://testintranet.presidencia.gov.co",
        "https://intranet.presidencia.gov.co",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==================== BASE DE DATOS ====================

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
    finally:
        conn.close()

def audit(conn, user_id, accion, detalles, ip="unknown", user_agent="unknown"):
    try:
        conn.execute(
            "INSERT INTO auditoria (usuario_id, accion, detalles, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)",
            (user_id, accion, detalles, ip, user_agent),
        )
        conn.commit()
    except Exception:
        pass

# ==================== RATE LIMITING ====================

_login_attempts: dict = defaultdict(list)

def check_rate_limit(ip: str, max_attempts: int = 10, window_seconds: int = 900) -> bool:
    now = time()
    attempts = [t for t in _login_attempts[ip] if now - t < window_seconds]
    _login_attempts[ip] = attempts
    if len(attempts) >= max_attempts:
        return False
    _login_attempts[ip].append(now)
    return True

# ==================== AUTH ADMIN ====================

def admin_auth(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Basic "):
        raise HTTPException(
            status_code=401,
            detail="Acceso no autorizado",
            headers={"WWW-Authenticate": 'Basic realm="Panel Administrativo"'},
        )
    try:
        decoded = base64.b64decode(auth[6:]).decode("utf-8")
        user, pwd = decoded.split(":", 1)
    except Exception:
        raise HTTPException(status_code=401, detail="Credenciales inválidas")
    if user != ADMIN_USER or pwd != ADMIN_PASS:
        raise HTTPException(
            status_code=401,
            detail="Credenciales incorrectas",
            headers={"WWW-Authenticate": 'Basic realm="Panel Administrativo"'},
        )

# ==================== LOGICA DE LOGIN ====================

async def _do_login(request: Request, conn: sqlite3.Connection, body: dict):
    ip = request.client.host if request.client else "unknown"

    if not check_rate_limit(ip):
        return JSONResponse(
            status_code=429,
            content={"success": False, "message": "Demasiados intentos. Intenta de nuevo en 15 minutos."},
        )

    email = body.get("email", "").lower().strip()
    cedula = str(body.get("cedula", ""))

    if not email or not cedula:
        return JSONResponse(status_code=400, content={"success": False, "message": "Email y cédula son requeridos"})
    if not email.endswith("@presidencia.gov.co"):
        return JSONResponse(status_code=400, content={"success": False, "message": "El email debe ser del dominio @presidencia.gov.co"})
    if not cedula.isdigit():
        return JSONResponse(status_code=400, content={"success": False, "message": "La cédula solo debe contener números"})

    usuario = conn.execute("SELECT * FROM usuarios WHERE email = ?", (email,)).fetchone()

    if usuario:
        usuario = dict(usuario)
        cedula_hash = usuario.get("cedula_hash")
        if cedula_hash:
            valid = bcrypt.checkpw(cedula.encode(), cedula_hash.encode())
        else:
            valid = usuario.get("cedula") == cedula
        if not valid:
            return JSONResponse(status_code=401, content={"success": False, "message": "Cédula incorrecta"})
        nuevo_hash = bcrypt.hashpw(cedula.encode(), bcrypt.gensalt()).decode()
        conn.execute(
            "UPDATE usuarios SET ultima_actividad = CURRENT_TIMESTAMP, cedula = ?, cedula_hash = ? WHERE id = ?",
            (cedula, nuevo_hash, usuario["id"]),
        )
        conn.commit()
        audit(conn, usuario["id"], "LOGIN", "Sesión iniciada", ip, request.headers.get("user-agent", ""))
        return JSONResponse(content={
            "success": True,
            "message": "Login exitoso",
            "user": {"id": usuario["id"], "nombre": usuario["nombre"], "email": email, "cedula": cedula},
        })
    else:
        nombre_default = body.get("nombre") or email.split("@")[0].replace(".", " ").title()
        cedula_hash = bcrypt.hashpw(cedula.encode(), bcrypt.gensalt()).decode()
        cur = conn.execute(
            "INSERT INTO usuarios (nombre, email, cedula, cedula_hash) VALUES (?, ?, ?, ?)",
            (nombre_default, email, cedula, cedula_hash),
        )
        user_id = cur.lastrowid
        conn.execute(
            "INSERT INTO progreso_usuarios (usuario_id, modulos_completados, total_modulos, calificacion_global, porcentaje_progreso, estado_certificacion) VALUES (?, 0, 11, 0, 0, 'En Progreso')",
            (user_id,),
        )
        conn.commit()
        audit(conn, user_id, "REGISTRO", "Nuevo usuario registrado", ip, request.headers.get("user-agent", ""))
        return JSONResponse(
            status_code=201,
            content={
                "success": True,
                "message": "Usuario registrado exitosamente",
                "user": {"id": user_id, "nombre": nombre_default, "email": email, "cedula": cedula},
            },
        )

# ==================== LOGIN ====================

@app.post("/api/login")
async def login(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    body = await request.json()
    return await _do_login(request, conn, body)

@app.post("/api/auth/login")
async def auth_login(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    body = await request.json()
    if not body.get("cedula"):
        body["cedula"] = "00000000"
    return await _do_login(request, conn, body)

# ==================== PROGRESO DE USUARIO ====================

def _update_progress(conn, user_id: int):
    stats = conn.execute(
        "SELECT COUNT(*) as modulos_completados, COALESCE(SUM(aciertos),0) as total_aciertos, COALESCE(SUM(total_preguntas),0) as total_preguntas FROM respuestas_modulos WHERE usuario_id = ?",
        (user_id,),
    ).fetchone()
    cal = (stats["total_aciertos"] / stats["total_preguntas"] * 100) if stats["total_preguntas"] > 0 else 0
    pct = (stats["modulos_completados"] / 11) * 100
    estado = "En Progreso"
    if stats["modulos_completados"] >= 11:
        estado = "Aprobado" if cal >= 80 else "Reprobado"
    existe = conn.execute("SELECT id FROM progreso_usuarios WHERE usuario_id = ?", (user_id,)).fetchone()
    if existe:
        conn.execute(
            "UPDATE progreso_usuarios SET modulos_completados=?, calificacion_global=?, porcentaje_progreso=?, estado_certificacion=?, fecha_actualizacion=CURRENT_TIMESTAMP WHERE usuario_id=?",
            (stats["modulos_completados"], cal, pct, estado, user_id),
        )
    else:
        conn.execute(
            "INSERT INTO progreso_usuarios (usuario_id, modulos_completados, calificacion_global, porcentaje_progreso, estado_certificacion) VALUES (?,?,?,?,?)",
            (user_id, stats["modulos_completados"], cal, pct, estado),
        )
    conn.commit()

# ==================== MODULOS ====================

@app.get("/api/modulos/progreso/{email}")
def get_progreso(email: str, conn: sqlite3.Connection = Depends(get_db)):
    usuario = conn.execute("SELECT id FROM usuarios WHERE email = ?", (email.lower(),)).fetchone()
    if not usuario:
        return JSONResponse(status_code=404, content={"success": False, "message": "Usuario no encontrado"})
    respuestas = conn.execute(
        "SELECT modulo_id, aciertos, total_preguntas, porcentaje, fecha_respuesta FROM respuestas_modulos WHERE usuario_id = ? ORDER BY modulo_id",
        (usuario["id"],),
    ).fetchall()
    progreso = conn.execute("SELECT * FROM progreso_usuarios WHERE usuario_id = ?", (usuario["id"],)).fetchone()
    return {
        "success": True,
        "data": {
            "respuestas": [dict(r) for r in respuestas],
            "progreso": dict(progreso) if progreso else {},
        },
    }

@app.post("/api/modulos/respuesta")
async def guardar_respuesta(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    body = await request.json()
    usuario_email = body.get("usuarioEmail")
    modulo_id = body.get("moduloId")
    respuestas = body.get("respuestas", [])
    aciertos = body.get("aciertos")
    total_preguntas = body.get("totalPreguntas")
    porcentaje = body.get("porcentaje")

    if not usuario_email or modulo_id is None or aciertos is None or not total_preguntas:
        return JSONResponse(status_code=400, content={"success": False, "message": "Datos incompletos"})

    pct = porcentaje if porcentaje is not None else (aciertos / total_preguntas) * 100

    usuario = conn.execute("SELECT id FROM usuarios WHERE email = ?", (usuario_email.lower(),)).fetchone()
    if not usuario:
        return JSONResponse(status_code=404, content={"success": False, "message": "Usuario no encontrado"})

    conn.execute(
        "INSERT OR REPLACE INTO respuestas_modulos (usuario_id, modulo_id, respuestas_json, aciertos, total_preguntas, porcentaje) VALUES (?, ?, ?, ?, ?, ?)",
        (usuario["id"], modulo_id, json.dumps(respuestas), aciertos, total_preguntas, pct),
    )
    conn.commit()
    _update_progress(conn, usuario["id"])
    ip = request.client.host if request.client else "unknown"
    audit(conn, usuario["id"], "MODULO_COMPLETADO", f"Módulo {modulo_id} - {aciertos}/{total_preguntas} ({pct:.1f}%)", ip)
    return {"success": True, "message": "Respuesta guardada exitosamente", "data": {"porcentaje": pct, "aciertos": aciertos, "totalPreguntas": total_preguntas}}

# ==================== CERTIFICADOS ====================

@app.post("/api/certificados/generar")
async def generar_certificado(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    body = await request.json()
    email = body.get("usuarioEmail")
    if not email:
        return JSONResponse(status_code=400, content={"success": False, "message": "Email requerido"})

    usuario = conn.execute(
        "SELECT u.id, u.nombre, u.email, p.calificacion_global, p.modulos_completados FROM usuarios u JOIN progreso_usuarios p ON u.id = p.usuario_id WHERE u.email = ?",
        (email.lower(),),
    ).fetchone()
    if not usuario:
        return JSONResponse(status_code=404, content={"success": False, "message": "Usuario no encontrado"})

    usuario = dict(usuario)
    if usuario["calificacion_global"] < 80:
        return JSONResponse(status_code=400, content={"success": False, "message": f"Calificación insuficiente: {usuario['calificacion_global']:.1f}%. Requiere 80% mínimo."})
    if usuario["modulos_completados"] < 11:
        return JSONResponse(status_code=400, content={"success": False, "message": f"Módulos incompletos: {usuario['modulos_completados']}/11."})

    cert = conn.execute(
        "SELECT codigo_verificacion, fecha_emision FROM certificados WHERE usuario_id = ? AND valido = 1",
        (usuario["id"],),
    ).fetchone()
    if cert:
        return {"success": True, "message": "Certificado ya emitido", "data": {"codigoVerificacion": cert["codigo_verificacion"], "usuario": {"nombre": usuario["nombre"], "email": usuario["email"]}, "calificacion": usuario["calificacion_global"], "fechaEmision": cert["fecha_emision"]}}

    codigo = "PRCO-" + secrets.token_hex(4).upper()
    conn.execute(
        "INSERT INTO certificados (usuario_id, codigo_verificacion, calificacion_final) VALUES (?, ?, ?)",
        (usuario["id"], codigo, usuario["calificacion_global"]),
    )
    conn.commit()
    ip = request.client.host if request.client else "unknown"
    audit(conn, usuario["id"], "CERTIFICADO_GENERADO", f"Código: {codigo}", ip)
    return {"success": True, "message": "Certificado generado", "data": {"codigoVerificacion": codigo, "usuario": {"nombre": usuario["nombre"], "email": usuario["email"]}, "calificacion": usuario["calificacion_global"], "fechaEmision": datetime.now().isoformat()}}

@app.get("/api/certificados/verificar/{codigo}")
def verificar_certificado(codigo: str, conn: sqlite3.Connection = Depends(get_db)):
    cert = conn.execute(
        "SELECT c.*, u.nombre, u.email FROM certificados c JOIN usuarios u ON c.usuario_id = u.id WHERE c.codigo_verificacion = ? AND c.valido = 1",
        (codigo.upper(),),
    ).fetchone()
    if not cert:
        return JSONResponse(status_code=404, content={"success": False, "message": "Certificado no encontrado o inválido"})
    cert = dict(cert)
    return {"success": True, "data": {"valido": True, "usuario": {"nombre": cert["nombre"], "email": cert["email"]}, "calificacion": cert["calificacion_final"], "fechaEmision": cert["fecha_emision"], "codigoVerificacion": cert["codigo_verificacion"]}}

# ==================== ADMIN ====================

@app.get("/api/admin/estadisticas")
def admin_estadisticas(conn: sqlite3.Connection = Depends(get_db), _=Depends(admin_auth)):
    resumen = conn.execute("""
        SELECT COUNT(DISTINCT u.id) as total_usuarios,
               COUNT(DISTINCT CASE WHEN p.calificacion_global >= 80 THEN u.id END) as usuarios_aprobados,
               COUNT(DISTINCT c.usuario_id) as usuarios_certificados,
               ROUND(AVG(p.calificacion_global), 2) as promedio_calificacion
        FROM usuarios u
        LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id
        LEFT JOIN certificados c ON u.id = c.usuario_id AND c.valido = 1
    """).fetchone()
    modulos = conn.execute("""
        SELECT m.nombre, m.orden,
               COUNT(rm.id) as total_respuestas,
               ROUND(AVG(rm.porcentaje), 2) as promedio_calificacion
        FROM modulos m
        LEFT JOIN respuestas_modulos rm ON m.id = rm.modulo_id
        GROUP BY m.id ORDER BY m.orden
    """).fetchall()
    actividad = conn.execute("""
        SELECT DATE(fecha_registro) as fecha, COUNT(*) as nuevos_usuarios
        FROM usuarios
        WHERE fecha_registro >= date('now', '-30 days')
        GROUP BY DATE(fecha_registro) ORDER BY fecha DESC LIMIT 30
    """).fetchall()
    return {"success": True, "data": {"resumen": dict(resumen) if resumen else {}, "modulos": [dict(m) for m in modulos], "actividad_reciente": [dict(a) for a in actividad]}}

@app.get("/api/admin/usuarios")
def admin_usuarios(
    page: int = 1, limit: int = 50, search: str = "", estado: str = "",
    conn: sqlite3.Connection = Depends(get_db), _=Depends(admin_auth)
):
    offset = (page - 1) * limit
    where = "1=1"
    params: list = []
    if search:
        where += " AND (u.nombre LIKE ? OR u.email LIKE ?)"
        params.extend([f"%{search}%", f"%{search}%"])
    if estado:
        where += " AND p.estado_certificacion = ?"
        params.append(estado)
    usuarios = conn.execute(f"""
        SELECT u.id, u.nombre, u.email, u.fecha_registro, u.ultima_actividad,
               COALESCE(p.modulos_completados, 0) as modulos_completados,
               11 as total_modulos,
               COALESCE(p.calificacion_global, 0) as calificacion_global,
               COALESCE(p.estado_certificacion, 'Sin Progreso') as estado_certificacion,
               COALESCE(p.porcentaje_progreso, 0) as porcentaje_progreso,
               c.codigo_verificacion, c.fecha_emision as fecha_certificado
        FROM usuarios u
        LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id
        LEFT JOIN certificados c ON u.id = c.usuario_id AND c.valido = 1
        WHERE {where} ORDER BY u.fecha_registro DESC LIMIT ? OFFSET ?
    """, (*params, limit, offset)).fetchall()
    total = conn.execute(
        f"SELECT COUNT(*) as total FROM usuarios u LEFT JOIN progreso_usuarios p ON u.id = p.usuario_id WHERE {where}",
        params,
    ).fetchone()["total"]
    return {"success": True, "data": {"usuarios": [dict(u) for u in usuarios], "pagination": {"page": page, "limit": limit, "total": total, "pages": -(-total // limit)}}}

@app.get("/api/admin/modulos/rendimiento")
def admin_rendimiento(conn: sqlite3.Connection = Depends(get_db), _=Depends(admin_auth)):
    modulos = conn.execute("""
        SELECT m.nombre, m.orden,
               COUNT(rm.id) as total_respuestas,
               ROUND(AVG(rm.porcentaje), 2) as promedio,
               COUNT(CASE WHEN rm.porcentaje >= 80 THEN 1 END) as aprobados
        FROM modulos m
        LEFT JOIN respuestas_modulos rm ON m.id = rm.modulo_id
        GROUP BY m.id ORDER BY m.orden
    """).fetchall()
    return {"success": True, "data": [dict(m) for m in modulos]}

@app.get("/api/admin/logs")
def admin_logs(limit: int = 10, conn: sqlite3.Connection = Depends(get_db), _=Depends(admin_auth)):
    logs = conn.execute(
        "SELECT a.*, u.email FROM auditoria a LEFT JOIN usuarios u ON a.usuario_id = u.id ORDER BY a.fecha DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return {"success": True, "data": [dict(l) for l in logs]}

@app.get("/api/admin/empleados")
def admin_empleados(conn: sqlite3.Connection = Depends(get_db), _=Depends(admin_auth)):
    empleados = conn.execute(
        "SELECT id, nombre, email, cedula, fecha_registro, activo FROM usuarios ORDER BY fecha_registro DESC"
    ).fetchall()
    return {"success": True, "data": [dict(e) for e in empleados]}

@app.post("/api/admin/empleados")
async def crear_empleado(request: Request, conn: sqlite3.Connection = Depends(get_db), _=Depends(admin_auth)):
    body = await request.json()
    nombre = body.get("nombre")
    cedula = str(body.get("cedula", ""))
    email = body.get("email") or f"{cedula}@presidencia.gov.co"
    existe = conn.execute("SELECT id FROM usuarios WHERE cedula = ?", (cedula,)).fetchone()
    if existe:
        return JSONResponse(status_code=400, content={"success": False, "message": "Ya existe un usuario con esa cédula"})
    cedula_hash = bcrypt.hashpw(cedula.encode(), bcrypt.gensalt()).decode()
    cur = conn.execute(
        "INSERT INTO usuarios (nombre, email, cedula, cedula_hash) VALUES (?, ?, ?, ?)",
        (nombre, email, cedula, cedula_hash),
    )
    user_id = cur.lastrowid
    conn.execute(
        "INSERT INTO progreso_usuarios (usuario_id, modulos_completados, calificacion_global, porcentaje_progreso, estado_certificacion) VALUES (?, 0, 0, 0, 'En Progreso')",
        (user_id,),
    )
    conn.commit()
    return {"success": True, "message": "Empleado agregado", "data": {"id": user_id, "nombre": nombre, "email": email, "cedula": cedula}}

# ==================== INICIALIZACION BD ====================

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            cedula TEXT,
            password_hash TEXT,
            cedula_hash TEXT DEFAULT NULL,
            fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP,
            ultima_actividad DATETIME DEFAULT CURRENT_TIMESTAMP,
            activo BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS modulos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            descripcion TEXT,
            orden INTEGER NOT NULL,
            activo BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS respuestas_modulos (
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
        );
        CREATE TABLE IF NOT EXISTS progreso_usuarios (
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
        );
        CREATE TABLE IF NOT EXISTS certificados (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER NOT NULL,
            codigo_verificacion TEXT UNIQUE NOT NULL,
            calificacion_final DECIMAL(5,2) NOT NULL,
            fecha_emision DATETIME DEFAULT CURRENT_TIMESTAMP,
            valido BOOLEAN DEFAULT 1,
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
        );
        CREATE TABLE IF NOT EXISTS auditoria (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER,
            accion TEXT NOT NULL,
            detalles TEXT,
            ip_address TEXT,
            user_agent TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
        );
    """)
    # Insertar modulos por defecto
    count = conn.execute("SELECT COUNT(*) FROM modulos").fetchone()[0]
    if count == 0:
        modulos = [
            (1, "Introducción"), (2, "Puntos de Encuentro"), (3, "Talento Humano"),
            (4, "Seguridad y Salud en el Trabajo"), (5, "Dirección Administrativa y Financiera (DAF)"),
            (6, "Sistemas y Tecnologías de la Información"), (7, "Control Interno Disciplinario"),
            (8, "Oficina de Planeación"), (9, "Oficina de Control Interno"),
            (10, "Relacionamiento con el Ciudadano"), (11, "Recorrido por el Palacio"),
        ]
        conn.executemany("INSERT INTO modulos (orden, nombre) VALUES (?, ?)", modulos)
        print(f"✅ {len(modulos)} módulos insertados")
    conn.commit()
    conn.close()
    print("✅ Base de datos inicializada")

# ==================== DIRECTORIO ACTIVO ====================

@app.get("/api/me")
def get_me(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    # IIS con Windows Authentication pasa el usuario en este header
    ad_raw = (
        request.headers.get("logon_user") or
        request.headers.get("x-remote-user") or
        request.headers.get("http_logonuser") or
        ""
    )

    # Sin header AD: en pruebas/desarrollo usar usuario genérico real en la BD
    if not ad_raw:
        email_prueba = "usuario.prueba@presidencia.gov.co"
        usuario_prueba = conn.execute("SELECT id, nombre, email FROM usuarios WHERE email = ?", (email_prueba,)).fetchone()
        if not usuario_prueba:
            r = conn.execute("INSERT INTO usuarios (nombre, email, cedula, cedula_hash) VALUES (?, ?, ?, ?)", ("Usuario Prueba", email_prueba, "00000000", "00000000"))
            conn.execute("INSERT INTO progreso_usuarios (usuario_id, modulos_completados, total_modulos, calificacion_global, porcentaje_progreso, estado_certificacion) VALUES (?, 0, 11, 0, 0, 'En Progreso')", (r.lastrowid,))
            conn.commit()
            usuario_prueba = conn.execute("SELECT id, nombre, email FROM usuarios WHERE id = ?", (r.lastrowid,)).fetchone()
        return JSONResponse(content={"success": True, "user": {"id": usuario_prueba["id"], "nombre": usuario_prueba["nombre"], "email": usuario_prueba["email"]}})

    # PRESIDENCIA\sergiolopez → sergiolopez@presidencia.gov.co
    username = ad_raw.split("\\")[-1].lower() if "\\" in ad_raw else ad_raw.lower()
    email = username + "@presidencia.gov.co"

    usuario = conn.execute("SELECT id, nombre, email FROM usuarios WHERE email = ?", (email,)).fetchone()
    if not usuario:
        cur = conn.execute("INSERT INTO usuarios (nombre, email, cedula, cedula_hash) VALUES (?, ?, ?, ?)", (username, email, "00000000", "00000000"))
        user_id = cur.lastrowid
        conn.execute(
            "INSERT INTO progreso_usuarios (usuario_id, modulos_completados, total_modulos, calificacion_global, porcentaje_progreso, estado_certificacion) VALUES (?, 0, 11, 0, 0, 'En Progreso')",
            (user_id,)
        )
        conn.commit()
        ip = request.client.host if request.client else "unknown"
        audit(conn, user_id, "REGISTRO_AD", "Usuario creado via Directorio Activo", ip)
        usuario = conn.execute("SELECT id, nombre, email FROM usuarios WHERE id = ?", (user_id,)).fetchone()
    else:
        conn.execute("UPDATE usuarios SET ultima_actividad = CURRENT_TIMESTAMP WHERE id = ?", (usuario["id"],))
        conn.commit()
        ip = request.client.host if request.client else "unknown"
        audit(conn, usuario["id"], "LOGIN_AD", "Sesión iniciada via Directorio Activo", ip)

    usuario = dict(usuario)
    return {"success": True, "user": {"id": usuario["id"], "nombre": usuario["nombre"], "email": usuario["email"]}}

# ==================== TEST ====================

@app.get("/api/test")
def api_test():
    return {"success": True, "message": "API Python/FastAPI funcionando correctamente", "timestamp": datetime.now().isoformat(), "dbPath": DB_PATH}

# ==================== PAGINAS ====================

@app.get("/admin")
def admin_page():
    return FileResponse(str(ADMIN_DIR / "dashboard.html"))

@app.get("/")
def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))

# Archivos estaticos (debe ir al final)
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend-static")

# ==================== ARRANQUE ====================

init_db()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)
