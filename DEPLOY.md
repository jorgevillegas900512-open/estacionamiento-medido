# Publicación gratuita

1. Crear un proyecto gratuito en Supabase.
2. Ejecutar `supabase-schema.sql` en el SQL Editor.
3. Crear un repositorio privado en GitHub y subir esta carpeta.
4. En Render elegir **New Web Service**, conectar el repositorio y seleccionar el plan Free.
5. Agregar las variables `OPERATOR_PASSWORD`, `ADMIN_PASSWORD`, `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.
6. Usar siempre la URL HTTPS de Render.

No publicar nunca la `SUPABASE_SERVICE_ROLE_KEY` en el navegador ni dentro de `index.html`.
