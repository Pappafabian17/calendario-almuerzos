# Calendario de almuerzos para los misioneros

Frontend estático (`public/`) + API en una Netlify Function (`netlify/functions/api.mjs`) + base de datos Turso (SQLite alojado, gratis).

## Desarrollo local
```
npm install
copy .env.example .env     # y edita ADMIN_PASSWORD
npm start                  # http://localhost:3000 (usa el archivo almuerzos.db)
```

## Desplegar (todo en Netlify)
1. **Base de datos (Turso)**: crea una cuenta en https://turso.tech, luego:
   ```
   turso db create almuerzos
   turso db show almuerzos --url          # -> DATABASE_URL (libsql://...)
   turso db tokens create almuerzos       # -> DATABASE_AUTH_TOKEN
   ```
   (Las tablas se crean solas la primera vez.)
2. **Sube el proyecto a GitHub** y en Netlify: *Add new site → Import from Git*. No hace falta comando de build; `netlify.toml` ya define `public/` y las funciones.
3. En Netlify → *Site configuration → Environment variables* agrega:
   `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `ADMIN_PASSWORD`, `TIMEZONE` (ej. `America/Mexico_City`).
4. Haz *Deploy*.

## Roles
Se entra con «Acceso» y un código. Sin código, cualquiera puede anotarse.

| Rol | Cómo entra | Qué puede hacer |
|---|---|---|
| Libre | sin código | Ver el calendario de cualquier barrio, anotarse (almuerzo o cena, en casa o vianda para retirar); no puede editar ni eliminar |
| Misioneros | código de misioneros del barrio | Además ve teléfono, dirección y mapa de las familias de su barrio |
| Líder | código de líder del barrio | Lo anterior + editar y eliminar registros, bloquear días, cargar/quitar misioneros de su barrio y recordar por WhatsApp |
| Administrador | `ADMIN_PASSWORD` | Todo, incluido crear/editar/eliminar barrios y sus códigos, y editar el título y los horarios |

Primer uso: entra con la contraseña de administrador → «Gestión» → crea los barrios (con sus dos códigos) → carga los misioneros.

## Notas
- La dirección y el mapa (Google Maps) solo los ven los misioneros y líderes del barrio y el administrador.
- Solo un líder del barrio o el administrador pueden editar o eliminar un registro.
