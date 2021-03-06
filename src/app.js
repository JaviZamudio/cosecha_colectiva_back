import express from "express";
const cors = require('cors');
const morgan = require("morgan");

import { auth } from "../middelware/auth";
import userRoutes from './routes/users_routes'
import gruposRoutes from './routes/grupos_routes'
import acuerdosRoutes from './routes/acuerdos_routes'
import adminRoutes from './routes/admin_routes'
import multasRoutes from './routes/multas_routes'
import helmet from "helmet";
const sesionesRoutes = require('./routes/sesiones_routes');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended: true}));
app.use(morgan('dev'));
app.use(helmet());

// Rutas publicas
app.use(userRoutes);

// Rutas protegidas
app.use(auth);
app.use(gruposRoutes);
app.use(acuerdosRoutes);
app.use(sesionesRoutes);
app.use(multasRoutes);
app.use(adminRoutes);


export default app