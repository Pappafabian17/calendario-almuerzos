// Carga el archivo .env (solo en desarrollo local). Debe importarse antes que cualquier módulo que lea process.env.
// En Netlify las variables vienen del panel del sitio y no existe .env.
try { process.loadEnvFile(); } catch { /* sin .env */ }
