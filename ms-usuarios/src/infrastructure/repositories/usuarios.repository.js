// src/infrastructure/repositories/usuarios.repository.js

// --- Base de Datos Simulada (en memoria) ---
// const estudiantesDB = [
//     { id: "e12345", nombreCompleto: "Ana Torres", email: "ana.torres@universidad.edu", carrera: "Ingeniería de Software" },
//     { id: "e67890", nombreCompleto: "Luis Garcia", email: "luis.garcia@universidad.edu", carrera: "Medicina" }
// ];

// const tutoresDB = [
//     { id: "t54321", nombreCompleto: "Dr. Carlos Rojas", email: "carlos.rojas@universidad.edu", especialidad: "Bases de Datos Avanzadas" },
//     { id: "t09876", nombreCompleto: "Dra. Elena Solano", email: "elena.solano@universidad.edu", especialidad: "Cálculo Multivariable" }
// ];
// // ---------------------------------------------

// const findEstudianteById = async (id) => {
//     return estudiantesDB.find(estudiante => estudiante.id === id);
// };

// const findTutorById = async (id) => {
//     return tutoresDB.find(tutor => tutor.id === id);
// };

// module.exports = {
//     findEstudianteById,
//     findTutorById
// };

// ms-usuarios/src/infrastructure/repositories/usuarios.repository.js
const db = require('../../config/db'); // Importa la configuración de la BD

const buildUndefinedTableError = (err) => {
    if (err.code !== '42P01') return err;

    const relationMatch = err.message?.match(/relation "([^"]+)" does not exist/);
    const tableName = err.table || relationMatch?.[1] || 'desconocida';
    const error = new Error(`Base de datos de usuarios no inicializada: falta la tabla ${tableName}. Ejecuta el script SQL de inicialización.`);
    error.statusCode = 500;
    error.code = err.code;
    error.cause = err;
    return error;
};

const findEstudianteById = async (id) => {
    const queryText = 'SELECT * FROM estudiantes WHERE id = $1';
    try {
        const res = await db.query(queryText, [id]);
        return res.rows[0]; // Retorna la primera fila encontrada o undefined
    } catch (err) {
        console.error('Error ejecutando query findEstudianteById:', err.stack);
        throw buildUndefinedTableError(err); // Relanza el error para que lo maneje el servicio/controlador
    }
};

const findTutorById = async (id) => {
    const queryText = 'SELECT * FROM tutores WHERE id = $1';
    try {
        const res = await db.query(queryText, [id]);
        return res.rows[0];
    } catch (err) {
        console.error('Error ejecutando query findTutorById:', err.stack);
        throw buildUndefinedTableError(err);
    }
};

// Listado de tutores. Aditivo: no cambia ninguna consulta existente.
//
// Se seleccionan columnas explicitas en vez de SELECT *, a diferencia de las dos consultas de
// arriba: esto alimenta un desplegable publico, y un SELECT * expondria cualquier columna que se
// agregue a `tutores` en el futuro (telefono, documento, lo que sea) sin que nadie lo decida.
// Buscar por ID devuelve un registro que el llamador ya sabe que pidio; listar es distinto.
//
// Ordenado por especialidad porque asi se muestra en el selector, y un orden estable evita que
// las opciones cambien de lugar entre recargas.
const findAllTutores = async () => {
    const queryText = 'SELECT id, nombreCompleto, especialidad FROM tutores ORDER BY especialidad';
    try {
        const res = await db.query(queryText);
        return res.rows;
    } catch (err) {
        console.error('Error ejecutando query findAllTutores:', err.stack);
        throw buildUndefinedTableError(err);
    }
};

module.exports = {
    findEstudianteById,
    findTutorById,
    findAllTutores
};
