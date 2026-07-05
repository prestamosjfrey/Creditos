const { supabaseAdmin } = require('../../config/supabase');

async function mostrarPanel(req, res, next) {
  try {
    const clienteId = req.usuario.id;

    const { data: prestamos, error } = await supabaseAdmin
      .from('vista_cartera')
      .select('*')
      .eq('cliente_id', clienteId);
    if (error) throw error;

    const saldoTotal = prestamos
      .filter((p) => p.estado === 'activo' || p.estado === 'en_mora')
      .reduce((acc, p) => acc + Number(p.saldo_pendiente), 0);

    const { data: proximaCuota } = await supabaseAdmin
      .from('cuotas')
      .select('*, prestamos!inner(cliente_id)')
      .eq('prestamos.cliente_id', clienteId)
      .in('estado', ['pendiente', 'parcial'])
      .order('fecha_vencimiento', { ascending: true })
      .limit(1)
      .maybeSingle();

    // Préstamo "principal" para la tarjeta destacada: el de la próxima cuota,
    // o en su defecto el primer préstamo activo/en mora.
    const idPrincipal =
      proximaCuota?.prestamo_id ||
      prestamos.find((p) => p.estado === 'activo' || p.estado === 'en_mora')?.prestamo_id;

    let prestamoPrincipal = null;
    if (idPrincipal) {
      const resumen = prestamos.find((p) => p.prestamo_id === idPrincipal);
      const { data: detalle } = await supabaseAdmin
        .from('prestamos')
        .select('valor_cuota, frecuencia_pago')
        .eq('id', idPrincipal)
        .single();

      const pctPagado = resumen.monto_total_a_pagar > 0
        ? Math.round((Number(resumen.total_pagado) / Number(resumen.monto_total_a_pagar)) * 100)
        : 0;

      prestamoPrincipal = { ...resumen, ...detalle, pctPagado };
    }

    res.render('cliente/panel', { titulo: 'Mi panel', prestamos, saldoTotal, proximaCuota, prestamoPrincipal });
  } catch (err) {
    next(err);
  }
}

async function mostrarPrestamo(req, res, next) {
  try {
    const { id } = req.params;
    const clienteId = req.usuario.id;

    const { data: prestamo, error } = await supabaseAdmin
      .from('prestamos')
      .select('*')
      .eq('id', id)
      .eq('cliente_id', clienteId) // filtro de seguridad explícito, además de RLS de respaldo
      .single();
    if (error || !prestamo) return res.status(404).render('errores/404');

    const { data: cuotas } = await supabaseAdmin
      .from('cuotas')
      .select('*')
      .eq('prestamo_id', id)
      .order('numero_cuota', { ascending: true });

    const { data: pagos } = await supabaseAdmin
      .from('pagos')
      .select('*')
      .eq('prestamo_id', id)
      .order('fecha_pago', { ascending: false });

    res.render('cliente/prestamo-detalle', { titulo: 'Mi préstamo', prestamo, cuotas, pagos });
  } catch (err) {
    next(err);
  }
}

function mostrarPerfil(req, res) {
  res.render('cliente/perfil', { titulo: 'Mi perfil' });
}

module.exports = { mostrarPanel, mostrarPrestamo, mostrarPerfil };
