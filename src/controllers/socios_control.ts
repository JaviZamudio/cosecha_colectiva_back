import * as bcrypt from "bcrypt";
import { node_env, secret } from "../config/config";
import db from "../config/database";
import { aplanar_respuesta, campos_incompletos, catch_common_error, existe_pregunta, existe_socio, Fecha_actual, validar_password } from "../utils/validaciones";
import * as jwt from "jsonwebtoken";
import { OkPacket, RowDataPacket } from "mysql2";
import { getCommonError, validarCurp, validarFecha } from "../utils/utils";
import { CustomJwtPayload, SocioRequest } from "../types/misc";
import { existeGrupo } from "../services/Grupos.services";
import { PoolConnection } from "mysql2/promise";
import { actualizaPassword, actualizaPreguntaSocio, crearPreguntaSocio, existeSocio, grupos_del_socio, obtenerGrupoSocio, validarPassword, validarPregunta } from "../services/Socios.services";

export const register = async (req, res, next) => {
    // Recoger los datos del body
    const { Pregunta_id, Respuesta } = req.body;

    const campos_usuario = {
        Nombres: req.body.Nombres,
        Apellidos: req.body.Apellidos,
        CURP: req.body.CURP,
        Fecha_nac: req.body.Fecha_nac,
        Nacionalidad: req.body.Nacionalidad,
        Sexo: req.body.Sexo,
        Escolaridad: req.body.Escolaridad,
        Ocupacion: req.body.Ocupacion,
        Estado_civil: req.body.Estado_civil,
        Hijos: req.body.Hijos,
        Telefono: req.body.Telefono,
        Email: req.body.Email,
        Localidad: req.body.Localidad,
        Municipio: req.body.Municipio,
        Estado: req.body.Estado,
        CP: req.body.CP,
        Pais: req.body.Pais,
        Foto_perfil: req.body.Foto_perfil,
        Fecha_reg: Fecha_actual(),
        Username: req.body.Username.toLowerCase(),
        Password: req.body.Password,
    };

    try {
        if (campos_incompletos({ ...campos_usuario, Pregunta_id, Respuesta })) {
            throw { code: 400, message: 'Campos incompletos' };
        }

        //comprobar que el socio no exista
        let query = "SELECT * FROM socios WHERE Username = ?";
        const [rows] = await db.query(query, [campos_usuario.Username]) as [RowDataPacket[], any];

        if (rows.length > 0) {
            throw { code: 400, message: `El nombre de usuario ${campos_usuario.Username} ya existe` };
        }

        //comprobar que el curp sea valido
        if (!validarCurp(campos_usuario.CURP)) {
            throw { code: 400, message: 'El curp no es valido' };
        }

        if(!validarFecha(campos_usuario.Fecha_nac)){
            throw { code: 400, message: 'La fecha de nacimiento no es valida, debe ser aaaa-mm-dd' };
        }

        //comprobar que el curp sea unico
        query = "SELECT * FROM socios WHERE CURP like ?";
        const [curpsIguales] = await db.query(query, [campos_usuario.CURP]) as [RowDataPacket[], any];

        if (curpsIguales.length > 0) {
            throw { code: 400, message: 'El curp ya existe' };
        }

        //encriptar el password
        campos_usuario.Password = bcrypt.hashSync(campos_usuario.Password, 10);

        let con: PoolConnection = {} as PoolConnection;
        try {
            con = await db.getConnection();
            await con.beginTransaction();

            //insertar el socio
            query = "INSERT INTO socios SET ?";
            const [result] = await con.query(query, campos_usuario) as [OkPacket, any];

            //insertar la pregunta
            await crearPreguntaSocio({ Pregunta_id, Respuesta, Socio_id: result.insertId }, con);

            await con.commit();
        } catch (error) {
            await con.rollback();
            throw error;
        } finally {
            con.release();
        }

        return res.status(201).json({ message: 'Socio creado correctamente' });

    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.status(code).json({ code, message });
    }

}

//Funcion para enviar las preguntas de seguridad
export const enviar_preguntas_seguridad = async (req, res) => {
    // TODO: Enviar las preguntas de seguridad
}

export const cambiar_pregunta_seguridad = async (req: SocioRequest<any>, res) => {
    const { id_socio_actual } = req;
    const { Pregunta_id, Respuesta } = req.body;

    try {
        await actualizaPreguntaSocio({
            Pregunta_id,
            Respuesta,
            Socio_id: id_socio_actual!
        });

        return res.status(200).json({ message: 'Pregunta de seguridad actualizada correctamente' });
    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.status(code).json({ code, message });
    }
}

//funcion para login
export const login = async (req, res) => {
    const { Username, Password } = req.body;
    if (Username && Password) {
        let query = "SELECT * FROM socios WHERE Username = ?";
        let [result] = await db.query(query, [Username.toLowerCase()]) as [Socio[], any];

        //validar que existe el usuario
        if (result.length > 0) {
            //validar que la contraseña sea correcta
            if (await validar_password(result[0].Socio_id, Password)) {
                //generar token
                const token = jwt.sign({
                    Username: result[0].Username,
                    Socio_id: result[0].Socio_id
                } as CustomJwtPayload, secret);

                //mandando token por el header
                return res.status(200).json({ code: 200, message: 'Usuario autenticado', token, data: { Socio_id: result[0].Socio_id, Username: result[0].Username } });
            }
            else {
                return res.status(401).json({ code: 400, message: 'Contraseña incorrecta' });
            }
        }
        else {
            //usuario no existe
            return res.status(400).json({ code: 400, message: 'Usuario no existe' });
        }
    } else {
        //campos incompletos
        return res.status(400).json({ code: 400, message: 'Campos incompletos' });
    }
}

// Funcion para cambiar la contraseña
export const cambiar_password = async (req: SocioRequest<any>, res) => {
    const { id_socio_actual } = req;
    const { Password } = req.body;

    if (campos_incompletos({ Password })) {
        return res.status(400).json({ code: 400, message: 'Campos incompletos' });
    }

    try {
        await actualizaPassword(id_socio_actual!, Password);
        return res.status(200).json({ code: 200, message: 'Contraseña actualizada' });
    } catch (error) {
        const { message, code } = getCommonError(error);
        return res.status(code).json({ code, message });
    }
}

//funcion para Recuperar Contraseña
export const recuperar_password = async (req, res) => {
    const { Username, CURP, Pregunta_id, Respuesta, Password } = req.body;

    if (campos_incompletos({ Username, CURP, Pregunta_id, Respuesta, Password })) {
        return res.status(400).json({ code: 400, message: 'Campos incompletos' });
    }

    try {
        //validar que existe el usuario
        const socio = await existe_socio(Username);
        //validar que la pregunta es correcta
        await validarPregunta(socio.Socio_id!, Pregunta_id, Respuesta);
        //validar que la contraseña sea correcta
        await validar_password(socio.Socio_id, Password);

        //cambiar la contraseña
        let query = "UPDATE socios SET Password = ? WHERE Username = ?";
        await db.query(query, [bcrypt.hashSync(Password, 10), Username]);
        return res.status(200).json({ code: 200, message: 'Contraseña cambiada' });
    } catch (error) {
        const { message, code } = getCommonError(error);
        return res.status(code).json({ code, message });
    }
}

// controlador para unirse a grupo
export const unirse_grupo = async (req: SocioRequest<any>, res) => {
    const { id_socio_actual } = req;
    const { Codigo_grupo } = req.body;

    if (campos_incompletos({ Codigo_grupo })) {
        return res.status(400).json({ code: 400, message: "campos incompletos" });
    }

    try {
        // validar que el grupo exista
        const grupo = await existeGrupo(Codigo_grupo);



        let query = "SELECT * FROM grupo_socio WHERE Socio_id = ? AND Grupo_id = ?";
        const [grupo_socio] = await db.query(query, [id_socio_actual, grupo.Grupo_id]) as [GrupoSocio[], any];

        // si el socio no esta en el grupo
        if (grupo_socio.length === 0) {
            const campos_grupo_socio: GrupoSocio = {
                Socio_id: id_socio_actual!,
                Grupo_id: grupo.Grupo_id!,
                Acciones: 0,
                Status: 1,
                Tipo_socio: "SOCIO",
            }

            query = "INSERT INTO grupo_socio SET ?";
            await db.query(query, campos_grupo_socio);
            return res.status(200).json({ code: 200, message: "El socio se ha unido correctamente" });
        }

        // si el socio está inactivo en el grupo
        if (grupo_socio[0].Status === 0) {
            query = "UPDATE grupo_socio SET Status = 1 WHERE Socio_id = ? AND Grupo_id = ?";
            await db.query(query, [id_socio_actual, grupo.Grupo_id]);
            return res.status(200).json({ code: 200, message: "El socio se ha unido correctamente" });
        }

        // si el socio está activo en el grupo
        return res.status(400).json({ code: 400, message: "El socio ya está en el grupo" });
    } catch (error) {
        const { message, code } = catch_common_error(error);
        return res.status(code).json({ code, message });
    }
}

// enviar info del socio actual
export const enviar_info_socio = async (req: SocioRequest<any>, res) => {
    const { id_socio_actual } = req;

    try {
        const socio = await existeSocio(id_socio_actual!);
        const data = {
            Nombres: socio.Nombres,
            Username: socio.Username,
        }
        return res.status(200).json({ code: 200, message: "Información del socio", data });
    } catch (error) {
        const { message, code } = getCommonError(error);
        return res.status(code).json({ code, message });
    }
}

// Enviar info de los grupos del socio actual
export const enviar_grupos_socio = async (req: SocioRequest<any>, res) => {
    const { id_socio_actual } = req;

    try {
        const grupos: Grupo[] = await grupos_del_socio(id_socio_actual!);
        const data: {Grupo_id: number, Nombre: string, Rol_socio: "ADMIN" | "SOCIO" | "SUPLENTE" | "CREADOR"}[] = [];
        for (const grupo of grupos) {
            data.push({
                Grupo_id: grupo.Grupo_id!,
                Nombre: grupo.Nombre_grupo,
                Rol_socio: (await obtenerGrupoSocio(id_socio_actual!, grupo.Grupo_id!)).Tipo_socio,
            });
        }

        return res.status(200).json({ code: 200, message: "Información de los grupos", data });
            
    } catch (error) {
        const { message, code } = getCommonError(error);
        return res.status(code).json({ code, message });
    }
}