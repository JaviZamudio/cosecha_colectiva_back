const db = require('../../config/database');
import { campos_incompletos, Fecha_actual, generarCodigoValido, existe_grupo, existe_socio, socio_en_grupo } from '../funciones_js/validaciones';

// Funcion para creacion de grupos
export const crear_grupo = async (req, res, next) => {
    const id_socio_actual = req.id_socio_actual;
    // Recoger los datos del body
    const campos_grupo = {
        Nombre_grupo: req.body.Nombre_grupo,
        Localidad: req.body.Localidad,
        Municipio: req.body.Municipio,
        Estado: req.body.Estado,
        CP: req.body.CP,
        Pais: req.body.Pais,
        Codigo_grupo: await generarCodigoValido(),
        Fecha_reg: Fecha_actual()
    };

    if (campos_incompletos(campos_grupo)) {
        res.status(400).json({ code: 400, message: 'Campos incompletos' });
    }

    try {
        let query = "INSERT INTO grupos SET ?";
        const rows = await db.query(query, [campos_grupo]);
        // return res.status(201).json({code: 201, message: "Grupo registrado correctamente" });

        req.body.Socio_id = id_socio_actual;
        req.body.Codigo_grupo = campos_grupo.Codigo_grupo;
        next();
    } catch (error) {
        return res.status(500).json({ code: 500, message: 'Error en el servidor' });
    }
}

export const agregar_socio = async (req, res) => {
    const { Socio_id, Codigo_grupo } = req.body;

    if(!Socio_id || !Codigo_grupo){
        return res.status(400).json({ code: 400, message: "Campos incompletos" });
    }

    try{
        let query = "CALL agregar_socio_grupo(?, ?)";
        const {Message, Error} = (await db.query(query, [Socio_id, Codigo_grupo]))[0][0];

        if(Error){
            return res.status(400).json({ code: 400, message: Error })
        }

        return res.status(200).json({ code: 200, message: Message });
    } catch (error){
        return res.status(500).json({ code: 500, message: 'Error en el servidor' });
    }

    // LO DE ABAJO ES SIN PROCEDIMIENTOS ALMACENADOS
    /* if (Socio_id && Codigo_grupo) {
        try {
            // Verificar que existe el grupo y obtener el id del grupo con ese codigo
            const { Grupo_id } = await existe_grupo(Codigo_grupo);

            // Verificar si el socio existe en la bd
            const { } = await existe_socio(Socio_id);

            let query;
            try {
                // verificar que el socio est?? en el grupo
                const { Status } = await socio_en_grupo(Socio_id, Grupo_id); // (Avienta Excepcion)

                // Si el socio est?? en el grupo y est?? inactivo...
                if(Status != 1) try {
                    // Si est?? y est?? inactivo... activarlo
                    query = "UPDATE grupo_socio SET Status = 1 where Socio_id = ? AND Grupo_id = ?";
                    const resultado_update = await db.query(query, [Socio_id, Grupo_id]);
                } catch (error) {
                    return res.status(500).json({ code: 500, message: 'Error en el servidor' });
                }
                
                // Si ya est?? activo... mandar error
                return res.status(400).json({ code: 400, message: "El socio ya est?? en este grupo" });
            } catch (error) { // si el socio no est?? en el grupo
                const campos_grupo_socio = {
                    Tipo_socio: req.body.Creando_grupo != undefined ? "CREADOR" : "SOCIO",
                    Grupo_id,
                    Socio_id
                };
                
                try{
                    query = "INSERT INTO grupo_socio SET ?";
                    const result_insert = await db.query(query, [campos_grupo_socio]);
                } catch (error) {
                    return res.status(500).json({ code: 500, message: 'Error en el servidor' });
                }
            }
            
        } catch (error) {
            return res.status(400).json({ code: 400, message: error })
        }

        return res.status(200).json({ code: 200, message: 'Usuario Agregado al grupo' });
    } */
}