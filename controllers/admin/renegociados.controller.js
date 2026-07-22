const { supabaseAdmin } = require('../../config/supabase');
const { formatoISO } = require('../../utils/fechas');
const { alcanceDe, scope } = require('../../utils/alcance');

async function mostrarRenegociados(req, res, next) {
  try {
    // Pagos de tipo 'interes' de los préstamos del usuario (o de TODOS si es
    // super admin: alcanceDe devuelve null y scope no filtra).
    const { data: pagosInteres, error } = await scope(supabaseAdmin
      .from('pagos')
      .select(`
        id, monto, fecha_pago, accion, notas, creado_en,
        cuota_id,
        prestamos:prestamo_id!inner(
          id, numero, numero_cuotas, monto_capital, monto_total_a_pagar,
          valor_cuota, frecuencia_pago, fecha_inicio, estado, creado_por,
          perfiles:clientes(nombre_completo, numero_documento, telefono)
        )
      `), 'prestamos.creado_por', alcanceDe(req.usuario))
      .eq('tipo', 'interes')
      .order('creado_en', { ascending: false });
    if (error) throw error;

    // Agrupar por préstamo.
    const porPrestamo = new Map();
    (pagosInteres || []).forEach((p) => {
      const pr = p.prestamos;
      if (!pr) return;
      const pid = pr.id;
      if (!porPrestamo.has(pid)) {
        porPrestamo.set(pid, {
          prestamo: pr,
          numeroPrestamo: pr.numero != null ? `#PR-${String(pr.numero).padStart(5, '0')}` : null,
          eventos: [],
        });
      }
      porPrestamo.get(pid).eventos.push({
        id: p.id,
        fecha: p.fecha_pago,
        monto: Number(p.monto),
        accion: p.accion,
        notas: p.notas,
      });
    });

    // Stats globales.
    const grupos = Array.from(porPrestamo.values());
    const totalExtensiones = grupos.reduce((a, g) => a + g.eventos.filter((e) => e.accion === 'extension').length, 0);
    const totalSaldo = grupos.reduce((a, g) => a + g.eventos.filter((e) => e.accion === 'saldo').length, 0);

    res.render('admin/renegociados/index', {
      titulo: 'Créditos renegociados',
      grupos,
      stats: {
        totalCreditos: grupos.length,
        totalExtensiones,
        totalSaldo,
        totalEventos: (pagosInteres || []).length,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarRenegociados };
