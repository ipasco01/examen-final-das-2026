ms-usuarios/
├── src/                      # Directorio principal del código fuente
│   ├── api/                  # Capa de API (Express, Fastify, etc.)
│   │   ├── routes/           # Definición de las rutas REST
│   │   │   └── usuarios.routes.js
│   │   ├── controllers/      # Controladores: manejan req/res HTTP
│   │   │   └── usuarios.controller.js
│   │   └── middlewares/      # Middlewares (logging, errores, etc.)
│   │       ├── errorHandler.js
│   │       └── requestLogger.js
│   │
│   ├── domain/               # Lógica de negocio y reglas principales
│   │   ├── services/         # Orquestación de la lógica de negocio
│   │   │   └── usuarios.service.js
│   │   └── models/           # Modelos de dominio (entidades)
│   │       ├── Estudiante.js
│   │       └── Tutor.js
│   │
│   ├── infrastructure/         # Capa de infraestructura (detalles externos)
│   │   └── repositories/     # Acceso a datos (simulado o real)
│   │       └── usuarios.repository.js
│   │
│   ├── config/               # Configuración de la aplicación
│   │   └── index.js          # Carga de variables de entorno, etc.
│   │
│   └── app.js                # Punto de entrada de la aplicación, configuración del servidor
│
├── tests/                    # Pruebas automatizadas
│   ├── unit/                 # Pruebas unitarias (ej. para un servicio)
│   └── integration/          # Pruebas de integración (ej. ruta -> controlador -> servicio)
│
├── docs/                     # Documentación
│   └── swagger.yaml          # Definición OpenAPI/Swagger
│
├── .env.example              # Ejemplo de variables de entorno
├── .gitignore                # Archivos y carpetas a ignorar por Git
├── Dockerfile                # Instrucciones para construir la imagen del contenedor
└── package.json              # Metadatos del proyecto y dependencias (asumiendo Node.js)


-- Conéctate a la base de datos 'db_usuarios'
# Desde la linea de comandos ejecute este codigo sql

CREATE TABLE estudiantes (
    id VARCHAR(50) PRIMARY KEY,
    nombreCompleto VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    carrera VARCHAR(255)
);

CREATE TABLE tutores (
    id VARCHAR(50) PRIMARY KEY,
    nombreCompleto VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL
);

-- Deuda #14 resuelta: 'especialidad' (VARCHAR libre, un tutor = una sola materia) se reemplazó
-- por un catálogo real + relación N:M, para que un tutor pueda dictar más de una materia.
CREATE TABLE materias (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(255) UNIQUE NOT NULL
);

CREATE TABLE tutor_materia (
    idTutor VARCHAR(50) NOT NULL REFERENCES tutores(id),
    idMateria INTEGER NOT NULL REFERENCES materias(id),
    PRIMARY KEY (idTutor, idMateria)
);

-- Insertar datos de ejemplo (los que tenías en memoria)
INSERT INTO estudiantes (id, nombreCompleto, email, carrera) VALUES
('e12345', 'Ana Torres', 'ana.torres@universidad.edu', 'Ingeniería de Software'),
('e67890', 'Luis Garcia', 'luis.garcia@universidad.edu', 'Medicina');

INSERT INTO tutores (id, nombreCompleto, email) VALUES
('t54321', 'Dr. Carlos Rojas', 'carlos.rojas@universidad.edu'),
('t09876', 'Dra. Elena Solano', 'elena.solano@universidad.edu');

INSERT INTO materias (nombre) VALUES
('Bases de Datos Avanzadas'), ('Estructuras de Datos'), ('Cálculo Multivariable');

-- t54321 dicta dos materias: demuestra que la relación N:M funciona.
INSERT INTO tutor_materia (idTutor, idMateria)
SELECT 't54321', id FROM materias WHERE nombre = 'Bases de Datos Avanzadas';
INSERT INTO tutor_materia (idTutor, idMateria)
SELECT 't54321', id FROM materias WHERE nombre = 'Estructuras de Datos';
INSERT INTO tutor_materia (idTutor, idMateria)
SELECT 't09876', id FROM materias WHERE nombre = 'Cálculo Multivariable';