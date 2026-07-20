-- docker/init/usuarios/01-schema.sql — base db_usuarios (ms-usuarios)
-- Equipo 5 (Deployment). Se ejecuta solo en la primera inicialización del volumen.
-- Ver docker/init/auth/01-schema.sql para el razonamiento completo.

CREATE TABLE IF NOT EXISTS estudiantes (
    id VARCHAR(50) PRIMARY KEY,
    nombreCompleto VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    carrera VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS tutores (
    id VARCHAR(50) PRIMARY KEY,
    nombreCompleto VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL
);

-- Deuda #14 resuelta: 'especialidad' era un VARCHAR libre en 'tutores' (un tutor = una sola
-- materia, sin catálogo, sin poder ofrecer un <select> en el cliente). Se reemplaza por un
-- catálogo real + relación N:M, para que un tutor pueda dictar más de una materia y "materia"
-- deje de ser texto libre sin validar.
CREATE TABLE IF NOT EXISTS materias (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(255) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS tutor_materia (
    idTutor VARCHAR(50) NOT NULL REFERENCES tutores(id),
    idMateria INTEGER NOT NULL REFERENCES materias(id),
    PRIMARY KEY (idTutor, idMateria)
);

-- Datos de demostración. 'e12345' y 't09876' coinciden con los usuarios de db_auth: la Saga
-- resuelve el perfil contra este servicio usando el id que viene en el JWT emitido por ms-auth.
INSERT INTO estudiantes (id, nombreCompleto, email, carrera) VALUES
('e12345', 'Ana Torres', 'ana.torres@universidad.edu', 'Ingeniería de Software'),
('e67890', 'Luis Garcia', 'luis.garcia@universidad.edu', 'Medicina')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tutores (id, nombreCompleto, email) VALUES
('t54321', 'Dr. Carlos Rojas', 'carlos.rojas@universidad.edu'),
('t09876', 'Dra. Elena Solano', 'elena.solano@universidad.edu')
ON CONFLICT (id) DO NOTHING;

-- t54321 dicta dos materias a propósito: es la prueba de que la relación N:M funciona, no solo
-- una migración 1:1 del VARCHAR viejo.
INSERT INTO materias (nombre) VALUES
('Bases de Datos Avanzadas'),
('Estructuras de Datos'),
('Cálculo Multivariable')
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO tutor_materia (idTutor, idMateria)
SELECT 't54321', id FROM materias WHERE nombre = 'Bases de Datos Avanzadas'
ON CONFLICT DO NOTHING;
INSERT INTO tutor_materia (idTutor, idMateria)
SELECT 't54321', id FROM materias WHERE nombre = 'Estructuras de Datos'
ON CONFLICT DO NOTHING;
INSERT INTO tutor_materia (idTutor, idMateria)
SELECT 't09876', id FROM materias WHERE nombre = 'Cálculo Multivariable'
ON CONFLICT DO NOTHING;
