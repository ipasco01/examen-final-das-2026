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
    email VARCHAR(255) UNIQUE NOT NULL,
    especialidad VARCHAR(255)
);

-- Datos de demostración. 'e12345' y 't09876' coinciden con los usuarios de db_auth: la Saga
-- resuelve el perfil contra este servicio usando el id que viene en el JWT emitido por ms-auth.
INSERT INTO estudiantes (id, nombreCompleto, email, carrera) VALUES
('e12345', 'Ana Torres', 'ana.torres@universidad.edu', 'Ingeniería de Software'),
('e67890', 'Luis Garcia', 'luis.garcia@universidad.edu', 'Medicina')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tutores (id, nombreCompleto, email, especialidad) VALUES
('t54321', 'Dr. Carlos Rojas', 'carlos.rojas@universidad.edu', 'Bases de Datos Avanzadas'),
('t09876', 'Dra. Elena Solano', 'elena.solano@universidad.edu', 'Cálculo Multivariable')
ON CONFLICT (id) DO NOTHING;
