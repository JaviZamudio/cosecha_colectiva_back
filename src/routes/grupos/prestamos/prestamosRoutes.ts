import { Router } from "express";
import { get_prestamos_socio_sesion, pagar_prestamos } from "../../../controllers/prestamos_control";
import { authAdmin, authSocio } from "../../../middleware/auth";
import { authSocioGrupo } from "../../../middleware/auth";

// Router empezando en /api/grupos/prestamos
const router = Router({ mergeParams: true });

// get obtener el historial de un prestamo en una sesion
router.get("/:Prestamo_id/:Sesion_id", authSocioGrupo, get_prestamos_socio_sesion);

// Pagar prestamos
router.patch("/", authAdmin, pagar_prestamos);

// Obtener la información de un usuario sobre sus prestamos en una sesión
router.patch("/", authSocio, get_prestamos_socio_sesion);

export { router as prestamosRoutes };
