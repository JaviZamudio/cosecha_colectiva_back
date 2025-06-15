import { Response } from "express";
import db from "../config/database";
import { obtenerAcuerdoActual } from "../services/Acuerdos.services";
import { existeGrupo } from "../services/Grupos.services";
import { existeSocio, socioEnGrupo } from "../services/Socios.services";
import { crear_transaccion } from "../services/Transacciones.services";
import { AdminRequest } from "../types/misc";
import { camposIncompletos, getCommonError } from "../utils/utils";

export const registrar_compra_acciones = async (req: AdminRequest<{ Cantidad: number }>, res: Response) => {
    const Grupo_id = Number(req.params.Grupo_id);
    const Socio_id = Number(req.params.Socio_id);
    const { Cantidad } = req.body;

    if (camposIncompletos({ Cantidad })) {
        return res.status(400).json
    }

    let con = await db.getConnection();
    try {
        // Validar que el socio exista
        const socio = await existeSocio(Socio_id);
        // Validar que el grupo exista
        const grupo = await existeGrupo(Grupo_id);
        // Validar que el socio pertenezca al grupo
        await socioEnGrupo(Socio_id, Grupo_id);

        // Agregar la accion a la relacion socio-grupo
        let query = "UPDATE grupo_socio SET acciones = acciones + ? WHERE Socio_id = ? AND Grupo_id = ?";
        await con.query(query, [Cantidad, Socio_id, Grupo_id]);

        // Actualizar la cantidad de acciones del grupo en la sesion
        query = `UPDATE sesiones
        SET Acciones = Acciones + ?
        WHERE Grupo_id = ?
        AND Activa = 1`;
        await con.query(query, [Cantidad, Grupo_id]);

        // Registrar la transaccion
        await crear_transaccion({
            Cantidad_movimiento: Cantidad,
            Catalogo_id: "COMPRA_ACCION",
            Socio_id,
            Grupo_id,
        }, con);

        con.commit();
        return res.status(201).json({ code: 201, message: "Acciones compradas" });
    } catch (error) {
        con.rollback();
        const { code, message } = getCommonError(error);
        return res.status(code).json({ code, message });
    } finally {
        con.release();
    }
}

export const enviar_costo_acciones = async (req: AdminRequest<any>, res: Response) => {
    const Grupo_id = Number(req.params.Grupo_id);

    try {
        const acuerdoActual = await obtenerAcuerdoActual(Grupo_id);
        return res.status(200).json({ code: 200, message: "Costo de acciones", data: {Costo: acuerdoActual.Costo_acciones} });
    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.status(code).json({ code, message });        
    }
}

export const registrar_retiro_acciones = async (req: AdminRequest<{ Cantidad: number }>, res: Response) => {
    const Grupo_id = req.id_grupo_actual;
    const Socio_id = req.params.Socio_id;
    const { Cantidad } = req.body; // Cantidad en dinero de las acciones a retirar

    if (camposIncompletos({ Cantidad })) {
        return res.status(400).json
    }

    // TODO: Validaciones
    // TODO: Registro de operacion
}

export const obtener_acciones_socio = async (req: AdminRequest<any>, res: Response) => {
    const id_grupo_actual = req.id_grupo_actual;
    const Socio_id = Number(req.params.Socio_id);

    try {
        await socioEnGrupo(Socio_id, id_grupo_actual!);
        const query = `SELECT * FROM grupo_socio WHERE Socio_id = ? AND Grupo_id = ?`;
        const [grupo_socios] = await db.query(query, [Socio_id, id_grupo_actual]) as [GrupoSocio[], any];

        return res.status(200).json({ code: 200, message: "Acciones del socio", data: { Acciones: grupo_socios[0].Acciones } });
    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.status(code).json({ code, message });
    }
}