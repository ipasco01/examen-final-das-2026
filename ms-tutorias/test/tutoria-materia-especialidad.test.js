// Paso 1b de la Saga: la materia solicitada debe coincidir con alguna de las materias del tutor.
//
// Antes de esta regla, `materia` era texto libre: viajaba del formulario al INSERT y al asunto del
// correo sin que nadie la comprobara. Se podia pedir "Fisica Cuantica" a una tutora cuya
// especialidad es "Calculo Multivariable" y la Saga devolvia CONFIRMADA.
//
// Deuda #14 resuelta: el tutor ya no tiene una unica `especialidad` (VARCHAR libre), sino
// `materias: string[]` resuelto por ms-usuarios contra el catalogo real (tabla `materias` +
// relacion N:M `tutor_materia`). Estos tests migran el mock de `usuariosClient.getUsuario` a esa
// forma y agregan el caso que prueba que el N:M funciona de verdad (un tutor con 2+ materias).
//
// Lo que se verifica aca no es solo el rechazo, sino DONDE ocurre: la validacion va despues de
// resolver al tutor (paso 1) y antes de crear la fila PENDIENTE y bloquear agenda (pasos 3 y 4).
// Por eso el test afirma que repository.save y agendaClient.* NUNCA se invocaron: un rechazo en
// este punto es un `throw` barato, no un rollback distribuido. Si alguien mueve la validacion mas
// abajo el test falla, aunque el 400 se siga devolviendo.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const modulePath = (relativePath) => path.join(ROOT, relativePath);

const servicePath = modulePath('src/domain/services/tutoria.service.js');
const repositoryPath = modulePath('src/infrastructure/repositories/tutoria.repository.js');
const usuariosClientPath = modulePath('src/infrastructure/clients/usuarios.client.js');
const agendaClientPath = modulePath('src/infrastructure/clients/agenda.client.js');
const messageProducerPath = modulePath('src/infrastructure/messaging/message.producer.js');

const clearModule = (filePath) => {
    delete require.cache[require.resolve(filePath)];
};

// Monta el servicio con dobles de prueba y devuelve tambien el registro de efectos colaterales,
// que es lo que permite afirmar que la Saga corto antes de tocar nada.
//
// `materiasTutor` es el array que ms-usuarios devolveria para ese tutor (`[]`/`null`/`undefined`
// representan un tutor sin materias asignadas todavia).
const conServicioMontado = async (materiasTutor, ejecutar) => {
    const efectos = { saves: [], bloqueos: [], cancelaciones: [] };

    const repository = {
        findByIdempotencyKey: async () => null,
        save: async (payload) => {
            efectos.saves.push(payload);
            return { idtutoria: 'tutoria-1', ...payload };
        }
    };

    const usuariosClient = {
        getUsuario: async (tipo) => (
            tipo === 'estudiantes'
                ? { email: 'estudiante@test.local', nombrecompleto: 'Estudiante Test' }
                : { email: 'tutor@test.local', nombrecompleto: 'Tutor Test', materias: materiasTutor }
        )
    };

    const agendaClient = {
        verificarDisponibilidad: async () => { efectos.bloqueos.push('verificar'); return true; },
        bloquearAgenda: async () => { efectos.bloqueos.push('bloquear'); return { idBloqueo: 'b-1' }; },
        cancelarBloqueo: async () => { efectos.cancelaciones.push('cancelar'); }
    };

    const messageProducer = {
        publishToQueue: async () => true,
        publishTrackingEvent: async () => undefined
    };

    for (const filePath of [servicePath, repositoryPath, usuariosClientPath, agendaClientPath, messageProducerPath]) {
        clearModule(filePath);
    }

    require.cache[require.resolve(repositoryPath)] = { exports: repository };
    require.cache[require.resolve(usuariosClientPath)] = { exports: usuariosClient };
    require.cache[require.resolve(agendaClientPath)] = { exports: agendaClient };
    require.cache[require.resolve(messageProducerPath)] = { exports: messageProducer };

    const tutoriaService = require(servicePath);

    const datos = (materia) => ({
        idEstudiante: 'e12345',
        idTutor: 't09876',
        fechaSolicitada: '2027-08-01T10:00:00.000Z',
        duracionMinutos: 60,
        materia
    });

    try {
        await ejecutar({ tutoriaService, datos, efectos });
    } finally {
        clearModule(servicePath);
        for (const filePath of [repositoryPath, usuariosClientPath, agendaClientPath, messageProducerPath]) {
            clearModule(filePath);
        }
    }
};

test('rechaza con 400 una materia que el tutor no dicta, sin crear la tutoria ni tocar agenda', async () => {
    await conServicioMontado(['Cálculo Multivariable'], async ({ tutoriaService, datos, efectos }) => {
        await assert.rejects(
            () => tutoriaService.solicitarTutoria(datos('Física Cuántica'), 'cid-materia-invalida'),
            (error) => {
                assert.equal(error.statusCode, 400);
                assert.match(error.message, /no dicta "Física Cuántica"/);
                assert.match(error.message, /Cálculo Multivariable/);
                return true;
            }
        );

        // El corazon del test: la Saga no llego a ejecutar ningun paso con efectos.
        assert.deepEqual(efectos.saves, [], 'no debe persistirse ninguna tutoria');
        assert.deepEqual(efectos.bloqueos, [], 'no debe consultarse ni bloquearse la agenda');
        assert.deepEqual(efectos.cancelaciones, [], 'no hay nada que compensar');
    });
});

test('acepta la materia correcta ignorando mayusculas, tildes y espacios de mas', async () => {
    for (const variante of ['Cálculo Multivariable', 'calculo multivariable', 'CÁLCULO  MULTIVARIABLE ']) {
        await conServicioMontado(['Cálculo Multivariable'], async ({ tutoriaService, datos, efectos }) => {
            const resultado = await tutoriaService.solicitarTutoria(datos(variante), `cid-${variante}`);
            assert.equal(resultado.estado, 'CONFIRMADA', `"${variante}" deberia aceptarse`);
            assert.equal(efectos.saves.length > 0, true);
        });
    }
});

test('un tutor con varias materias acepta una solicitud de cualquiera de ellas (N:M)', async () => {
    // La prueba directa de que la deuda #14 se resolvio de verdad: un tutor ya no esta limitado a
    // una sola especialidad. Se piden ambas materias en solicitudes separadas y las dos deben
    // confirmarse.
    for (const materiaSolicitada of ['Bases de Datos Avanzadas', 'Estructuras de Datos']) {
        await conServicioMontado(
            ['Bases de Datos Avanzadas', 'Estructuras de Datos'],
            async ({ tutoriaService, datos, efectos }) => {
                const resultado = await tutoriaService.solicitarTutoria(datos(materiaSolicitada), `cid-nm-${materiaSolicitada}`);
                assert.equal(resultado.estado, 'CONFIRMADA', `"${materiaSolicitada}" deberia aceptarse`);
                assert.equal(efectos.saves.length > 0, true);
            }
        );
    }
});

test('un tutor con varias materias rechaza una que no dicta ninguna de las dos', async () => {
    await conServicioMontado(
        ['Bases de Datos Avanzadas', 'Estructuras de Datos'],
        async ({ tutoriaService, datos, efectos }) => {
            await assert.rejects(
                () => tutoriaService.solicitarTutoria(datos('Física Cuántica'), 'cid-nm-invalida'),
                (error) => {
                    assert.equal(error.statusCode, 400);
                    assert.match(error.message, /no dicta "Física Cuántica"/);
                    assert.match(error.message, /Bases de Datos Avanzadas/);
                    assert.match(error.message, /Estructuras de Datos/);
                    return true;
                }
            );
            assert.deepEqual(efectos.saves, [], 'no debe persistirse ninguna tutoria');
        }
    );
});

test('si el tutor no tiene materias cargadas todavia, no se bloquea la solicitud', async () => {
    // Decision deliberada, heredada de la version anterior de esta regla: hay tutores sembrados sin
    // materias asignadas en tutor_materia. Validar contra un catalogo vacio convertiria un hueco de
    // datos en una caida de servicio, asi que se deja pasar.
    await conServicioMontado([], async ({ tutoriaService, datos }) => {
        const resultado = await tutoriaService.solicitarTutoria(datos('Cualquier Cosa'), 'cid-sin-materias');
        assert.equal(resultado.estado, 'CONFIRMADA');
    });
});
