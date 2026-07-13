/**
 * Seed de ~1 año de datos consistentes.
 *
 * Crea un pool de clientes y un préstamo por cada día del último año, paga las
 * cuotas que ya vencieron (a su fecha, para que los ingresos queden repartidos
 * en el tiempo) y deja N préstamos EN MORA (sin pagar sus cuotas vencidas).
 *
 * Usa los servicios reales (crearPrestamoConPlan, registrarAbono, caja,
 * marcarCuotasVencidas) para que cuotas, movimientos de caja, auditoría y la
 * distribución de cada pago queden 100% consistentes con la app.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  ANTES DE CORRERLO:
 *   1) Aplica la migración de distribución (si no la tienes):
 *        alter table public.pagos add column if not exists distribucion jsonb;
 *   2) Idealmente parte de una base limpia (TRUNCATE) para no mezclar datos.
 *   3) Debe existir un usuario admin (npm run seed:admin).
 *
 *  USO:  npm run seed:anio
 *  Config por variables de entorno (opcionales):
 *        SEED_DIAS=365  SEED_CLIENTES=40  SEED_MORA=30
 *
 *  NOTA: puede tardar VARIOS MINUTOS (miles de operaciones contra Supabase).
 * ─────────────────────────────────────────────────────────────────────────
 */
require('dotenv').config();

const { supabaseAdmin } = require('../config/supabase');
const prestamosService = require('../services/prestamos.service');
const pagosService = require('../services/pagos.service');
const cajaService = require('../services/caja.service');
const { siguienteFecha, formatoISO } = require('../utils/fechas');

// ---------------------------- CONFIG ----------------------------
const DIAS = Number(process.env.SEED_DIAS || 365);      // un préstamo por día hacia atrás
const N_CLIENTES = Number(process.env.SEED_CLIENTES || 40);
const N_MORA = Number(process.env.SEED_MORA || 30);
const TAG = Date.now().toString(36);                    // emails únicos por corrida

const FRECUENCIAS = ['semanal', 'quincenal', 'mensual']; // se evita 'diario' (demasiadas cuotas)
const CAPITALES = [200000, 300000, 500000, 700000, 1000000, 1500000, 2000000];
const PCT_INTERES = [0.10, 0.15, 0.20, 0.25];            // interés total sobre el capital
const CUOTAS = [4, 5, 6, 8, 10, 12];
const METODOS = ['efectivo', 'transferencia', 'nequi', 'daviplata'];
const NOMBRES = ['Juan', 'María', 'Carlos', 'Ana', 'Luis', 'Laura', 'Pedro', 'Sofía', 'Andrés', 'Diana', 'Jorge', 'Paula', 'Miguel', 'Camila', 'Fernando', 'Valentina', 'Ricardo', 'Daniela', 'Óscar', 'Natalia'];
const APELLIDOS = ['Gómez', 'Rodríguez', 'Martínez', 'López', 'Hernández', 'Díaz', 'Torres', 'Ramírez', 'Rojas', 'Vargas', 'Castro', 'Ruiz', 'Moreno', 'Jiménez', 'Ortiz', 'Suárez', 'Mendoza', 'Cárdenas', 'Ríos', 'Peña'];

// ---------------------------- HELPERS ----------------------------
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rndInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
function fechaMenos(dias) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - dias);
  return d;
}

async function verificarPreflight() {
  // ¿Existe la columna distribucion?
  const { error } = await supabaseAdmin.from('pagos').select('distribucion').limit(1);
  if (error && /distribucion/i.test(error.message)) {
    throw new Error(
      'Falta la columna pagos.distribucion. Ejecuta primero en Supabase:\n' +
      '  alter table public.pagos add column if not exists distribucion jsonb;'
    );
  }
  // ¿Existe un admin?
  const { data, error: e2 } = await supabaseAdmin
    .from('perfiles').select('id').eq('rol', 'admin').limit(1).maybeSingle();
  if (e2) throw e2;
  if (!data) throw new Error('No hay usuario admin. Crea uno con: npm run seed:admin');
  return data.id;
}

async function crearClientes() {
  const ids = [];
  for (let i = 0; i < N_CLIENTES; i++) {
    const nombre = `${rnd(NOMBRES)} ${rnd(APELLIDOS)} ${rnd(APELLIDOS)}`;
    const email = `seed_${TAG}_${i}@ejemplo.test`;
    const { data: creado, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { nombre_completo: nombre, rol: 'cliente' },
    });
    if (error) { console.warn(`  cliente ${i} falló: ${error.message}`); continue; }
    await supabaseAdmin.from('perfiles').update({
      numero_documento: String(rndInt(10000000, 99999999)),
      telefono: `30${rndInt(10000000, 99999999)}`,
      direccion: `Calle ${rndInt(1, 120)} # ${rndInt(1, 90)}-${rndInt(1, 99)}`,
    }).eq('id', creado.user.id);
    ids.push(creado.user.id);
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${N_CLIENTES} clientes`);
  }
  return ids;
}

function armarPrestamo(clienteId, adminId, fechaInicio, frecuencia) {
  const capital = rnd(CAPITALES);
  const pct = rnd(PCT_INTERES);
  const nCuotas = rnd(CUOTAS);
  const total = Math.round(capital * (1 + pct));
  return {
    cliente_id: clienteId,
    creado_por: adminId,
    monto_capital: capital,
    tipo_interes: 'fijo_total',
    valor_interes: total - capital,
    tasa_interes: null,
    monto_total_a_pagar: total,
    numero_cuotas: nCuotas,
    valor_cuota: Math.round(total / nCuotas),
    frecuencia_pago: frecuencia,
    fecha_inicio: formatoISO(fechaInicio),
    fecha_primer_pago: formatoISO(siguienteFecha(fechaInicio, frecuencia)),
    notas: 'seed',
  };
}

// ---------------------------- MAIN ----------------------------
async function main() {
  console.log('== Seed de ~1 año de datos ==');
  console.log(`Config: ${DIAS} días, ${N_CLIENTES} clientes, ${N_MORA} en mora`);

  const adminId = await verificarPreflight();
  const hoyISO = formatoISO(new Date());

  // Capital inicial en caja para que el saldo no quede negativo por los préstamos.
  console.log('→ Capital inicial en caja...');
  await cajaService.registrarMovimiento({
    tipo: 'ingreso',
    monto: 500000000,
    concepto: 'Capital inicial de operación (seed)',
    origen: 'manual',
    registradoPor: adminId,
  });

  console.log('→ Creando clientes...');
  const clientes = await crearClientes();
  if (!clientes.length) throw new Error('No se creó ningún cliente.');

  console.log('→ Creando préstamos (uno por día)...');
  const prestamos = [];
  for (let k = DIAS; k >= 1; k--) {
    const frecuencia = rnd(FRECUENCIAS);
    const datos = armarPrestamo(rnd(clientes), adminId, fechaMenos(k), frecuencia);
    try {
      const p = await prestamosService.crearPrestamoConPlan(datos);
      prestamos.push({ id: p.id, diasAtras: k });
    } catch (e) {
      console.warn(`  préstamo (día -${k}) falló: ${e.message}`);
    }
    if (prestamos.length % 50 === 0) console.log(`  ${prestamos.length} préstamos...`);
  }

  // Elegir N préstamos EN MORA entre los que llevan 40–160 días (para que
  // tengan 1–5 cuotas vencidas, no un año entero). Si no hay suficientes,
  // se completa con cualquiera.
  const candidatos = prestamos.filter((p) => p.diasAtras >= 40 && p.diasAtras <= 160);
  const pool = candidatos.length >= N_MORA ? candidatos : prestamos;
  const moraSet = new Set();
  while (moraSet.size < Math.min(N_MORA, pool.length)) {
    moraSet.add(pool[rndInt(0, pool.length - 1)].id);
  }

  console.log('→ Registrando pagos (cuotas vencidas hasta hoy)...');
  let pagos = 0, procesados = 0;
  for (const pr of prestamos) {
    procesados++;
    if (moraSet.has(pr.id)) continue; // los de mora NO se pagan

    const { data: cuotas } = await supabaseAdmin
      .from('cuotas').select('*').eq('prestamo_id', pr.id).order('numero_cuota', { ascending: true });
    for (const c of (cuotas || [])) {
      if (c.fecha_vencimiento > hoyISO) break; // aún no vence → no se paga
      try {
        await pagosService.registrarAbono({
          prestamoId: pr.id,
          cuotaId: c.id,
          monto: Number(c.monto_esperado),
          fechaPago: c.fecha_vencimiento,
          metodo: rnd(METODOS),
          notas: null,
          registradoPor: adminId,
          tipo: 'abono',
        });
        pagos++;
      } catch (e) {
        console.warn(`  pago falló: ${e.message}`);
      }
    }
    if (procesados % 50 === 0) console.log(`  ${procesados}/${prestamos.length} préstamos, ${pagos} pagos`);
  }

  console.log('→ Marcando cuotas vencidas y créditos en mora...');
  await prestamosService.marcarCuotasVencidas();
  for (const id of moraSet) {
    await supabaseAdmin.from('prestamos').update({ estado: 'en_mora' }).eq('id', id);
  }

  console.log('\n== LISTO ==');
  console.log(`Clientes creados : ${clientes.length}`);
  console.log(`Préstamos        : ${prestamos.length}`);
  console.log(`Pagos registrados: ${pagos}`);
  console.log(`En mora          : ${moraSet.size}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nERROR:', e.message || e);
  process.exit(1);
});
