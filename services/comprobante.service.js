const PDFDocument = require('pdfkit');
const path = require('path');
const { formatCOP } = require('../utils/moneda');

// Logo de Cash R&R (PNG, porque pdfkit no admite webp) para el encabezado.
const LOGO_PATH = path.join(__dirname, '..', 'public', 'img', 'logo-comprobante.png');

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
  const nCuotas = Number(prestamo.numero_cuotas || 1);
  const pctTotal = capital > 0 ? (interesTotal / capital) * 100 : 0;
  const pct = nCuotas > 0 ? Math.round((pctTotal / nCuotas) * 10) / 10 : 0;
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

  const NAVY = '#0e3b2b';
  const AZUL = '#16a34a';
  const GRIS = '#94a3b8';
  const L = 36, R = 559;

  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(stream);

  // ---------- ENCABEZADO ----------
  try { doc.image(LOGO_PATH, L, 34, { width: 50, height: 50 }); } catch (e) { doc.circle(61, 59, 25).fill('#0e3b2b'); }
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(15).text('Cash R&R', 96, 42);
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('Financiadora', 96, 62);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text('PLAN DE PAGO', 250, 40);
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
  doc.circle(70, 142, 22).fill('#dcfce7');
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
  doc.roundedRect(L, y, 523, 46, 10).fillAndStroke('#f0fdf4', '#bbf7d0');
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
  doc.fontSize(22).fillColor('#16a34a').text('Cash R&R', 50, 50);
  doc.fontSize(11).fillColor('#64748b').text(titulo, 50, 78);
  doc.fontSize(9).fillColor('#64748b').text('Generado: ' + new Date().toLocaleString('es-CO'), 50, 50, { align: 'right' });
  doc.moveTo(50, 100).lineTo(545, 100).strokeColor('#e2e8f0').stroke();
}

// Comprobante de pago de UNA cuota.
function generarComprobanteCuotaPDF({ prestamo, cuota, metodoPago, esInteres }, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(stream);

  const cliente = prestamo.perfiles || {};
  const { capital, interes } = calcularDesglose(prestamo)(cuota);

  const NAVY = '#0e3b2b';
  const AZUL = '#16a34a';
  const GRIS = '#94a3b8';
  const VERDE = '#16a34a';
  const L = 36, R = 559;

  const ahora = new Date();
  const fechaEmision = ahora.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
  const hora = ahora.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  const numeroMostrar = prestamo.numero != null ? String(prestamo.numero).padStart(5, '0') : numeroPrestamo(prestamo.id);
  const estaPagada = cuota.estado === 'pagada';

  // ---------- ENCABEZADO ----------
  try { doc.image(LOGO_PATH, L, 34, { width: 50, height: 50 }); } catch (e) { doc.circle(61, 59, 25).fill('#0e3b2b'); }
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(15).text('Cash R&R', 96, 42);
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('Financiadora', 96, 62);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text('COMPROBANTE DE CUOTA', 250, 40, { width: 175 });
  doc.fillColor(esInteres ? '#b45309' : GRIS).font('Helvetica' + (esInteres ? '-Bold' : '')).fontSize(8).text(esInteres ? 'Cuota N° ' + cuota.numero_cuota + ' · Solo interés' : 'Cuota N° ' + cuota.numero_cuota, 250, 57);
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('N° de préstamo:', 250, 70, { continued: true });
  doc.fillColor(AZUL).font('Helvetica-Bold').text(' ' + numeroMostrar);
  doc.fillColor(GRIS).font('Helvetica').fontSize(7).text('Fecha de emisión', 430, 38, { width: 129 });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8).text(fechaEmision, 430, 48, { width: 129 });
  doc.fillColor(GRIS).font('Helvetica').fontSize(7).text('Hora', 430, 62, { width: 129 });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8).text(hora, 430, 72, { width: 129 });
  doc.moveTo(L, 96).lineTo(R, 96).lineWidth(1).strokeColor('#e2e8f0').stroke();

  // ---------- TARJETA CLIENTE ----------
  doc.roundedRect(L, 106, 523, 86, 10).lineWidth(0.8).strokeColor('#e2e8f0').stroke();
  doc.circle(70, 142, 22).fill('#dcfce7');
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

  // ---------- TABLA AZUL (desglose de la cuota) ----------
  const tablaY = 206;
  const cols = [
    { t: 'CUOTA N°',      w: 70,  v: String(cuota.numero_cuota) },
    { t: 'VENCIMIENTO',   w: 100, v: fechaLegible(cuota.fecha_vencimiento) },
    { t: 'ABONO CAPITAL', w: 100, v: formatCOP(capital) },
    { t: 'INTERÉS',       w: 90,  v: formatCOP(interes) },
    { t: 'VALOR CUOTA',   w: 100, v: formatCOP(cuota.monto_esperado) },
    { t: 'ESTADO',        w: 63,  v: ESTADO_CUOTA[cuota.estado] || cuota.estado, color: estaPagada ? VERDE : (cuota.estado === 'parcial' ? '#d97706' : NAVY) },
  ];
  doc.rect(L, tablaY, 523, 28).fill(AZUL);
  doc.rect(L, tablaY + 28, 523, 32).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  let cx = L;
  cols.forEach((c) => {
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6.5).text(c.t, cx + 2, tablaY + 9, { width: c.w - 4, align: 'center' });
    doc.fillColor(c.color || NAVY).font('Helvetica-Bold').fontSize(9).text(c.v, cx + 2, tablaY + 28 + 11, { width: c.w - 4, align: 'center' });
    cx += c.w;
  });

  // Estado real de pago de la cuota (para reflejar pagos parciales).
  const montoPagado = Number(cuota.monto_pagado || 0);
  const saldoCuota = Math.round((Number(cuota.monto_esperado) - montoPagado) * 100) / 100;
  const esParcial = cuota.estado === 'parcial';

  // ---------- CAJA DE ESTADO DE PAGO ----------
  const cajaY = tablaY + 78;
  if (estaPagada) {
    var cajaBgC = esInteres ? '#fffbeb' : '#ecfdf5';
    var cajaTxC = esInteres ? '#b45309' : VERDE;
    doc.roundedRect(L, cajaY, 523, 70, 10).fill(cajaBgC);
    doc.fillColor(cajaTxC).font('Helvetica-Bold').fontSize(9).text(esInteres ? 'INTERÉS PAGADO' : 'CUOTA PAGADA', L, cajaY + (esInteres ? 12 : 14), { width: 523, align: 'center' });
    doc.fillColor(cajaTxC).font('Helvetica-Bold').fontSize(28).text(formatCOP(cuota.monto_esperado), L, cajaY + (esInteres ? 26 : 28), { width: 523, align: 'center' });
    if (esInteres) {
      doc.fillColor('#92400e').font('Helvetica-Bold').fontSize(8).text('Pago de SOLO INTERÉS', L, cajaY + 56, { width: 523, align: 'center' });
    }
    if (metodoPago) {
      doc.fillColor(esInteres ? '#92400e' : '#15803d').font('Helvetica-Bold').fontSize(8).text('MÉTODO', R - 150, cajaY + 20, { width: 130, align: 'right' });
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(metodoPago, R - 150, cajaY + 33, { width: 130, align: 'right' });
    }
  } else if (esParcial) {
    doc.roundedRect(L, cajaY, 523, 70, 10).fill('#fffbeb');
    doc.fillColor('#d97706').font('Helvetica-Bold').fontSize(9).text('PAGO PARCIAL', L + 20, cajaY + 12);
    doc.fillColor('#d97706').font('Helvetica-Bold').fontSize(22).text(formatCOP(montoPagado), L + 20, cajaY + 26);
    doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('pagado de ' + formatCOP(cuota.monto_esperado) + (metodoPago ? '  ·  ' + metodoPago : ''), L + 20, cajaY + 52);
    doc.fillColor('#dc2626').font('Helvetica-Bold').fontSize(9).text('PENDIENTE', 340, cajaY + 16, { width: 200, align: 'right' });
    doc.fillColor('#dc2626').font('Helvetica-Bold').fontSize(22).text(formatCOP(saldoCuota), 340, cajaY + 30, { width: 200, align: 'right' });
  } else {
    doc.roundedRect(L, cajaY, 523, 70, 10).fill('#f8fafc');
    doc.fillColor(GRIS).font('Helvetica-Bold').fontSize(9).text('PENDIENTE DE PAGO', L, cajaY + 14, { width: 523, align: 'center' });
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(28).text(formatCOP(cuota.monto_esperado), L, cajaY + 28, { width: 523, align: 'center' });
  }

  // ---------- DETALLES ----------
  const detY = cajaY + 90;
  doc.moveTo(L, detY).lineTo(R, detY).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10).text('DETALLE DE LA CUOTA', L, detY + 12);
  doc.moveTo(L, detY + 26).lineTo(R, detY + 26).lineWidth(0.5).strokeColor('#e2e8f0').stroke();

  const detalles = [
    ['Cuota número',         String(cuota.numero_cuota)],
    ['Fecha de vencimiento', fechaLegible(cuota.fecha_vencimiento)],
    ['Abono a capital',      formatCOP(capital)],
    ['Interés de la cuota',  formatCOP(interes)],
    ['Valor de la cuota',    formatCOP(cuota.monto_esperado)],
    ['Pagado hasta ahora',   formatCOP(montoPagado)],
    ['Saldo pendiente de la cuota', formatCOP(saldoCuota)],
    ['Estado',               ESTADO_CUOTA[cuota.estado] || cuota.estado],
    ['Días de atraso al pagar', cuota.dias_atraso === null || cuota.dias_atraso === undefined ? '—' : String(cuota.dias_atraso)],
  ];
  detalles.forEach((f, i) => {
    const fy = detY + 36 + i * 22;
    const esPar = i % 2 === 0;
    if (esPar) doc.rect(L, fy - 4, 523, 22).fill('#f8fafc');
    doc.fillColor(GRIS).font('Helvetica').fontSize(9).text(f[0], L + 12, fy);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text(f[1], 0, fy, { align: 'right', width: R - 12 });
  });

  // ---------- PIE ----------
  const pieY = detY + 36 + detalles.length * 22 + 20;
  doc.moveTo(L, pieY).lineTo(R, pieY).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  doc.fontSize(7.5).fillColor(GRIS).text(
    'Comprobante generado por el sistema Cash R&R con base en los registros del préstamo.',
    L, pieY + 10, { width: 523, align: 'center' }
  );
  doc.end();
}

// Certificado de Paz y Salvo (préstamo pagado en su totalidad).
function generarPazYSalvoPDF({ prestamo, pagos }, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(stream);

  const cliente = prestamo.perfiles || {};
  const fechas = (pagos || []).map((p) => p.fecha_pago).filter(Boolean).sort();
  const fechaFin = fechas.length ? fechas[fechas.length - 1] : null;

  const NAVY = '#0e3b2b';
  const AZUL = '#16a34a';
  const GRIS = '#94a3b8';
  const VERDE = '#16a34a';
  const L = 36, R = 559;

  const ahora = new Date();
  const fechaEmision = ahora.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
  const hora = ahora.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  const numeroMostrar = prestamo.numero != null ? String(prestamo.numero).padStart(5, '0') : numeroPrestamo(prestamo.id);

  // ---------- SELLO PAZ Y SALVO (centrado) ----------
  const selloY = 44;
  doc.roundedRect(L, selloY, 523, 72, 10).fill('#ecfdf5');
  doc.roundedRect(L, selloY, 523, 72, 10).lineWidth(1).strokeColor('#bbf7d0').stroke();

  // Se centra como grupo: ícono de check + título "PAZ Y SALVO".
  const tituloSello = 'PAZ Y SALVO';
  doc.font('Helvetica-Bold').fontSize(22);
  const tituloW = doc.widthOfString(tituloSello);
  const circR = 18, gap = 14;
  const grupoW = circR * 2 + gap + tituloW;
  const startX = L + (523 - grupoW) / 2;
  const cxCirc = startX + circR;
  const cyCirc = selloY + 30;

  doc.circle(cxCirc, cyCirc, circR).fill('#16a34a');
  doc.lineWidth(3).strokeColor('#ffffff')
    .moveTo(cxCirc - 8, cyCirc).lineTo(cxCirc - 2, cyCirc + 6).lineTo(cxCirc + 9, cyCirc - 6).stroke();
  doc.fillColor(VERDE).font('Helvetica-Bold').fontSize(22).text(tituloSello, startX + circR * 2 + gap, selloY + 20, { lineBreak: false });
  doc.fillColor('#15803d').font('Helvetica').fontSize(9).text('Préstamo pagado en su totalidad', L, selloY + 52, { width: 523, align: 'center' });

  // ---------- CUERPO / CERTIFICACIÓN ----------
  const txtY = selloY + 92;
  doc.fillColor(NAVY).font('Helvetica').fontSize(10.5).text(
    'Se certifica que ' + (cliente.nombre_completo || 'el cliente') +
    (cliente.numero_documento ? ', identificado(a) con cédula ' + cliente.numero_documento + ',' : '') +
    ' ha cumplido en su totalidad con el pago del préstamo N° ' + numeroMostrar + ' registrado en el sistema, por un capital de ' +
    formatCOP(prestamo.monto_capital) + ' y un total pagado de ' + formatCOP(prestamo.monto_total_a_pagar) +
    ', distribuido en ' + prestamo.numero_cuotas + ' cuotas.',
    L, txtY, { width: 523, align: 'justify', lineGap: 4 }
  );
  doc.moveDown(0.8);
  doc.fillColor(NAVY).font('Helvetica').fontSize(10.5).text(
    'Por lo anterior, el cliente se encuentra a PAZ Y SALVO por todo concepto relacionado con este préstamo.',
    { width: 523, align: 'justify', lineGap: 4 }
  );

  // ---------- TABLA DE DATOS ----------
  const datosY = doc.y + 18;
  const datos = [
    ['N° de préstamo',        numeroMostrar],
    ['Capital del préstamo',  formatCOP(prestamo.monto_capital)],
    ['Total pagado',          formatCOP(prestamo.monto_total_a_pagar)],
    ['N° de cuotas',          String(prestamo.numero_cuotas)],
    ['Fecha de inicio',       fechaLegible(prestamo.fecha_inicio)],
    ['Fecha del último pago',  fechaFin ? fechaLegible(fechaFin) : '—'],
    ['Fecha de expedición',   fechaEmision],
  ];
  datos.forEach((f, i) => {
    const fy = datosY + i * 22;
    if (i % 2 === 0) doc.rect(L, fy - 4, 523, 22).fill('#f8fafc');
    doc.fillColor(GRIS).font('Helvetica').fontSize(9).text(f[0], L + 12, fy);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text(f[1], 0, fy, { align: 'right', width: R - 12 });
  });

  // ---------- FIRMA ----------
  const firmaY = datosY + datos.length * 22 + 50;
  doc.strokeColor('#94a3b8').lineWidth(0.8).moveTo(180, firmaY).lineTo(415, firmaY).stroke();
  doc.fillColor(GRIS).font('Helvetica').fontSize(9).text('Firma del prestamista', 180, firmaY + 6, { width: 235, align: 'center' });

  // ---------- PIE ----------
  const pieY = firmaY + 44;
  doc.moveTo(L, pieY).lineTo(R, pieY).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  doc.fontSize(7.5).fillColor(GRIS).font('Helvetica').text(
    'Documento generado por el sistema Cash R&R con base en los registros del préstamo.',
    L, pieY + 10, { width: 523, align: 'center' }
  );

  doc.end();
}

// Comprobante de pago (recibo de un abono específico).
function generarComprobantePagoPDF({ prestamo, pago, saldo, cuotasPagadas, cuotasTotal }, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(stream);

  const cliente = prestamo.perfiles || {};
  const METODOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', otro: 'Otro' };
  const esInteres = pago.tipo === 'interes';
  const ACCION_LBL = { extension: 'Extender un periodo', saldo: 'Dejar saldo pendiente' };
  const accionLbl = esInteres ? (ACCION_LBL[pago.accion] || 'Dejar saldo pendiente') : null;
  const pagadas = Number(cuotasPagadas || 0);
  const totalCuotas = Number(cuotasTotal || 0);
  const faltan = Math.max(0, totalCuotas - pagadas);

  const NAVY = '#0e3b2b';
  const AZUL = '#16a34a';
  const GRIS = '#94a3b8';
  const VERDE = '#16a34a';
  const L = 36, R = 559;

  const ahora = new Date();
  const fechaEmision = ahora.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
  const hora = ahora.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  const numeroMostrar = prestamo.numero != null ? String(prestamo.numero).padStart(5, '0') : numeroPrestamo(prestamo.id);

  // ---------- ENCABEZADO ----------
  try { doc.image(LOGO_PATH, L, 34, { width: 50, height: 50 }); } catch (e) { doc.circle(61, 59, 25).fill('#0e3b2b'); }
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(15).text('Cash R&R', 96, 42);
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('Financiadora', 96, 62);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(esInteres ? 11.5 : 13).text(esInteres ? 'COMPROBANTE DE INTERÉS' : 'COMPROBANTE DE PAGO', 250, esInteres ? 42 : 40, { width: 175 });
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(esInteres ? 'Recibo de pago de solo interés' : 'Recibo de abono registrado', 250, 57);
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('N° de préstamo:', 250, 70, { continued: true });
  doc.fillColor(AZUL).font('Helvetica-Bold').text(' ' + numeroMostrar);
  doc.fillColor(GRIS).font('Helvetica').fontSize(7).text('Fecha de emisión', 430, 38, { width: 129 });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8).text(fechaEmision, 430, 48, { width: 129 });
  doc.fillColor(GRIS).font('Helvetica').fontSize(7).text('Hora', 430, 62, { width: 129 });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8).text(hora, 430, 72, { width: 129 });
  doc.moveTo(L, 96).lineTo(R, 96).lineWidth(1).strokeColor('#e2e8f0').stroke();

  // ---------- TARJETA CLIENTE ----------
  doc.roundedRect(L, 106, 523, 86, 10).lineWidth(0.8).strokeColor('#e2e8f0').stroke();
  doc.circle(70, 142, 22).fill('#dcfce7');
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

  // ---------- TABLA AZUL (resumen del abono) ----------
  const tablaY = 206;
  const cols = [
    { t: 'FECHA DE PAGO',   w: 90,  v: fechaLegible(pago.fecha_pago) },
    { t: 'MÉTODO',          w: 80,  v: METODOS[pago.metodo] || pago.metodo || '—' },
    { t: 'MONTO ABONADO',   w: 100, v: formatCOP(pago.monto), color: VERDE },
    { t: 'CUOTAS PAGADAS',  w: 85,  v: `${pagadas} de ${totalCuotas}` },
    { t: 'POR PAGAR',       w: 75,  v: String(faltan) },
    { t: 'SALDO PENDIENTE', w: 93,  v: formatCOP(saldo) },
  ];
  doc.rect(L, tablaY, 523, 28).fill(AZUL);
  doc.rect(L, tablaY + 28, 523, 32).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  let cx = L;
  cols.forEach((c) => {
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6.5).text(c.t, cx + 2, tablaY + 9, { width: c.w - 4, align: 'center' });
    doc.fillColor(c.color || NAVY).font('Helvetica-Bold').fontSize(9).text(c.v, cx + 2, tablaY + 28 + 11, { width: c.w - 4, align: 'center' });
    cx += c.w;
  });

  // ---------- CAJA VERDE MONTO ----------
  const cajaY = tablaY + 78;
  const cajaBg = esInteres ? '#fffbeb' : '#ecfdf5';
  const cajaTx = esInteres ? '#b45309' : VERDE;
  doc.roundedRect(L, cajaY, 523, 70, 10).fill(cajaBg);
  doc.fillColor(cajaTx).font('Helvetica-Bold').fontSize(9).text(esInteres ? 'INTERÉS PAGADO' : 'MONTO ABONADO', L, cajaY + 12, { width: 523, align: 'center' });
  doc.fillColor(cajaTx).font('Helvetica-Bold').fontSize(28).text(formatCOP(pago.monto), L, cajaY + 26, { width: 523, align: 'center' });
  // Método de pago a la derecha de la caja.
  doc.fillColor(esInteres ? '#92400e' : '#15803d').font('Helvetica-Bold').fontSize(8).text('MÉTODO', R - 150, cajaY + 20, { width: 130, align: 'right' });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(METODOS[pago.metodo] || pago.metodo || '—', R - 150, cajaY + 33, { width: 130, align: 'right' });
  if (esInteres) {
    doc.fillColor('#92400e').font('Helvetica-Bold').fontSize(8).text('Pago de SOLO INTERÉS', L, cajaY + 56, { width: 523, align: 'center' });
  } else if (pago.notas) {
    doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('Nota: ' + pago.notas, L, cajaY + 58, { width: 523, align: 'center' });
  }

  // ---------- REPARTO DEL PAGO ----------
  // Muestra a qué cuota(s) se aplicó el dinero de este abono. Se lee del
  // registro guardado; si un pago viejo no lo tiene, se omite la tabla.
  const aplicaciones = (pago.distribucion && Array.isArray(pago.distribucion.aplicaciones))
    ? pago.distribucion.aplicaciones
    : [];
  const excedente = Number(pago.distribucion?.excedente || 0);

  const detY = cajaY + 90;
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10).text('REPARTO DEL PAGO', L, detY);

  const repY = detY + 18;
  const rcols = [
    { t: 'CUOTA', w: 90 },
    { t: 'APLICADO A LA CUOTA', w: 160 },
    { t: 'SALDO DE LA CUOTA', w: 150 },
    { t: 'ESTADO', w: 123 },
  ];
  doc.rect(L, repY, 523, 22).fill(AZUL);
  let rx = L;
  rcols.forEach((c) => {
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7).text(c.t, rx + 6, repY + 7, { width: c.w - 12, align: 'left' });
    rx += c.w;
  });

  let filaY = repY + 22;
  if (aplicaciones.length === 0) {
    doc.rect(L, filaY, 523, 24).fill('#f8fafc');
    doc.fillColor(GRIS).font('Helvetica-Oblique').fontSize(8.5).text(
      'Este pago no tiene reparto detallado guardado.', L + 6, filaY + 8, { width: 511 }
    );
    filaY += 24;
  } else {
    aplicaciones.forEach((a, i) => {
      if (i % 2 === 0) doc.rect(L, filaY, 523, 24).fill('#f8fafc');
      const estadoTxt = ESTADO_CUOTA[a.estado_resultante] || a.estado_resultante || '—';
      const estadoColor = a.estado_resultante === 'pagada' ? VERDE : (a.estado_resultante === 'parcial' ? '#d97706' : NAVY);
      let cxr = L;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text('Cuota #' + a.cuota_numero, cxr + 6, filaY + 8, { width: rcols[0].w - 12 }); cxr += rcols[0].w;
      doc.fillColor(NAVY).font('Helvetica').fontSize(9).text(formatCOP(a.monto_aplicado), cxr + 6, filaY + 8, { width: rcols[1].w - 12 }); cxr += rcols[1].w;
      doc.fillColor(NAVY).font('Helvetica').fontSize(9).text(formatCOP(a.saldo_cuota || 0), cxr + 6, filaY + 8, { width: rcols[2].w - 12 }); cxr += rcols[2].w;
      doc.fillColor(estadoColor).font('Helvetica-Bold').fontSize(9).text(estadoTxt, cxr + 6, filaY + 8, { width: rcols[3].w - 12 });
      filaY += 24;
    });
    if (excedente > 0) {
      doc.rect(L, filaY, 523, 24).fill('#fffbeb');
      doc.fillColor('#d97706').font('Helvetica-Bold').fontSize(9).text('Saldo a favor', L + 6, filaY + 8, { width: rcols[0].w + rcols[1].w - 12 });
      doc.fillColor('#d97706').font('Helvetica-Bold').fontSize(9).text(formatCOP(excedente), L + rcols[0].w + rcols[1].w + 6, filaY + 8, { width: rcols[2].w - 12 });
      filaY += 24;
    }
  }
  doc.rect(L, repY, 523, filaY - repY).lineWidth(0.5).strokeColor('#e2e8f0').stroke();

  // ---------- RESUMEN DEL PRÉSTAMO ----------
  filaY += 14;
  const resumen = [
    ['Tipo de pago', esInteres ? 'Solo interés' : 'Abono normal'],
  ];
  if (esInteres) resumen.push(['Acción sobre el capital', accionLbl]);
  resumen.push(['Cuotas pagadas', `${pagadas} de ${totalCuotas}`]);
  resumen.push(['Saldo pendiente del préstamo', formatCOP(saldo)]);
  resumen.forEach((f, i) => {
    const fy = filaY + i * 22;
    if (i % 2 === 0) doc.rect(L, fy - 4, 523, 22).fill('#f8fafc');
    doc.fillColor(GRIS).font('Helvetica').fontSize(9).text(f[0], L + 12, fy);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text(f[1], 0, fy, { align: 'right', width: R - 12 });
  });

  // ---------- PIE ----------
  const pieY = filaY + resumen.length * 22 + 20;
  doc.moveTo(L, pieY).lineTo(R, pieY).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  doc.fontSize(7.5).fillColor(GRIS).text(
    'Comprobante del abono registrado en el sistema Cash R&R. Conserva este recibo como soporte del pago.',
    L, pieY + 10, { width: 523, align: 'center' }
  );

  doc.end();
}

module.exports = { generarComprobantePDF, generarComprobanteCuotaPDF, generarPazYSalvoPDF, generarComprobantePagoPDF };
