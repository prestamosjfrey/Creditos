-- Promueve el usuario de prueba a administrador.
-- Después de esto, correo@correo.com / password entra como admin a /admin/dashboard.
update public.perfiles
set rol = 'admin'
where email = 'correo@correo.com';
