# Publicación gratuita sin Render

1. En Supabase, volver a ejecutar `supabase-schema.sql` para aplicar las políticas de seguridad.
2. En Supabase > Authentication > Users, crear dos usuarios con email y contraseña:
   - `operador@cabred.app`
   - `admin@cabred.app`
3. En `supabase-config.js`, reemplazar `PEGAR_PROJECT_URL` y `PEGAR_ANON_KEY` con el Project URL y la clave pública `anon`.
4. En GitHub abrir Settings > Pages, elegir **Deploy from a branch**, branch `main`, carpeta `/ (root)` y guardar.
5. La app quedará disponible en `https://jorgevillegas900512-open.github.io/estacionamiento-medido/`.

La clave `anon` puede estar en el navegador porque las tablas están protegidas por RLS. Nunca publicar la `service_role key`.
