import db from "../config/database";
import { Fecha_actual, campos_incompletos, catch_common_error, obtener_sesion_activa, existe_socio, socio_en_grupo } from "../utils/validaciones";
import { actualizar_intereses, agregar_interes_prestamo, calcularSesionesParaAcuerdosFin, calcularSesionesEntreAcuerdos, disminuir_sesiones, obtenerSesionActual, registrar_asistencias } from "../services/Sesiones.services";
import { AdminRequest,SocioRequest } from "../types/misc";
import { camposIncompletos, getCommonError } from "../utils/utils";
import { asignarGananciasSesion } from "../services/Ganancias.services";
import { aws_bucket_name } from "../config/config";
import { s3 } from "../config/aws";
import { RowDataPacket } from "mysql2";

//crear nueva sesion
export const crear_sesion = async (req: AdminRequest<{ Socios: { "Socio_id": number, "Presente": 1 | 0 }[] }>, res) => {
    const Socios = req.body.Socios;
    const Grupo_id = req.id_grupo_actual;

    const campos_sesion = {
        Fecha: Fecha_actual(),
        Caja: null,
        Acciones: null,
        Grupo_id,
        Tipo_sesion: 1
    }

    if (campos_incompletos(campos_sesion)) {
        return res.json({ code: 400, message: 'campos incompletos' }).status(400);
    }

    try {
        //Verificar si es por lo menos el 50% de asistencia
        //extraer numero de socios
        let query_s = "SELECT * FROM grupo_socio WHERE Grupo_id = ? AND Status = 1";
        const [socios_grupo] = await db.query(query_s, [Grupo_id]) as [GrupoSocio[], any];

        //Contar cuantos estan presentes
        let contador_socios = Socios.reduce((acc, socio) => socio.Presente === 1 ? acc + 1 : acc, 0);

        let minimo_asistencia = Math.ceil(socios_grupo.length / 2);
        if (contador_socios < minimo_asistencia) {
            return res.status(400).json({ code: 400, message: 'Necesitas minimo el 50% de la asistencia para iniciar una sesión' });
        }

        // obtener caja Y ACCIONES final de la sesion anterior
        let query = "SELECT Caja, Acciones FROM sesiones WHERE Grupo_id = ? ORDER BY Fecha desc, Sesion_id desc LIMIT 1";
        const [sesiones] = await db.query(query, [Grupo_id]);
        campos_sesion.Caja = sesiones[0] ? sesiones[0].Caja : 0;
        campos_sesion.Acciones = sesiones[0] ? sesiones[0].Acciones : 0;

        // Buscar si existen acuerdos anteriores, si no, enviar sesion 0, Si los encuentra enviar 1 y si los encuentra pero ya paso la fecha enviar 2
        query = "SELECT * FROM acuerdos WHERE Grupo_id = ? AND Status = 1";
        const [acuerdos] = await db.query(query, [Grupo_id]) as [Acuerdo[], any];
        let hoy = new Date(Date.now());
        // let tipo_sesion = (acuerdos[0].Fecha_acuerdos_fin < hoy) ? 1 : ((acuerdos[0].Fecha_acuerdos_fin >= hoy) ? 2 : 0);
        // let fechaFinAcuerdos = acuerdos[0].Fecha_acuerdos_fin || undefined
        let tipo_sesion = acuerdos.length === 0 ? 0 : ((new Date(acuerdos[0].Fecha_acuerdos_fin) < hoy) ? 1 : 2);

        // desactivar todas las sesiones que puedan estar activas para ese grupo
        query = "Update sesiones set Activa = 0 where Grupo_id = ?";
        await db.query(query, Grupo_id);

        campos_sesion.Tipo_sesion = tipo_sesion;
        // crear la nueva sesion
        query = "INSERT INTO sesiones SET ?";
        await db.query(query, campos_sesion);

        await registrar_asistencias(Grupo_id, Socios);
        let sesionesRestantes = null;
        if (tipo_sesion !== 0) {
            await disminuir_sesiones(Grupo_id!);
            await actualizar_intereses(Grupo_id!);
            await agregar_interes_prestamo(Grupo_id!);


            // Ver si hay que mandar sesiones restantes (porcentaje de sesiones restantes >= 70%)
            const sesionesEntreAcuerdos = await calcularSesionesEntreAcuerdos(Grupo_id!); // 10, por ejemplo
            let sesionesRestantes: number | undefined = await calcularSesionesParaAcuerdosFin(Grupo_id!); // 8, por ejemplo
            // Resetear sesiones restantes si se cumple la condicion (para no mandarlo)
            if (sesionesRestantes / sesionesEntreAcuerdos > 0.8) {
                sesionesRestantes = undefined;
            }
        }

        return res.json({ code: 200, message: 'Sesion creada y asistencias registradas', sesionType: tipo_sesion, Sesiones_restantes: sesionesRestantes }).status(200);
    } catch (error) {
        console.log(error);
        const { code, message } = catch_common_error(error);
        return res.json({ code, message }).status(code);
    }
}

//Obtener inasistencias de la sesion
export const enviar_inasistencias_sesion = async (req, res) => {
    const Grupo_id = req.id_grupo_actual;

    //comprobar que haya Sesion_id y Socios
    if (!Grupo_id) {
        return res.json({ code: 400, message: 'Campos incompletos' }).status(400);
    }

    // Validar si la sesion existe y tiene permiso
    try {
        const sesion = await obtener_sesion_activa(Grupo_id);

        let query = "SELECT socios.Nombres, socios.Apellidos, socios.Socio_id FROM asistencias JOIN socios ON asistencias.Socio_id = socios.Socio_id WHERE asistencias.Presente = 0 AND asistencias.Sesion_id = ?";
        const [inasistencias] = (await db.query(query, [sesion.Sesion_id]));

        return res.json({ code: 200, message: 'Inasistencias obtenidas', data: inasistencias }).status(200);
    } catch (error) {
        const { code, message } = catch_common_error(error);
        return res.json({ code, message }).status(code);
    }
}

//Registrar retardos
export const registrar_retardos = async (req, res) => {
    const Grupo_id = req.id_grupo_actual;
    const { Socios } = req.body;

    //comprobar que haya Sesion_id y Socios
    if (!Grupo_id || !Socios) {
        console.log(Grupo_id, Socios);
        // campos incompletos
        return res.json({ code: 400, message: 'Campos incompletos' }).status(400);
    }

    try {
        // VERIFICACIONES
        // Verificar que la sesion existe
        const sesion = await obtener_sesion_activa(Grupo_id);

        //registrar Retardos
        const retardos_con_error: { Socio_id: number, error: string }[] = [];
        for (let i = 0; i < Socios.length; i++) {
            try {
                // Verificar que el socio existe
                const socio = await existe_socio(Socios[i]);
                // Verificar que el socio pertenezca al grupo
                await socio_en_grupo(socio.Socio_id, Grupo_id);
                // INSERCION
                let query = "UPDATE asistencias SET Presente = 2 WHERE Sesion_id = ? AND Socio_id = ? AND Presente != 1";
                const [upd] = await db.query(query, [sesion.Sesion_id, Socios[i]]);
                const json: any = upd;
                if (json.affectedRows === 0) {
                    retardos_con_error.push({
                        Socio_id: Socios[i],
                        error: 'Ya tiene asistencia'
                    });
                }
            } catch (error) {
                const { message } = catch_common_error(error)
                retardos_con_error.push({
                    Socio_id: Socios[i],
                    error: message
                });
            }
        }

        if (retardos_con_error.length > 0) {
            return res.json({ code: 400, message: 'Retardos con error', data: retardos_con_error }).status(400);
        }

        return res.json({ code: 200, message: 'Retardos registrados' }).status(200);
    } catch (error) {
        const { code, message } = catch_common_error(error);
        return res.json({ code, message }).status(code);
    }
}

export const finalizar_sesion = async (req: AdminRequest<any>, res) => {
    // TODO: Subir las imagenes de las firmas de los socios a AWS S3

    const { id_grupo_actual } = req;
    // const { Lugar, Fecha } = req.body;

    const con = await db.getConnection();
    try {
        await con.beginTransaction();

        const sesionActual = await obtenerSesionActual(id_grupo_actual!);

        // let query = "UPDATE sesiones SET Lugar_prox_reunion = ?, Fecha_prox_reunion = ?, Activa = 0 WHERE Sesion_id = ?";
        // await con.query(query, [Lugar, Fecha, sesionActual.Sesion_id]);

        asignarGananciasSesion(id_grupo_actual!, { sesionActual }, con);

        await con.commit();

        return res.status(200).json({ code: 200, message: 'Sesion finalizada' });

    } catch (error) {
        await con.rollback();

        const { code, message } = getCommonError(error);
        return res.json({ code, message }).status(code);
    } finally {
        con.release();
    }
}

export const agendar_sesion = async (req, res) => {
    const Grupo_id = req.id_grupo_actual;
    const Lugar = req.body.Lugar;
    const FechaHora = req.body.FechaHora;

    try {
        if (camposIncompletos({ Lugar, FechaHora })) {
            return res.json({ code: 400, message: 'campos incompletos' }).status(400);
        }
        let sesion = await obtenerSesionActual(Grupo_id);
        let query = "UPDATE sesiones SET Fecha_prox_reunion = ?, Lugar_prox_reunion = ? WHERE Sesion_id = ?";
        await db.query(query, [FechaHora, Lugar, sesion.Sesion_id]);
        return res.json({ code: 200, message: 'Sesión agendada' }).status(200);
    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.json({ code, message }).status(code);
    }
}

export const get_lista_socios = async (req, res) => {
    const Grupo_id = req.params.Grupo_id
    const {type} = req.query
    try {
        let sesion 
        if(type!='asistencia'){
            sesion = await obtener_sesion_activa(Grupo_id);
        }
        console.log(sesion)
        let query 
        let data
        switch(type){
            case 'asistencia':
                query = "SELECT socios.Socio_id, socios.Nombres, socios.Apellidos FROM grupo_socio INNER JOIN socios ON grupo_socio.Socio_id = socios.Socio_id WHERE grupo_socio.Grupo_id = ? AND grupo_socio.Status = 1";
                data = await db.query(query, Grupo_id);
                break
            case 'firma':
                query = `SELECT socios.Socio_id,socios.Nombres,socios.Apellidos,asistencias.Presente 
                FROM asistencias
                INNER JOIN socios ON socios.Socio_id = asistencias.Socio_id
                WHERE asistencias.Presente != 0 AND asistencias.Sesion_id = ?`
                data = await db.query(query, sesion.Sesion_id);
                break
            case 'prestamos':
                let acuerdoVigenteQuery = "SELECT Acuerdo_id FROM acuerdos WHERE Grupo_id=? AND STATUS = 1"
                const [acuerdoVigente] = await db.query(acuerdoVigenteQuery, [Grupo_id]);

                console.log(acuerdoVigente[0])

                query = `SELECT DISTINCT prestamos.Socio_id,socios.Nombres,socios.Apellidos
                from grupo_socio 
                JOIN prestamos ON grupo_socio.Socio_id = prestamos.Socio_id
                JOIN socios ON grupo_socio.Socio_id = socios.Socio_id
                WHERE grupo_socio.Grupo_id = ? AND grupo_socio.Status = 1 AND prestamos.Estatus_prestamo = 0`
                data = await db.query(query, Grupo_id);
                break
            case 'multas':
                query = `SELECT DISTINCT multas.Socio_id,socios.Nombres,socios.Apellidos
                from grupo_socio 
                JOIN multas ON grupo_socio.Socio_id = multas.Socio_id
                JOIN socios ON grupo_socio.Socio_id = socios.Socio_id
                WHERE grupo_socio.Grupo_id = ? AND grupo_socio.Status = 1 AND multas.Status = 0`
                data = await db.query(query, Grupo_id);
                break
            default:
                query = "SELECT socios.Socio_id, socios.Nombres, socios.Apellidos FROM grupo_socio INNER JOIN socios ON grupo_socio.Socio_id = socios.Socio_id WHERE grupo_socio.Grupo_id = ? AND grupo_socio.Status = 1";
                data = await db.query(query, Grupo_id);
            break
        }
        // console.log(data[0])

        return res.json({ code: 200, data: data[0], }).status(200);
        //preguntar si el status al final funciona o tiene que ser al principio
    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.json({ code, message }).status(code);
    }
}

export const get_conteo_dinero = async (req, res) => {
    const Grupo_id = req.params.Grupo_id
    if (!Grupo_id) {
        return res.json({ code: 400, message: 'Campos incompletos' }).status(400);
    }
    try {
        let sesion = await obtenerSesionActual(Grupo_id);
        sesion.Caja = redondearA(sesion.Caja);
        return res.json({ code: 200, data: sesion.Caja, }).status(200);
        //preguntar si el status al final funciona o tiene que ser al principio
    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.json({ code, message }).status(code);
    }
}

function redondearA(value: any) {
    const parteDecimal = value - Math.floor(value);

  if (parteDecimal < 0.24) {
    return Math.floor(value); // Redondear hacia abajo
  } else if (parteDecimal >= 0.24 && parteDecimal <= 0.50) {
    return Math.floor(value) + 0.25; // Redondear a 0.25
  } else if (parteDecimal > 0.50 && parteDecimal < 0.75) {
    return Math.floor(value) + 0.50; // Redondear a 0.50
  } else {
    return Math.ceil(value); // Redondear hacia arriba
  }
  }

export const get_sesiones_grupo = async (req: AdminRequest<Grupo>, res) => {
    const Grupo_id = req.id_grupo_actual;
    const Socio_id = req.id_socio_actual;

    try {
        let query = "SELECT Nombre_grupo FROM grupos WHERE Grupo_id = ?";
        const [nombre] = await db.query(query, Grupo_id);


        let query2 = `
        SELECT A.Sesion_id, A.Fecha, A.Tipo_sesion, B.Presente
        FROM sesiones A
        INNER JOIN asistencias B ON A.Sesion_id = B.Sesion_id AND B.Socio_id = ?
        WHERE A.Grupo_id = ? ORDER BY A.Fecha DESC`;
        const [sesiones] = await db.query(query2,[Socio_id, Grupo_id]);
        
        console.log(Grupo_id,Socio_id)



        let query3 = "SELECT acciones FROM grupo_socio WHERE Grupo_id = ? AND Socio_id = ?";
        const [acciones] = await db.query(query3, [Grupo_id, Socio_id]);
        let query4 = "SELECT SUM(Monto_prestamo) as suma FROM prestamos JOIN sesiones ON prestamos.Sesion_id = sesiones.Sesion_id WHERE Socio_id = ? AND Grupo_id = ? AND Estatus_prestamo = 0";
        const [prestamos] = await db.query(query4, [Socio_id, Grupo_id]);
        let query5 = "SELECT SUM(Monto_multa) as suma FROM multas JOIN sesiones ON multas.Sesion_id = sesiones.Sesion_id WHERE Socio_id = ? AND Grupo_id = ? AND Status = 0";
        const [multas] = await db.query(query5, [Socio_id, Grupo_id]);
        
        let query6 = "SELECT SUM(Monto_ganancia) as gananciasAcumuladas FROM ganancias JOIN sesiones ON ganancias.Sesion_id = sesiones.Sesion_id WHERE Socio_id = ? AND sesiones.Grupo_id = ?  AND ganancias.Entregada = 0";
        const [ganancias] = await db.query(query6, [Socio_id, Grupo_id]);
        let gananciasAcumuladas = 0
        if(ganancias[0].gananciasAcumuladas!=null){
            gananciasAcumuladas = ganancias[0].gananciasAcumuladas
        }

        let query7 = "SELECT Tipo_socio, Status FROM grupo_socio WHERE Socio_id = ? AND Grupo_id = ?";
        const [usuario] = await db.query(query7, [Socio_id, Grupo_id]);
        let query8 = "SELECT asistencias.Presente, sesiones.Tipo_sesion FROM asistencias JOIN sesiones ON sesiones.Sesion_id = asistencias.Sesion_id WHERE asistencias.Socio_id = ? AND sesiones.Grupo_id = ?";
        const [sesion] = await db.query(query8, [Socio_id, Grupo_id]);

        let acuerdoVigenteQuery = "SELECT Acuerdo_id FROM acuerdos WHERE Grupo_id=? AND STATUS = 1"
        const [acuerdoVigente] = await db.query(acuerdoVigenteQuery, [Grupo_id]);

        // que tal que no hay acuerdo vigente, se rompe lo demas? o devuelve nulls
        // console.log(acuerdoVigente[0].Acuerdo_id)
        let proxAdeudo 
        if(typeof(acuerdoVigente[0])!='undefined'){
            let prestamoProximoVencerQuery = 'SELECT Fecha_final,Monto_prestamo FROM prestamos WHERE Socio_id = ? AND Estatus_prestamo=0 AND Acuerdos_id=? ORDER BY Fecha_final ASC LIMIT 1'
            let [proxAd] = await db.query(prestamoProximoVencerQuery, [Socio_id,acuerdoVigente[0].Acuerdo_id]);
            proxAdeudo = proxAd
        } 

        return res.status(200).json({ code: 200, message: 'Sesiones obtenidas', 
        nombreDelGrupo: nombre, 
        sesiones: sesiones, 
        dineroTotalAhorrado: acciones[0].acciones, 
        dineroTotalDeuda: multas[0].suma + prestamos[0].suma , 
        gananciasAcumuladas, 
        rol: usuario[0].Tipo_socio, 
        // status: usuario[0].Status, 
        // paseLista: sesion[0].Presente,
        // Tipo_sesion: sesion[0].Tipo_sesion,
        proxAdeudo});
    } catch (error) {
        console.log(error);
        const { code, message } = getCommonError(error);
        return res.status(code).json({ code, message });
    }
}

/**
 * Funcion para obtener la imagen de la firma desde el front y subirla a AWS S3
 * @param req 
 * @param res 
 */
export const recoger_firma = async (req, res) => {
    const { id_grupo_actual } = req;
    const { Socio_id } = req.params;
    const { Firma }: { Firma: string } = req.body

    try {
        // Verificar que el socio existe
        const socio = await existe_socio(Socio_id);
        // Verificar que el socio pertenezca al grupo
        await socio_en_grupo(socio.Socio_id, id_grupo_actual!);

        // Verificar que la sesion existe
        const sesionActual = await obtenerSesionActual(id_grupo_actual!);

        const params: any & { Body?: any } = {
            Bucket: aws_bucket_name,
            Key: `firmas/${sesionActual.Sesion_id}/${socio.Socio_id}.png`,
            Body: Firma,
        }

        await s3.upload(params).promise().then((data) => {
            console.log(data);
        }).then(() => {
            // getObject
            delete params.Body;
            s3.getObject(params, (err, data) => {
                if (err) throw err;
                console.log(data);
                console.log(data.Body?.toString());
            });
        })

        // La imagen es una imagen png codificada como base 64, por lo que hay que decodificarla
        // Pegar el texto completo Aqui: https://base64.guru/converter/decode/image

        // en la tabla asistencias, en la fila del socio y la sesion actual, poner la direccion de la firma para poder acceder a ella
        let query = "UPDATE asistencias SET Firma = ? WHERE Socio_id = ? AND Sesion_id = ?";
        await db.query(query, [params.Key, Socio_id, sesionActual.Sesion_id]);

        return res.json({ code: 200, message: 'Firma subida' }).status(200);
    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.json({ code, message }).status(code);
    }
}

export const get_firma = async (req: SocioRequest<any>, res) => {
    const { id_socio_actual } = req;
    const { Sesion_id,Grupo_id } = req.params;
    let query2 = "SELECT Fecha FROM sesiones WHERE Sesion_id = ?";
    const [fecha] = await db.query(query2, Sesion_id);
    try {
        // Verificar que el socio existe
        const socio = await existe_socio(id_socio_actual);
        // Verificar que el socio pertenezca al grupo
        await socio_en_grupo(socio.Socio_id, Grupo_id!);
        const params: any = {
            Bucket: aws_bucket_name,
            Key: `firmas/${Sesion_id}/${id_socio_actual}.png`,
        }

        const data = await s3.getObject(params).promise();
        // console.log(data);
        // console.log(data.Body?.toString());
        //Devolver la Fecha
       

        return res.json({ fecha:fecha[0].Fecha, data: data.Body?.toString(),code:200 }).status(200);
    } catch (error: unknown) {
        
        const { code, message } = getCommonError(error);
        return res.json({ code, fecha:fecha[0].Fecha }).status(code);
    } 
}

// Resumen de sesion:
/**
 * Caja_inicial: caja de la sesion anterior ✅
 * Caja_final: caja de la sesion actual ✅
 * Pago_multas: suma de las multas pagadas en la sesion actual ✅
 * Pago_prestamos: suma de los prestamos pagados en la sesion actual ✅
 * Compra_acciones: suma de las acciones compradas en la sesion actual ✅
 * Total_entradas: suma de las entradas de dinero en la sesion actual (Pago_multas + Pago_prestamos + Compra_acciones) - pendiente
 * Prestamos_dados: suma de los prestamos dados en la sesion actual ✅
 * Acciones_vendidas: suma de las acciones vendidas en la sesion actual ✅
 * Total_salidas: suma de las salidas de dinero en la sesion actual (Prestamos_dados + Acciones_vendidas) - pendiente
 */
export const resumen_sesion = async (req: AdminRequest<{}>, res) => {
    const { id_grupo_actual } = req;
    try {
        const sesionActual = await obtenerSesionActual(id_grupo_actual!);

        // Calcular el total de acciones retiradas en la sesion por medio de las transacciones
        // catalogo_id = 'RETIRO_ACCION', obtener la suma de transaccion.Cantidad_movimiento
        // query = `
        // SELECT SUM(transacciones.Cantidad_movimiento) as accionesRetiradas
        // FROM transacciones
        // where transacciones.Socio_id = ?
        // AND transacciones.Catalogo_id = 'RETIRO_ACCION'
        // AND transacciones.Sesion_id = ?
        // `;
        // const { accionesRetiradas } = (await db.query<RowDataPacket[]>(query, [Socio_id, sesionActual.Sesion_id]))[0][0];

        // Caja_inicial: caja de la sesion anterior
        let Caja_inicial = 0;
        try{
            let query = "SELECT Caja from sesiones WHERE Grupo_id = ? AND Activa = 0 ORDER BY Fecha desc, Sesion_id desc LIMIT 1";
            const { Caja: query_res } = (await db.query<RowDataPacket[]>(query, [id_grupo_actual]))[0][0];
            Caja_inicial = query_res
        }catch{
            //se queda la caja en 0
        }
        
        // Caja_final: caja de la sesion actual
        const { Caja: Caja_final } = sesionActual;

        let query = `
        SELECT 
            SUM(CASE WHEN transacciones.Catalogo_id = 'PAGO_MULTA' THEN transacciones.Cantidad_movimiento ELSE 0 END) AS Pago_multas,
            SUM(CASE WHEN transacciones.Catalogo_id = 'ABONO_PRESTAMO' THEN transacciones.Cantidad_movimiento ELSE 0 END) AS Pago_prestamos,
            SUM(CASE WHEN transacciones.Catalogo_id = 'COMPRA_ACCION' THEN transacciones.Cantidad_movimiento ELSE 0 END) AS Compra_acciones,
            Abs(SUM(CASE WHEN transacciones.Catalogo_id = 'ENTREGA_PRESTAMO' THEN transacciones.Cantidad_movimiento ELSE 0 END)) AS Prestamos_dados,
            SUM(CASE WHEN transacciones.Catalogo_id = 'RETIRO_ACCION' THEN transacciones.Cantidad_movimiento ELSE 0 END) AS Acciones_vendidas
        FROM 
            transacciones
        WHERE 
            transacciones.Sesion_id = ?
        `;
        let { Pago_multas, Pago_prestamos, Compra_acciones, Prestamos_dados, Acciones_vendidas } = (await db.query<RowDataPacket[]>(query, [sesionActual.Sesion_id]))[0][0];

        // Total_entradas: suma de las entradas de dinero en la sesion actual (Pago_multas + Pago_prestamos + Compra_acciones)
        const Total_entradas = Pago_multas + Pago_prestamos + Compra_acciones;

        // Total_salidas: suma de las salidas de dinero en la sesion actual (Prestamos_dados + Acciones_vendidas)
        const Total_salidas = Prestamos_dados + Acciones_vendidas;

        if(Acciones_vendidas==null){
            Acciones_vendidas = 0;
        }

        return res.json({ code: 200, message: 'Resumen de sesion obtenido', data: { Caja_inicial, Caja_final, Pago_multas, Pago_prestamos, Compra_acciones, Total_entradas, Prestamos_dados, Acciones_vendidas, Total_salidas } }).status(200);

    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.json({ code, message }).status(code);
    }
}

export const observacion_sesion_socio = async (req: AdminRequest<{ Observacion: string }>, res) => {
    const { Socio_id } = req.params;
    const { id_grupo_actual } = req;
    const { Observacion } = req.body;

    try {
        const sesionActual = await obtenerSesionActual(id_grupo_actual!);


        let query = "UPDATE asistencias SET Observaciones = ? WHERE Socio_id = ? AND Sesion_id = ?";
        const result = await db.query(query, [Observacion, Socio_id, sesionActual.Sesion_id]);

        // console.log(`Actualizando observacion de sesion de socio ${Socio_id} en sesion ${sesionActual.Sesion_id} a ${Observacion}`)

        return res.json({ code: 200, message: 'Firma subida' }).status(200);
    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.json({ code, message }).status(code);
    }
}


export const obtener_observacion_sesion_socio = async (req: AdminRequest<{ Observacion: string }>, res) => {
    const { Socio_id } = req.params;
    const { id_grupo_actual } = req;
    try {
        const sesionActual = await obtenerSesionActual(id_grupo_actual!);

        let observaciones_query = "SELECT Observaciones FROM asistencias WHERE Socio_id = ? AND Sesion_id = ?";
        const [observaciones] = await db.query(observaciones_query, [Socio_id, sesionActual.Sesion_id]);

        return res.json({ observaciones:observaciones[0].Observaciones }).status(200);
    } catch (error) {
        const { code, message } = getCommonError(error);
        return res.json({ code, message }).status(code);
    }
}