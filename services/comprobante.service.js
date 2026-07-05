const PDFDocument = require('pdfkit');
const { formatCOP } = require('../utils/moneda');

function iniciales(nombre) {
  const p = (nombre || '').trim().split(/\s+/);
  return (((p[0] || '')[0] || '') + ((p[1] || '')[0] || '')).toUpperCase() || '?';
}

// Número de préstamo legible (12 dígitos) derivado del id de forma estable.
function numeroPrestamo(id) {
  const hex = String(id).replace(/[^0-9a-f]/gi, '').slice(0, 15);
  let n = 0n;
  for (const ch of hex) n = n * 16n + BigInt(parseInt(ch, 16));
  return (n % 1000000000000n).toString().padStart(12, '0');
}

const ESTADO_CUOTA = {
  pendiente: 'Pendiente',
  parcial: 'Parcial',
  pagada: 'Pagada',
  vencida: 'Vencida',
};

function fechaLegible(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Reparte el interés total parejo por cuota (la última absorbe el redondeo),
// igual que el cronograma del formulario. Devuelve {capital, interes} por cuota.
function desglosarCuota(prestamo, cuota, indice, total, acumInteres) {
  const interesTotal = Math.max(0, Number(prestamo.monto_total_a_pagar) - Number(prestamo.monto_capital));
  const interesRegular = Math.round(interesTotal / Number(prestamo.numero_cuotas));
  const esUltima = indice === total - 1;
  const interes = esUltima ? Math.round(interesTotal - acumInteres) : interesRegular;
  const capital = Math.round(Number(cuota.monto_esperado) - interes);
  return { capital, interes };
}

// Comprobante / Estado de cuenta del préstamo (PDF dibujado con pdfkit).
function generarComprobantePDF({ prestamo, cuotas, pagos }, stream) {
  const cliente = prestamo.perfiles || {};
  const capital = Number(prestamo.monto_capital);
  const total = Number(prestamo.monto_total_a_pagar);
  const interesTotal = Math.max(0, total - capital);
  const interesPorCuota = Math.round(interesTotal / Number(prestamo.numero_cuotas || 1));
  const capitalPorCuota = Number(prestamo.valor_cuota) - interesPorCuota;
  const pct = capital > 0 ? Math.round((interesTotal / capital) * 100) : 0;
  const pagadas = (cuotas || []).filter((c) => c.estado === 'pagada').length;
  const abonado = (pagos || []).reduce((a, p) => a + Number(p.monto), 0);
  const saldo = total - abonado;

  const ahora = new Date();
  const fechaEmision = ahora.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
  const hora = ahora.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  const fechaCreacion = prestamo.creado_en
    ? new Date(prestamo.creado_en).toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : fechaLegible(prestamo.fecha_inicio);
  // Número de préstamo: consecutivo guardado en BD; respaldo al derivado.
  const numeroMostrar = prestamo.numero != null
    ? String(prestamo.numero).padStart(5, '0')
    : numeroPrestamo(prestamo.id);

  const NAVY = '#0f172a';
  const AZUL = '#2563eb';
  const GRIS = '#94a3b8';
  const L = 36, R = 559;

  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(stream);

  // ---------- ENCABEZADO ----------
  doc.roundedRect(L, 34, 50, 50, 10).fill(NAVY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(26).text('C', L, 47, { width: 50, align: 'center' });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(15).text('Cartera', 96, 42);
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('Gestión de préstamos', 96, 62);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text('ESTADO DE CUENTA', 250, 40);
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('Resumen de tu préstamo', 250, 57);
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('N° de préstamo:', 250, 70, { continued: true });
  doc.fillColor(AZUL).font('Helvetica-Bold').text(' ' + numeroMostrar);
  doc.fillColor(GRIS).font('Helvetica').fontSize(7).text('Fecha de emisión', 430, 38, { width: 129 });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8).text(fechaEmision, 430, 48, { width: 129 });
  doc.fillColor(GRIS).font('Helvetica').fontSize(7).text('Hora', 430, 62, { width: 129 });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8).text(hora, 430, 72, { width: 129 });
  doc.moveTo(L, 96).lineTo(R, 96).lineWidth(1).strokeColor('#e2e8f0').stroke();

  // ---------- TARJETA CLIENTE ----------
  doc.roundedRect(L, 106, 523, 86, 10).lineWidth(0.8).strokeColor('#e2e8f0').stroke();
  doc.circle(70, 142, 22).fill('#dbeafe');
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(15).text(iniciales(cliente.nombre_completo), 48, 134, { width: 44, align: 'center' });

  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(7).text('NOMBRE', 104, 122);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12).text((cliente.nombre_completo || '—') + ' (' + (prestamo.frecuencia_pago || '').toUpperCase() + ')', 104, 132, { width: 230 });
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(7).text('DOCUMENTO', 348, 122);
  doc.fillColor(NAVY).font('Helvetica').fontSize(11).text(cliente.numero_documento || '—', 348, 132);
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(7).text('TELÉFONO', 458, 122);
  doc.fillColor(NAVY).font('Helvetica').fontSize(11).text(cliente.telefono || '—', 458, 132);

  doc.moveTo(52, 164).lineTo(543, 164).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(7).text('DIRECCIÓN', 52, 173);
  doc.fillColor(NAVY).font('Helvetica').fontSize(10).text(cliente.direccion || '—', 120, 172, { width: 420 });

  // ---------- TABLA AZUL ----------
  const tablaY = 206;
  const cols = [
    { t: 'CREACIÓN', w: 70, v: fechaCreacion },
    { t: 'N° CUOTAS', w: 58, v: String(prestamo.numero_cuotas) },
    { t: '%', w: 40, v: pct + '%' },
    { t: 'SOLICITADO', w: 78, v: formatCOP(capital) },
    { t: 'CAPITAL CUOTA', w: 92, v: formatCOP(capitalPorCuota) },
    { t: 'INTERÉS CUOTA', w: 92, v: formatCOP(interesPorCuota) },
    { t: 'VALOR CUOTA', w: 93, v: formatCOP(prestamo.valor_cuota) },
  ];
  doc.rect(L, tablaY, 523, 28).fill(AZUL);
  doc.rect(L, tablaY + 28, 523, 32).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  let cx = L;
  cols.forEach((c) => {
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6.5).text(c.t, cx + 2, tablaY + 9, { width: c.w - 4, align: 'center' });
    doc.fillColor(c.color || NAVY).font('Helvetica-Bold').fontSize(9).text(c.v, cx + 2, tablaY + 28 + 11, { width: c.w - 4, align: 'center' });
    cx += c.w;
  });

  // ---------- PLAN DE PAGO (cronograma) ----------
  let y = 284;
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(11).text('PLAN DE PAGO', L, y);
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('Fecha y valor de cada cuota — paga en la fecha indicada', L, y + 14);
  y += 30;

  const ccols = [
    { t: 'CUOTA', w: 56, a: 'center' },
    { t: 'VENCIMIENTO', w: 135, a: 'left' },
    { t: 'CAPITAL', w: 110, a: 'right' },
    { t: 'INTERÉS', w: 110, a: 'right' },
    { t: 'VALOR CUOTA', w: 112, a: 'right' },
  ];
  function headerCronograma() {
    doc.rect(L, y, 523, 24).fill(AZUL);
    let hx = L;
    ccols.forEach((c) => {
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7).text(c.t, hx + 6, y + 8, { width: c.w - 12, align: c.a });
      hx += c.w;
    });
    y += 24;
  }
  headerCronograma();

  const desglose = calcularDesglose(prestamo);

  (cuotas || []).forEach((c, i) => {
    if (y > 770) { doc.addPage(); y = 40; headerCronograma(); }
    if (i % 2 === 1) doc.rect(L, y, 523, 20).fill('#f8fafc');
    const { capital: cap, interes: intr } = desglose(c);
    const vals = [
      String(c.numero_cuota),
      fechaLegible(c.fecha_vencimiento),
      formatCOP(cap),
      formatCOP(intr),
      formatCOP(c.monto_esperado),
    ];
    let rx = L;
    vals.forEach((v, k) => {
      const col = ccols[k];
      doc.fillColor(NAVY).font('Helvetica').fontSize(8).text(v, rx + 6, y + 6, { width: col.w - 12, align: col.a });
      rx += col.w;
    });
    y += 20;
  });
  y += 14;

  // ---------- IMPORTANTE + PIE ----------
  if (y > 720) { doc.addPage(); y = 40; }
  doc.roundedRect(L, y, 523, 46, 10).fillAndStroke('#eff6ff', '#dbeafe');
  doc.fillColor('#1e40af').font('Helvetica-Bold').fontSize(9).text('Importante', 54, y + 12);
  doc.fillColor('#64748b').font('Helvetica').fontSize(8).text('Conserva este comprobante como respaldo de tu préstamo. Realiza el pago de cada cuota en la fecha de vencimiento indicada.', 54, y + 25, { width: 480 });
  y += 60;
  doc.fillColor(GRIS).font('Helvetica').fontSize(9).text('Gracias por confiar en nosotros', L, y, { width: 523, align: 'center' });

  doc.end();
}

// Devuelve una función que calcula {capital, interes} de una cuota individual
// (reparto parejo, la última absorbe el redondeo).
function calcularDesglose(prestamo) {
  const n = Number(prestamo.numero_cuotas);
  const interesTotal = Math.max(0, Number(prestamo.monto_total_a_pagar) - Number(prestamo.monto_capital));
  const interesRegular = Math.round(interesTotal / n);
  return function (cuota) {
    const esUltima = Number(cuota.numero_cuota) === n;
    const interes = esUltima ? Math.round(interesTotal - interesRegular * (n - 1)) : interesRegular;
    const capital = Math.round(Number(cuota.monto_esperado) - interes);
    return { capital, interes };
  };
}

function encabezado(doc, titulo) {
  doc.fontSize(22).fillColor('#2563EB').text('Cartera', 50, 50);
  doc.fontSize(11).fillColor('#64748b').text(titulo, 50, 78);
  doc.fontSize(9).fillColor('#64748b').text('Generado: ' + new Date().toLocaleString('es-CO'), 50, 50, { align: 'right' });
  doc.moveTo(50, 100).lineTo(545, 100).strokeColor('#e2e8f0').stroke();
}

// Comprobante de pago de UNA cuota.
function generarComprobanteCuotaPDF({ prestamo, cuota }, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(stream);
  const cliente = prestamo.perfiles || {};
  const { capital, interes } = calcularDesglose(prestamo)(cuota);

  encabezado(doc, 'Comprobante de pago — Cuota #' + cuota.numero_cuota);

  let y = 125;
  doc.fontSize(10).fillColor('#64748b').text('Cliente: ', 50, y, { continued: true }).fillColor('#0f172a').text(cliente.nombre_completo || '—');
  doc.fillColor('#64748b').text('Cédula: ', 50, y + 16, { continued: true }).fillColor('#0f172a').text(cliente.numero_documento || '—');

  y += 50;
  const filas = [
    ['Cuota número', String(cuota.numero_cuota)],
    ['Fecha de vencimiento', fechaLegible(cuota.fecha_vencimiento)],
    ['Abono a capital', formatCOP(capital)],
    ['Interés de la cuota', formatCOP(interes)],
    ['Valor de la cuota', formatCOP(cuota.monto_esperado)],
    ['Estado', ESTADO_CUOTA[cuota.estado] || cuota.estado],
    ['Días de atraso al pagar', cuota.dias_atraso === null || cuota.dias_atraso === undefined ? '—' : String(cuota.dias_atraso)],
  ];
  doc.fontSize(11);
  filas.forEach((f, i) => {
    const fy = y + i * 22;
    doc.fillColor('#64748b').text(f[0], 50, fy);
    doc.fillColor('#0f172a').text(f[1], 300, fy);
  });

  y += filas.length * 22 + 30;
  doc.fontSize(8).fillColor('#64748b').text(
    'Comprobante generado por el sistema Cartera con base en los registros del préstamo.',
    50, y, { width: 495, align: 'center' }
  );
  doc.end();
}

// Certificado de Paz y Salvo (préstamo pagado en su totalidad).
function generarPazYSalvoPDF({ prestamo, pagos }, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(stream);
  const cliente = prestamo.perfiles || {};

  const fechas = (pagos || []).map((p) => p.fecha_pago).filter(Boolean).sort();
  const fechaFin = fechas.length ? fechas[fechas.length - 1] : null;

  encabezado(doc, 'Certificado de Paz y Salvo');

  doc.moveDown(4);
  doc.fontSize(26).fillColor('#16a34a').text('PAZ Y SALVO', { align: 'center' });
  doc.moveDown(2);

  doc.fontSize(12).fillColor('#0f172a').text(
    'Se certifica que ' + (cliente.nombre_completo || 'el cliente') +
    (cliente.numero_documento ? ', identificado(a) con cédula ' + cliente.numero_documento + ',' : '') +
    ' ha cumplido en su totalidad con el pago del préstamo registrado en el sistema, ' +
    'por un capital de ' + formatCOP(prestamo.monto_capital) + ' y un total pagado de ' +
    formatCOP(prestamo.monto_total_a_pagar) + ', distribuido en ' + prestamo.numero_cuotas + ' cuotas.',
    { align: 'justify', lineGap: 4 }
  );

  doc.moveDown(1.5);
  doc.text('Por lo anterior, el cliente se encuentra a PAZ Y SALVO por todo concepto relacionado con este préstamo.', { align: 'justify', lineGap: 4 });

  doc.moveDown(2);
  doc.fillColor('#64748b').fontSize(11);
  doc.text('Fecha de inicio del préstamo: ' + fechaLegible(prestamo.fecha_inicio));
  doc.text('Fecha del último pago: ' + (fechaFin ? fechaLegible(fechaFin) : '—'));
  doc.text('Fecha de expedición: ' + new Date().toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' }));

  doc.moveDown(5);
  doc.strokeColor('#94a3b8').moveTo(180, doc.y).lineTo(415, doc.y).stroke();
  doc.fontSize(10).fillColor('#64748b').text('Firma del prestamista', 180, doc.y + 6, { width: 235, align: 'center' });

  doc.end();
}

// Comprobante de pago (recibo de un abono específico).
function generarComprobantePagoPDF({ prestamo, pago, saldo, cuotasPagadas, cuotasTotal }, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(stream);
  const cliente = prestamo.perfiles || {};
  const METODOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', otro: 'Otro' };
  const pagadas = Number(cuotasPagadas || 0);
  const totalCuotas = Number(cuotasTotal || 0);
  const faltan = Math.max(0, totalCuotas - pagadas);

  encabezado(doc, 'Comprobante de pago');

  let y = 125;
  doc.fontSize(10).fillColor('#64748b').text('Cliente: ', 50, y, { continued: true }).fillColor('#0f172a').text(cliente.nombre_completo || '—');
  doc.fillColor('#64748b').text('Cédula: ', 50, y + 16, { continued: true }).fillColor('#0f172a').text(cliente.numero_documento || '—');
  doc.fillColor('#64748b').text('Préstamo N°: ', 320, y, { continued: true }).fillColor('#0f172a').text(prestamo.numero != null ? String(prestamo.numero).padStart(5, '0') : numeroPrestamo(prestamo.id));

  y += 48;
  doc.roundedRect(50, y, 495, 64, 10).fill('#ecfdf5');
  doc.fillColor('#16a34a').font('Helvetica-Bold').fontSize(9).text('MONTO ABONADO', 66, y + 14);
  doc.fillColor('#16a34a').font('Helvetica-Bold').fontSize(24).text(formatCOP(pago.monto), 66, y + 28);
  doc.font('Helvetica');

  y += 88;
  const filas = [
    ['Fecha de pago', fechaLegible(pago.fecha_pago)],
    ['Método', METODOS[pago.metodo] || pago.metodo || '—'],
    ['Notas', pago.notas || '—'],
    ['Cuotas pagadas', `${pagadas} de ${totalCuotas}`],
    ['Cuotas por pagar', String(faltan)],
    ['Saldo pendiente del préstamo', formatCOP(saldo)],
  ];
  doc.fontSize(11);
  filas.forEach((f, i) => {
    const fy = y + i * 24;
    doc.fillColor('#64748b').text(f[0], 50, fy);
    doc.fillColor('#0f172a').text(f[1], 320, fy);
  });

  y += filas.length * 24 + 30;
  doc.fontSize(8).fillColor('#64748b').text('Comprobante del abono registrado en el sistema Cartera. Conserva este recibo como soporte del pago.', 50, y, { width: 495, align: 'center' });

  doc.end();
}

module.exports = { generarComprobantePDF, generarComprobanteCuotaPDF, generarPazYSalvoPDF, generarComprobantePagoPDF };
