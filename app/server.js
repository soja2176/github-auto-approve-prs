'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const db = require('./src/db');
const scheduler = require('./src/scheduler');
const authRoutes = require('./src/routes/auth');
const apiRoutes = require('./src/routes/api');

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/auth', authRoutes);
app.use('/api', apiRoutes);

const PORT = process.env.PORT || 3000;

async function main() {
  await db.initDb();
  app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
  });
  await scheduler.start();
}

main().catch((err) => {
  console.error('Error iniciando la app:', err);
  process.exit(1);
});
