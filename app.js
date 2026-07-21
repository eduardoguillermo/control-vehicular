'use strict';

// ── CONSTANTES ────────────────────────────────────────────────────────────────
const SKEY = 'control-vehicular';
const VERSION = 'v0.35';
const DEV_MODE = false; // en el build de DEV esto se reemplaza por true

const TIPOS_GASTO_FIJO = ['Seguro','Patente/Impuesto','Cochera','Alarma/Monitoreo','Otro'];
const CATEGORIAS_GASTO_VAR = ['Multas','Peajes','Estacionamiento','Reparación no programada','Otro'];
const TIPOS_COMPONENTE = ['Neumáticos','Batería','Otro'];
const TIPOS_COMBUSTIBLE = ['Super','Premium'];
const MARCAS_COMBUSTIBLE = ['Axion','YPF','Shell','Otras'];
const SUGERENCIAS_MANTENIMIENTO_DEMANDA = [
  'Cambio de lámpara','Alineación y balanceo','Lavado','Cambio de escobillas',
  'Revisión de frenos','Reparación de aire acondicionado','Reparación eléctrica','Otro'
];
const UMBRAL_KM_AVISO_VENCIMIENTO = 500; // avisar en el modal si faltan <= 500km para un mantenimiento
const UMBRAL_PORCENTAJE_AVISO_VENCIMIENTO = 80; // avisar si un componente llegó al 80% de su vida útil

// ── DB ────────────────────────────────────────────────────────────────────────
let DB = {
  nid: 1,
  vehiculos: [],
  cargas: [],
  mantenimientosProgramados: [],
  mantenimientosRealizados: [],
  componentes: [],
  gastosFijos: [],
  gastosVariables: [],
  alertas: [],
  tiposComponenteCustom: [],
  config: { vehiculoActivo: null }
};

function cvNuevoUUID(){
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8);
    return v.toString(16);
  });
}

function normalizarDB(){
  if(!DB.nid) DB.nid = 1;
  ['vehiculos','cargas','mantenimientosProgramados','mantenimientosRealizados','componentes','gastosFijos','gastosVariables','alertas']
    .forEach(k => { if(!DB[k]) DB[k] = []; });
  if(!DB.tiposComponenteCustom) DB.tiposComponenteCustom = [];
  if(!DB.config) DB.config = {};
  if(DB.config.vehiculoActivo === undefined) DB.config.vehiculoActivo = null;

  // Backfill uuid/lastModified para todas las colecciones (necesario para merge Drive)
  ['vehiculos','cargas','mantenimientosProgramados','mantenimientosRealizados','componentes','gastosFijos','gastosVariables','alertas']
    .forEach(k => DB[k].forEach(r => {
      if(!r.uuid) r.uuid = cvNuevoUUID();
      if(!r.lastModified) r.lastModified = Date.now();
    }));

  // Si no hay vehículo activo pero sí hay vehículos, activar el primero
  if(!DB.config.vehiculoActivo && DB.vehiculos.length){
    DB.config.vehiculoActivo = DB.vehiculos[0].uuid;
  }
}

function load(){
  try{
    const raw = localStorage.getItem(SKEY);
    if(raw) DB = JSON.parse(raw);
    normalizarDB();
  } catch(e){ console.error('Error load:', e); normalizarDB(); }
}

let _driveSyncTimer = null;
function save(){
  try{ localStorage.setItem(SKEY, JSON.stringify(DB)); }
  catch(e){ alert('Error al guardar: '+e.message); }
  if(typeof DriveSync !== 'undefined' && DriveSync.conectado){
    clearTimeout(_driveSyncTimer);
    _driveSyncTimer = setTimeout(()=>cvSubirDrive(), 5000);
  }
}

function tocar(registro){ registro.lastModified = Date.now(); return registro; }

// ── SNAPSHOTS (safe-close) ──────────────────────────────────────────────────
const SKEY_SNAPS = 'control-vehicular-snaps';
const MAX_SNAPS = 10;

function cvCargarSnaps(){
  try{ return JSON.parse(localStorage.getItem(SKEY_SNAPS)||'[]'); }
  catch(e){ return []; }
}
function cvHacerSnapshot(manual=false){
  try{
    const snaps = cvCargarSnaps();
    snaps.unshift({ ts: Date.now(), manual, label: manual?'Manual':'Auto', data: JSON.stringify(DB) });
    while(snaps.length > MAX_SNAPS) snaps.pop();
    localStorage.setItem(SKEY_SNAPS, JSON.stringify(snaps));
    return true;
  } catch(e){ return false; }
}
function cvRestaurarSnapshot(ts){
  const snap = cvCargarSnaps().find(s => s.ts === ts);
  if(!snap) return;
  if(!confirm('¿Restaurar este snapshot? Se reemplazarán los datos actuales.')) return;
  try{
    DB = JSON.parse(snap.data);
    normalizarDB();
    save();
    goTo('dashboard');
  } catch(e){ alert('Error al restaurar: '+e.message); }
}
function cvEliminarSnapshot(ts){
  const snaps = cvCargarSnaps().filter(s => s.ts !== ts);
  localStorage.setItem(SKEY_SNAPS, JSON.stringify(snaps));
  renderBackup();
}

function esMobile(){
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 768;
}

async function cvSalir(){
  const mobile = esMobile();
  abrirModal(mobile ? '💾 Guardando' : '🚪 Saliendo de Control Vehicular', `
    <div style="display:flex;flex-direction:column;gap:12px;padding:6px 0">
      <div id="salir-snap" style="display:flex;align-items:center;gap:8px;font-size:13px"><span>⏳</span><span>Guardando snapshot local...</span></div>
      <div id="salir-drive" style="display:flex;align-items:center;gap:8px;font-size:13px"><span>⏳</span><span>Sincronizando con Google Drive...</span></div>
    </div>
  `, '');

  // 1. Snapshot local (siempre)
  const okSnap = cvHacerSnapshot(true);
  const snapEl = document.getElementById('salir-snap');
  if(snapEl) snapEl.innerHTML = okSnap
    ? '<span class="green">✅</span><span>Snapshot local guardado</span>'
    : '<span class="red">⚠️</span><span>No se pudo guardar el snapshot local</span>';

  // 2. Backup a Drive (si está conectado) — esto corre igual en cel y PC,
  // porque el celular es el que carga los datos y necesita subirlos.
  // En DEV_MODE nunca se sube nada, ni se intenta: solo queda el snapshot local.
  const driveEl = document.getElementById('salir-drive');
  if(DEV_MODE){
    if(driveEl) driveEl.innerHTML = '<span class="amber">🔒</span><span>DEV es de solo lectura — no se sube nada a Drive</span>';
  } else if(DriveSync.conectado){
    try{
      await DriveSync.subirBackup(DB, true);
      if(driveEl) driveEl.innerHTML = '<span class="green">☁️</span><span>Backup subido a Drive</span>';
    } catch(e){
      if(driveEl) driveEl.innerHTML = `<span class="red">⚠️</span><span>Drive falló: ${escHtml(e.message)}</span>`;
    }
  } else {
    if(driveEl) driveEl.innerHTML = '<span class="amber">ℹ️</span><span>Drive no conectado — el backup quedó solo en este dispositivo</span>';
  }

  // 3. El cierre de la app es SOLO comportamiento de PC. En el celular la app
  // se sigue usando para la próxima carga de combustible: acá solo confirmamos
  // que ya se guardó y se puede volver a la pantalla de inicio tranquilo.
  if(mobile){
    document.getElementById('modal-foot').innerHTML = `<button class="btn btn-p" onclick="cerrarModal()">Listo</button>`;
  } else {
    document.getElementById('modal-foot').innerHTML = `<button class="btn btn-p" onclick="cvCerrarAppFinal()">Cerrar app</button>`;
  }
}

function cvCerrarAppFinal(){
  window.close();
  // Fallback: la mayoría de navegadores bloquean window.close() en pestañas
  // que no fueron abiertas por script (incluida una PWA instalada). Si sigue
  // abierta 300ms después, mostramos la confirmación final igual.
  setTimeout(()=>{
    const body = document.getElementById('modal-body');
    if(!body) return;
    body.innerHTML = `<div style="text-align:center;padding:14px 0">
      <div style="font-size:34px;margin-bottom:8px">✅</div>
      <div style="font-size:13px">Listo. Ya podés cerrar la app.</div>
    </div>`;
    document.getElementById('modal-foot').innerHTML = '';
  }, 300);
}

// ── MERGE (Drive) por uuid, last-write-wins por lastModified ────────────────
function cvMergeColeccion(locales, remotos){
  const mapa = new Map();
  (locales||[]).forEach(r => mapa.set(r.uuid, r));
  (remotos||[]).forEach(r => {
    const existente = mapa.get(r.uuid);
    if(!existente || (r.lastModified||0) > (existente.lastModified||0)) mapa.set(r.uuid, r);
  });
  return Array.from(mapa.values());
}

async function cvSubirDrive(){
  if(typeof DriveSync === 'undefined' || !DriveSync.conectado) return;
  try{ await DriveSync.subirBackup(DB); }
  catch(e){ console.error('Error subiendo a Drive:', e); }
}

async function cvSincronizarDrive(){
  if(typeof DriveSync === 'undefined'){ alert('Drive Sync no disponible.'); return; }
  if(!DriveSync.conectado){ DriveSync.conectar(); return; }
  try{
    const remoto = await DriveSync.bajarBackup();
    if(remoto && typeof remoto === 'object' && Object.keys(remoto).length){
      // En DEV_MODE se reemplaza directamente por los datos de PROD (no se
      // mergea con lo local) para tener siempre una copia fiel para probar,
      // sin arriesgarse a subir nunca ese merge a ningún lado.
      if(DEV_MODE){
        DB = remoto;
      } else {
        ['vehiculos','cargas','mantenimientosProgramados','mantenimientosRealizados','componentes','gastosFijos','gastosVariables','alertas']
          .forEach(k => { DB[k] = cvMergeColeccion(DB[k], remoto[k]); });
        if(remoto.nid && remoto.nid > DB.nid) DB.nid = remoto.nid;
      }
      normalizarDB();
      save();
    }
    if(DEV_MODE){
      alert('✅ Datos actualizados desde PROD (solo lectura — DEV nunca sube nada a Drive).');
    } else {
      await DriveSync.subirBackup(DB);
      alert('✅ Sincronizado con Drive.');
    }
    goTo(_currentView || 'dashboard');
  } catch(e){
    console.error(e);
    alert('⚠️ Error al sincronizar: '+e.message);
  }
}

// Borra TODOS los datos (local + Drive si está conectado). Doble confirmación
// porque es irreversible más allá del último snapshot que se guarda antes.
async function cvBorrarTodo(){
  if(!confirm('¿Seguro que querés borrar TODOS los datos (vehículos, cargas, mantenimientos, componentes, gastos)? Esta acción no se puede deshacer.')) return;
  const escrito = prompt('Para confirmar, escribí BORRAR (en mayúsculas):');
  if(escrito !== 'BORRAR'){ alert('Cancelado. No se borró nada.'); return; }

  // Último salvavidas: snapshot antes de borrar
  cvHacerSnapshot(true);

  DB = {
    nid: 1,
    vehiculos: [], cargas: [], mantenimientosProgramados: [], mantenimientosRealizados: [],
    componentes: [], gastosFijos: [], gastosVariables: [], alertas: [],
    tiposComponenteCustom: [],
    config: { vehiculoActivo: null }
  };
  save();

  if(typeof DriveSync !== 'undefined' && DriveSync.conectado){
    try{ await DriveSync.subirBackup(DB); }
    catch(e){ console.error('No se pudo limpiar el backup en Drive:', e); }
  }

  alert('✅ Listo. Todos los datos fueron borrados (queda un último snapshot por si te arrepentís).');
  goTo('vehiculos');
}

// ── HELPERS DE FORMATO ───────────────────────────────────────────────────────
function fmtMoney(n){ return '$ ' + Math.round(Number(n)||0).toLocaleString('es-AR', {minimumFractionDigits:0, maximumFractionDigits:0}); }
function fmtKm(n){ return (Number(n)||0).toLocaleString('es-AR') + ' km'; }
function fmtSemanas(n){ const v = Math.abs(Math.round(n)); return v===1 ? '1 semana' : `${v} semanas`; }
function fmtNum(n, dec=2){ return (Number(n)||0).toLocaleString('es-AR', {minimumFractionDigits:dec, maximumFractionDigits:dec}); }
function fmtFecha(iso){
  if(!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('es-AR');
}
function hoyISO(){ return new Date().toISOString(); }
function sumar(arr){ return arr.reduce((a,b)=>a+(Number(b)||0),0); }

// ── VEHÍCULOS ─────────────────────────────────────────────────────────────────
function vehiculoActivo(){
  return DB.vehiculos.find(v => v.uuid === DB.config.vehiculoActivo) || DB.vehiculos[0] || null;
}
function cambiarVehiculoActivo(uuid){
  DB.config.vehiculoActivo = uuid;
  save();
  goTo(_currentView || 'dashboard');
}
function crearVehiculo(datos){
  const v = tocar({
    uuid: cvNuevoUUID(),
    nombre: datos.nombre,
    tipo: datos.tipo || 'Auto',
    marca: datos.marca || '',
    modelo: datos.modelo || '',
    anio: datos.anio || '',
    activo: true,
    km_inicial: Number(datos.km_inicial)||0,
    fecha_inicio_seguimiento: hoyISO()
  });
  DB.vehiculos.push(v);
  if(!DB.config.vehiculoActivo) DB.config.vehiculoActivo = v.uuid;
  save();
  return v;
}
function editarVehiculo(uuid, datos){
  const v = DB.vehiculos.find(x=>x.uuid===uuid);
  if(!v) return;
  Object.assign(v, datos);
  tocar(v);
  save();
}
function eliminarVehiculo(uuid){
  if(!confirm('¿Eliminar este vehículo y TODOS sus datos asociados (cargas, mantenimientos, componentes, gastos)? Esta acción no se puede deshacer.')) return;
  DB.vehiculos = DB.vehiculos.filter(v=>v.uuid!==uuid);
  ['cargas','mantenimientosProgramados','mantenimientosRealizados','componentes','gastosFijos','gastosVariables','alertas']
    .forEach(k => { DB[k] = DB[k].filter(r => r.vehiculoId !== uuid); });
  if(DB.config.vehiculoActivo === uuid) DB.config.vehiculoActivo = DB.vehiculos[0] ? DB.vehiculos[0].uuid : null;
  save();
  goTo('vehiculos');
}

// ── KM ACTUAL DEL VEHÍCULO (último dato conocido: carga o mantenimiento) ────
function kmActualVehiculo(vehiculoId){
  const v = DB.vehiculos.find(x=>x.uuid===vehiculoId);
  let km = v ? (v.km_inicial||0) : 0;
  DB.cargas.filter(c=>c.vehiculoId===vehiculoId).forEach(c => { if(c.km > km) km = c.km; });
  DB.mantenimientosRealizados.filter(m=>m.vehiculoId===vehiculoId).forEach(m => { if(m.kilometraje_realizado > km) km = m.kilometraje_realizado; });
  return km;
}

// ── COMBUSTIBLE ──────────────────────────────────────────────────────────────
function cargasVehiculo(vehiculoId){
  return DB.cargas.filter(c=>c.vehiculoId===vehiculoId).sort((a,b)=> a.km - b.km);
}

function registrarCarga(datos){
  const vehiculoId = datos.vehiculoId;
  const km = Number(datos.km);
  const litros = Number(datos.litros);
  const costoLitro = Number(datos.costoLitro);
  const totalPagado = Number(datos.totalPagado);
  const tanqueLleno = !!datos.tanqueLleno;
  const tipoCombustible = datos.tipoCombustible || '';
  const marca = datos.marca || '';

  const nuevaCarga = tocar({
    uuid: cvNuevoUUID(),
    vehiculoId, km, litros, costoLitro, totalPagado, tanqueLleno, tipoCombustible, marca,
    fecha: hoyISO(),
    rendimiento_calculado: null,
    litros_acumulados_desde_ultimo_lleno: null
  });

  if(tanqueLleno){
    const cargasOrdenadas = cargasVehiculo(vehiculoId); // no incluye la nueva todavía
    const ultimoLleno = [...cargasOrdenadas].reverse().find(c => c.tanqueLleno);

    if(ultimoLleno){
      const intermedias = cargasOrdenadas.filter(c => c.km > ultimoLleno.km && c.km <= km);
      const litrosAcumulados = sumar(intermedias.map(c=>c.litros)) + litros;
      const kmRecorridos = km - ultimoLleno.km;
      if(litrosAcumulados > 0 && kmRecorridos > 0){
        nuevaCarga.rendimiento_calculado = kmRecorridos / litrosAcumulados;
        nuevaCarga.litros_acumulados_desde_ultimo_lleno = litrosAcumulados;
      }
    }
  }

  DB.cargas.push(nuevaCarga);
  save();

  // Cruce con mantenimientos y componentes al actualizar el km
  const alertasMant = verificarMantenimientos(vehiculoId, km);
  const alertasComp = verificarComponentes(vehiculoId, km);
  return { carga: nuevaCarga, alertas: [...alertasMant, ...alertasComp] };
}

function eliminarCarga(uuid){
  if(!confirm('¿Eliminar esta carga? Puede afectar el cálculo de rendimiento de cargas posteriores.')) return;
  DB.cargas = DB.cargas.filter(c=>c.uuid!==uuid);
  save();
  goTo('combustible');
}

// KPI: rendimiento promedio de los últimos 3 meses
function kpiRendimientoPromedio3Meses(vehiculoId){
  const hace3Meses = new Date();
  hace3Meses.setMonth(hace3Meses.getMonth()-3);
  const cargas = DB.cargas.filter(c =>
    c.vehiculoId===vehiculoId && c.tanqueLleno && c.rendimiento_calculado &&
    new Date(c.fecha) >= hace3Meses
  );
  if(!cargas.length) return null;
  return sumar(cargas.map(c=>c.rendimiento_calculado)) / cargas.length;
}

function kpiUltimoRendimiento(vehiculoId){
  const cargas = cargasVehiculo(vehiculoId).filter(c=>c.rendimiento_calculado);
  return cargas.length ? cargas[cargas.length-1].rendimiento_calculado : null;
}

function kpiGastoCombustibleMes(vehiculoId){
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
  return sumar(DB.cargas.filter(c=>c.vehiculoId===vehiculoId && new Date(c.fecha)>=inicioMes).map(c=>c.totalPagado));
}

// ── MANTENIMIENTOS ────────────────────────────────────────────────────────────
function crearMantenimientoProgramado(datos){
  const m = tocar({
    uuid: cvNuevoUUID(),
    vehiculoId: datos.vehiculoId,
    nombre_servicio: datos.nombre_servicio,
    notas: datos.notas || '',
    intervalo_km: Number(datos.intervalo_km)
  });
  DB.mantenimientosProgramados.push(m);
  save();
  return m;
}
function editarMantenimientoProgramado(uuid, datos){
  const m = DB.mantenimientosProgramados.find(x=>x.uuid===uuid);
  if(!m) return;
  Object.assign(m, {
    nombre_servicio: datos.nombre_servicio, notas: datos.notas||'',
    intervalo_km: Number(datos.intervalo_km)
  });
  tocar(m); save();
}
function eliminarMantenimientoProgramado(uuid){
  if(!confirm('¿Eliminar este mantenimiento programado y su historial de realizaciones?')) return;
  DB.mantenimientosProgramados = DB.mantenimientosProgramados.filter(m=>m.uuid!==uuid);
  DB.mantenimientosRealizados = DB.mantenimientosRealizados.filter(m=>m.mantenimientoProgramadoId!==uuid);
  DB.alertas = DB.alertas.filter(a=>a.mantenimientoProgramadoId!==uuid);
  save();
  goTo('mantenimientos');
}

function ultimoRealizado(mantenimientoProgramadoId){
  const realizados = DB.mantenimientosRealizados
    .filter(m=>m.mantenimientoProgramadoId===mantenimientoProgramadoId)
    .sort((a,b)=>a.kilometraje_realizado - b.kilometraje_realizado);
  return realizados.length ? realizados[realizados.length-1] : null;
}

function proximoKmMantenimiento(prog){
  const ultimo = ultimoRealizado(prog.uuid);
  return ultimo ? ultimo.kilometraje_realizado + prog.intervalo_km : prog.intervalo_km;
}

function registrarMantenimientoRealizado(datos){
  const r = tocar({
    uuid: cvNuevoUUID(),
    mantenimientoProgramadoId: datos.mantenimientoProgramadoId || null,
    nombreLibre: datos.nombreLibre || '', // solo se usa cuando no hay mantenimientoProgramadoId (mantenimiento a demanda)
    vehiculoId: datos.vehiculoId,
    kilometraje_realizado: Number(datos.kilometraje_realizado),
    fecha: datos.fecha || hoyISO(),
    notas: datos.notas || '',
    costo: Number(datos.costo)||0
  });
  DB.mantenimientosRealizados.push(r);
  // Al registrar el mantenimiento, la alerta correspondiente queda atendida
  const prog = DB.mantenimientosProgramados.find(p=>p.uuid===datos.mantenimientoProgramadoId);
  if(prog){
    DB.alertas.filter(a=>a.mantenimientoProgramadoId===prog.uuid && !a.atendida)
      .forEach(a => { a.atendida = true; tocar(a); });
  }
  save();
  return r;
}
function eliminarMantenimientoRealizado(uuid){
  if(!confirm('¿Eliminar este registro de mantenimiento realizado?')) return;
  DB.mantenimientosRealizados = DB.mantenimientosRealizados.filter(m=>m.uuid!==uuid);
  save();
  goTo('mantenimientos');
}

// Cruce de km con mantenimientos programados. Se ejecuta al cargar combustible.
function verificarMantenimientos(vehiculoId, kmActual){
  const programados = DB.mantenimientosProgramados.filter(p=>p.vehiculoId===vehiculoId);
  const disparadas = [];

  programados.forEach(prog => {
    const proximoKm = proximoKmMantenimiento(prog);
    if(kmActual >= proximoKm){
      const yaAlertado = DB.alertas.some(a =>
        a.mantenimientoProgramadoId===prog.uuid && a.proximoKmEsperado===proximoKm && !a.atendida
      );
      if(!yaAlertado){
        const alerta = tocar({
          uuid: cvNuevoUUID(),
          tipo: 'mantenimiento',
          vehiculoId,
          mantenimientoProgramadoId: prog.uuid,
          kmDisparo: kmActual,
          proximoKmEsperado: proximoKm,
          fecha: hoyISO(),
          atendida: false,
          mensaje: `🔧 Toca "${prog.nombre_servicio}" (programado a los ${fmtKm(proximoKm)}, ya llevás ${fmtKm(kmActual)})`
        });
        DB.alertas.push(alerta);
        disparadas.push(alerta);
      }
    }
  });
  if(disparadas.length) save();
  return disparadas;
}

function alertasActivas(vehiculoId){
  return DB.alertas.filter(a=>a.vehiculoId===vehiculoId && !a.atendida).sort((a,b)=> new Date(b.fecha)-new Date(a.fecha));
}
function descartarAlerta(uuid){
  const a = DB.alertas.find(x=>x.uuid===uuid);
  if(!a) return;
  a.atendida = true; tocar(a); save();
  goTo(_currentView || 'dashboard');
}

// ── COMPONENTES (neumáticos, batería, otros) ─────────────────────────────────
function componentesVehiculo(vehiculoId, soloActivos=false){
  let list = DB.componentes.filter(c=>c.vehiculoId===vehiculoId);
  if(soloActivos) list = list.filter(c=>c.activo);
  return list.sort((a,b)=> new Date(b.fecha_instalacion)-new Date(a.fecha_instalacion));
}

function crearComponente(datos){
  const c = tocar({
    uuid: cvNuevoUUID(),
    vehiculoId: datos.vehiculoId,
    tipo: datos.tipo,
    descripcion: datos.descripcion || '',
    km_instalacion: Number(datos.km_instalacion),
    km_instalacion_estimado: !!datos.km_instalacion_estimado,
    fecha_instalacion: datos.fecha_instalacion || hoyISO(),
    costo: Number(datos.costo)||0,
    vida_util_estimada_km: Number(datos.vida_util_estimada_km)||0,
    vida_util_meses: Number(datos.vida_util_meses)||0,
    km_reemplazo: null,
    fecha_reemplazo: null,
    activo: true
  });
  DB.componentes.push(c);
  save();
  return c;
}

function sumarMeses(fechaISO, meses){
  const d = new Date(fechaISO);
  d.setMonth(d.getMonth() + meses);
  return d;
}
// Meses transcurridos como número fraccionario (no entero), para calcular
// porcentajes de vida útil con precisión — usado por componentes que se
// vencen por tiempo (ej: batería) en vez de por kilometraje.
function mesesTranscurridosDesde(fechaISO, hastaISO){
  const dias = (new Date(hastaISO) - new Date(fechaISO)) / 86400000;
  return dias / 30.44;
}

function reemplazarComponente(componenteAnteriorId, kmActual, nuevoComponenteDatos, fechaReemplazoElegida){
  const anterior = DB.componentes.find(c=>c.uuid===componenteAnteriorId);
  if(!anterior) return null;
  const fechaReemplazo = fechaReemplazoElegida || hoyISO();
  anterior.km_reemplazo = kmActual;
  anterior.fecha_reemplazo = fechaReemplazo;
  anterior.activo = false;
  tocar(anterior);

  const vidaUtilReal = kmActual - anterior.km_instalacion;
  const vidaUtilRealMeses = mesesTranscurridosDesde(anterior.fecha_instalacion, fechaReemplazo);
  const nuevo = crearComponente({
    ...nuevoComponenteDatos,
    vehiculoId: anterior.vehiculoId,
    km_instalacion: kmActual,
    fecha_instalacion: nuevoComponenteDatos.fecha_instalacion || fechaReemplazo
  });
  save();
  return {
    vidaUtilReal, vidaUtilRealMeses,
    diferenciaVsEstimada: anterior.vida_util_estimada_km ? vidaUtilReal - anterior.vida_util_estimada_km : null,
    diferenciaVsEstimadaMeses: anterior.vida_util_meses ? vidaUtilRealMeses - anterior.vida_util_meses : null,
    nuevo
  };
}

function eliminarComponente(uuid){
  if(!confirm('¿Eliminar este componente y su historial?')) return;
  DB.componentes = DB.componentes.filter(c=>c.uuid!==uuid);
  save();
  goTo('componentes');
}

// Edita un componente activo IN PLACE (corrige datos mal cargados), sin
// pasar por el flujo de reemplazo (que da de baja el actual y crea uno nuevo).
function editarComponente(uuid, datos){
  const c = DB.componentes.find(x=>x.uuid===uuid);
  if(!c) return;
  Object.assign(c, {
    tipo: datos.tipo,
    descripcion: datos.descripcion || '',
    km_instalacion: Number(datos.km_instalacion),
    fecha_instalacion: datos.fecha_instalacion,
    km_instalacion_estimado: !!datos.km_instalacion_estimado,
    costo: Number(datos.costo)||0,
    vida_util_estimada_km: Number(datos.vida_util_estimada_km)||0,
    vida_util_meses: Number(datos.vida_util_meses)||0
  });
  tocar(c);
  save();
}

// Un componente puede vencerse por km recorridos (neumáticos), por tiempo
// (batería, ej: 36 meses), o por ambos criterios a la vez. Se usa el que
// esté más avanzado (el que se cumpla primero) para el % de vida útil.
function estadoComponente(componente, kmActual){
  const kmRecorridos = kmActual - componente.km_instalacion;
  const mesesTranscurridos = mesesTranscurridosDesde(componente.fecha_instalacion, hoyISO());

  const tieneKm = componente.vida_util_estimada_km > 0;
  const tieneMeses = componente.vida_util_meses > 0;

  const porcentajeKm = tieneKm ? (kmRecorridos / componente.vida_util_estimada_km) * 100 : null;
  const porcentajeTiempo = tieneMeses ? (mesesTranscurridos / componente.vida_util_meses) * 100 : null;

  let porcentajeUsado = 0, criterioLimitante = null;
  if(porcentajeKm !== null){ porcentajeUsado = porcentajeKm; criterioLimitante = 'km'; }
  if(porcentajeTiempo !== null && (criterioLimitante === null || porcentajeTiempo > porcentajeUsado)){
    porcentajeUsado = porcentajeTiempo; criterioLimitante = 'tiempo';
  }
  porcentajeUsado = Math.max(0, Math.min(porcentajeUsado, 100));

  const proximoCambioEstimadoFecha = tieneMeses ? sumarMeses(componente.fecha_instalacion, componente.vida_util_meses).toISOString() : null;
  // Semanas restantes (o negativas si ya venció) — mismo lenguaje que "faltan X km"
  const semanasRestantes = tieneMeses ? Math.round((new Date(proximoCambioEstimadoFecha) - new Date()) / (86400000*7)) : null;

  return {
    kmRecorridos, mesesTranscurridos, tieneKm, tieneMeses,
    porcentajeKm, porcentajeTiempo, porcentajeUsado, criterioLimitante,
    proximoCambioEstimadoKm: tieneKm ? componente.km_instalacion + componente.vida_util_estimada_km : null,
    proximoCambioEstimadoFecha, semanasRestantes
  };
}

function historicoVidaUtilPorTipo(vehiculoId, tipo){
  return DB.componentes
    .filter(c=>c.vehiculoId===vehiculoId && c.tipo===tipo && c.km_reemplazo!==null)
    .map(c => {
      const vidaUtilRealMeses = mesesTranscurridosDesde(c.fecha_instalacion, c.fecha_reemplazo);
      return {
        descripcion: c.descripcion,
        vidaUtilReal: c.km_reemplazo - c.km_instalacion,
        vidaUtilEstimada: c.vida_util_estimada_km,
        vidaUtilRealMeses,
        vidaUtilEstimadaMeses: c.vida_util_meses,
        costo: c.costo,
        costoPorKm: (c.km_reemplazo - c.km_instalacion) > 0 ? c.costo / (c.km_reemplazo - c.km_instalacion) : 0
      };
    });
}

// Cruce de km (y de tiempo transcurrido) con vida útil de componentes activos.
// Se ejecuta al cargar combustible.
function verificarComponentes(vehiculoId, kmActual){
  const activos = componentesVehiculo(vehiculoId, true);
  const disparadas = [];
  activos.forEach(c => {
    if(!c.vida_util_estimada_km && !c.vida_util_meses) return;
    const estado = estadoComponente(c, kmActual);
    if(estado.porcentajeUsado >= 90){
      const yaAlertado = DB.alertas.some(a => a.componenteId===c.uuid && !a.atendida);
      if(!yaAlertado){
        const detalleProximo = estado.criterioLimitante === 'tiempo'
          ? (estado.semanasRestantes <= 0 ? `vencido hace ${fmtSemanas(estado.semanasRestantes)}` : `faltan ${fmtSemanas(estado.semanasRestantes)}`)
          : `~${fmtKm(estado.proximoCambioEstimadoKm)}`;
        const alerta = tocar({
          uuid: cvNuevoUUID(),
          tipo: 'componente',
          vehiculoId,
          componenteId: c.uuid,
          kmDisparo: kmActual,
          fecha: hoyISO(),
          atendida: false,
          mensaje: `🛞 ${c.tipo} (${c.descripcion||'sin descripción'}) al ${estado.porcentajeUsado.toFixed(0)}% de su vida útil ${estado.criterioLimitante==='tiempo'?'(por tiempo)':'(por km)'} — próximo cambio ${detalleProximo}`
        });
        DB.alertas.push(alerta);
        disparadas.push(alerta);
      }
    }
  });
  if(disparadas.length) save();
  return disparadas;
}

// ── GASTOS FIJOS Y VARIABLES ─────────────────────────────────────────────────
function crearGastoFijo(datos){
  const g = tocar({
    uuid: cvNuevoUUID(), vehiculoId: datos.vehiculoId,
    tipo: datos.tipo, monto: Number(datos.monto),
    periodicidad: datos.periodicidad, fecha_inicio: datos.fecha_inicio || hoyISO()
  });
  DB.gastosFijos.push(g); save(); return g;
}
function eliminarGastoFijo(uuid){
  if(!confirm('¿Eliminar este gasto fijo?')) return;
  DB.gastosFijos = DB.gastosFijos.filter(g=>g.uuid!==uuid);
  save(); goTo('gastos');
}
function crearGastoVariable(datos){
  const g = tocar({
    uuid: cvNuevoUUID(), vehiculoId: datos.vehiculoId,
    categoria: datos.categoria, descripcion: datos.descripcion||'',
    monto: Number(datos.monto), kilometraje: datos.kilometraje?Number(datos.kilometraje):null,
    fecha: datos.fecha || hoyISO()
  });
  DB.gastosVariables.push(g); save(); return g;
}
function eliminarGastoVariable(uuid){
  if(!confirm('¿Eliminar este gasto?')) return;
  DB.gastosVariables = DB.gastosVariables.filter(g=>g.uuid!==uuid);
  save(); goTo('gastos');
}

function mesesEntre(desde, hasta){
  const d = new Date(desde), h = new Date(hasta);
  return Math.max((h.getFullYear()-d.getFullYear())*12 + (h.getMonth()-d.getMonth()) + (h.getDate()>=d.getDate()?0:-1)+1, 0) || 1;
}
function prorratearGastoFijo(gasto, desde, hasta){
  const meses = mesesEntre(desde, hasta);
  if(gasto.periodicidad === 'mensual') return gasto.monto * meses;
  if(gasto.periodicidad === 'anual') return (gasto.monto/12) * meses;
  if(gasto.periodicidad === 'unico'){
    const f = new Date(gasto.fecha_inicio);
    if(f >= new Date(desde) && f <= new Date(hasta)) return gasto.monto;
    return 0;
  }
  return 0;
}

// KPI: costo por km (incluye combustible, mantenimientos, componentes reemplazados,
// gastos variables extra, y gastos fijos prorrateados)
function calcularCostoPorKm(vehiculoId, fechaInicio, fechaFin){
  const cargasRango = DB.cargas.filter(c=>c.vehiculoId===vehiculoId && c.fecha>=fechaInicio && c.fecha<=fechaFin).sort((a,b)=>a.km-b.km);
  if(!cargasRango.length) return null;
  const kmInicio = cargasRango[0].km;
  const kmFin = cargasRango[cargasRango.length-1].km;
  const kmRecorridos = kmFin - kmInicio;
  if(kmRecorridos <= 0) return null;

  const totalCombustible = sumar(cargasRango.map(c=>c.totalPagado));
  const totalMantenimientos = sumar(
    DB.mantenimientosRealizados.filter(m=>m.vehiculoId===vehiculoId && m.fecha>=fechaInicio && m.fecha<=fechaFin).map(m=>m.costo||0)
  );
  const totalComponentes = sumar(
    DB.componentes.filter(c=>c.vehiculoId===vehiculoId && c.fecha_instalacion>=fechaInicio && c.fecha_instalacion<=fechaFin).map(c=>c.costo||0)
  );
  const totalVariablesExtra = sumar(
    DB.gastosVariables.filter(g=>g.vehiculoId===vehiculoId && g.fecha>=fechaInicio && g.fecha<=fechaFin).map(g=>g.monto)
  );
  const totalFijos = sumar(
    DB.gastosFijos.filter(g=>g.vehiculoId===vehiculoId).map(g=>prorratearGastoFijo(g, fechaInicio, fechaFin))
  );

  const totalVariable = totalCombustible + totalMantenimientos + totalComponentes + totalVariablesExtra;
  const gastoTotal = totalVariable + totalFijos;

  return {
    kmRecorridos, kmInicio, kmFin,
    costoPorKmTotal: gastoTotal / kmRecorridos,
    costoPorKmVariable: totalVariable / kmRecorridos,
    desglose: { totalCombustible, totalMantenimientos, totalComponentes, totalVariablesExtra, totalFijos, gastoTotal }
  };
}

// ── MODAL DE PRÓXIMOS VENCIMIENTOS (al abrir la app, como en FinanzasPro) ───
function calcularVencimientos(vehiculoId){
  const km = kmActualVehiculo(vehiculoId);
  const items = [];

  DB.mantenimientosProgramados.filter(p=>p.vehiculoId===vehiculoId).forEach(p => {
    const proximoKm = proximoKmMantenimiento(p);
    const faltan = proximoKm - km;
    if(faltan <= UMBRAL_KM_AVISO_VENCIMIENTO){
      items.push({
        tipo: 'mantenimiento', id: p.uuid, nombre: p.nombre_servicio,
        detalle: faltan <= 0 ? `Vencido hace ${fmtKm(-faltan)}` : `Faltan ${fmtKm(faltan)}`,
        urgente: faltan <= 0,
        orden: faltan
      });
    }
  });

  componentesVehiculo(vehiculoId, true).forEach(c => {
    if(!c.vida_util_estimada_km && !c.vida_util_meses) return;
    const e = estadoComponente(c, km);
    if(e.porcentajeUsado >= UMBRAL_PORCENTAJE_AVISO_VENCIMIENTO){
      const detalle = e.criterioLimitante === 'tiempo'
        ? (e.semanasRestantes <= 0 ? `Vencido hace ${fmtSemanas(e.semanasRestantes)}` : `Faltan ${fmtSemanas(e.semanasRestantes)}`)
        : (e.porcentajeUsado>=100 ? `Vencido — límite era ${fmtKm(e.proximoCambioEstimadoKm)}` : `Vence a los ${fmtKm(e.proximoCambioEstimadoKm)}`);
      items.push({
        tipo: 'componente', id: c.uuid, nombre: `${c.tipo}${c.descripcion?' — '+c.descripcion:''}`,
        detalle: `${detalle} (${e.porcentajeUsado.toFixed(0)}%)`,
        urgente: e.porcentajeUsado >= 100,
        orden: 100 - e.porcentajeUsado
      });
    }
  });

  items.sort((a,b) => (b.urgente - a.urgente) || (a.orden - b.orden));
  return items;
}

function mostrarModalVencimientos(){
  const v = vehiculoActivo();
  if(!v) return;
  const items = calcularVencimientos(v.uuid);
  if(!items.length) return;

  const filas = items.map(it => {
    const color = it.urgente ? '#f85149' : '#d29922';
    const bg = it.urgente ? 'rgba(248,81,73,.1)' : 'rgba(210,153,34,.1)';
    const badge = it.urgente ? 'Vencido' : 'Próximo';
    const accion = it.tipo === 'mantenimiento'
      ? `<button class="btn btn-sm btn-g" onclick="cerrarModalVencimientos();modalRegistrarMantenimiento('${it.id}')">✓ Registrar</button>`
      : `<button class="btn btn-sm btn-g" onclick="cerrarModalVencimientos();modalReemplazarComponente('${it.id}')">🔄 Reemplazar</button>`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;margin-bottom:6px;background:${bg};border-left:3px solid ${color}">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700">${escHtml(it.nombre)}</div>
        <div style="font-size:11px;color:var(--text2)">${escHtml(it.detalle)}</div>
      </div>
      <span style="font-size:10px;font-weight:700;color:#fff;background:${color};padding:3px 8px;border-radius:10px;white-space:nowrap">${badge}</span>
      ${accion}
    </div>`;
  }).join('');

  const existente = document.getElementById('modal-vencimientos');
  if(existente) existente.remove();

  const ov = document.createElement('div');
  ov.id = 'modal-vencimientos';
  ov.className = 'moverlay';
  ov.style.zIndex = '1500';
  ov.innerHTML = `
    <div class="modal">
      <div class="mhead">
        <h3>⚠️ Próximos vencimientos ${btnAyuda('vencimientos')}</h3>
        <button class="btn btn-sm" onclick="cerrarModalVencimientos()">✕</button>
      </div>
      <div class="mbody">${filas}</div>
      <div class="mfoot"><button class="btn" onclick="cerrarModalVencimientos()" style="width:100%">Cerrar</button></div>
    </div>
  `;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if(e.target===ov) cerrarModalVencimientos(); });
}
function cerrarModalVencimientos(){
  const el = document.getElementById('modal-vencimientos');
  if(el) el.remove();
}

// ── NAVEGACIÓN ────────────────────────────────────────────────────────────────
let _currentView = 'dashboard';
const TITULOS = {
  dashboard: 'Dashboard', combustible: 'Combustible', mantenimientos: 'Mantenimientos',
  componentes: 'Componentes', gastos: 'Gastos', vehiculos: 'Vehículos', backup: 'Backup'
};

function toggleNav(){
  document.getElementById('nav').classList.toggle('open');
  document.getElementById('nav-overlay').classList.toggle('open');
}
function cerrarNavMobile(){
  document.getElementById('nav').classList.remove('open');
  document.getElementById('nav-overlay').classList.remove('open');
}

function actualizarSelectorVehiculo(){
  const wrap = document.getElementById('vsel-wrap');
  const sel = document.getElementById('vsel');
  if(!DB.vehiculos.length){ wrap.style.display='none'; return; }
  wrap.style.display = 'flex';
  sel.innerHTML = DB.vehiculos.map(v =>
    `<option value="${v.uuid}" ${v.uuid===DB.config.vehiculoActivo?'selected':''}>${escHtml(v.nombre)}</option>`
  ).join('');
}

// ── HELPER: botón de ayuda contextual ──
function btnAyuda(ancla){
  return `<button onclick="event.stopPropagation(); window.open('./instructivo.html#${ancla}','_blank','width=1100,height=750,resizable=yes,scrollbars=yes')" title="Ver ayuda" style="background:#f59e0b;border:none;color:#1e293b;border-radius:50%;width:20px;height:20px;font-size:10px;font-weight:800;cursor:pointer;padding:0;line-height:1;margin-left:8px;flex-shrink:0;vertical-align:middle;box-shadow:0 1px 4px rgba(0,0,0,0.3);">?</button>`;
}
const ANCLAS_AYUDA = {
  dashboard: 'dashboard', combustible: 'combustible', mantenimientos: 'mantenimientos',
  componentes: 'componentes', gastos: 'gastos', vehiculos: 'vehiculos', backup: 'backup'
};

function goTo(view){
  _currentView = view;
  cerrarNavMobile();
  document.querySelectorAll('.nav a').forEach(a=>a.classList.remove('on'));
  const navEl = document.getElementById('nav-'+view);
  if(navEl) navEl.classList.add('on');
  document.getElementById('ptitle').innerHTML = (TITULOS[view] || view) + btnAyuda(ANCLAS_AYUDA[view] || 'intro');
  document.getElementById('pacts').innerHTML = '';
  actualizarSelectorVehiculo();

  const v = vehiculoActivo();
  if(!v && view !== 'vehiculos' && view !== 'backup'){
    document.getElementById('content').innerHTML = `
      <div class="card"><div class="card-body" style="text-align:center;padding:40px">
        <div style="font-size:14px;margin-bottom:12px">Todavía no cargaste ningún vehículo.</div>
        <button class="btn btn-p" onclick="goTo('vehiculos')">🚙 Ir a Vehículos</button>
      </div></div>`;
    return;
  }

  const fn = {
    dashboard: renderDashboard, combustible: renderCombustible, mantenimientos: renderMantenimientos,
    componentes: renderComponentes, gastos: renderGastos, vehiculos: renderVehiculos, backup: renderBackup
  }[view];
  if(fn) fn();
}

function escHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── MODAL ─────────────────────────────────────────────────────────────────────
function abrirModal(titulo, bodyHtml, footHtml){
  document.getElementById('modal-title').textContent = titulo;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-foot').innerHTML = footHtml || '';
  document.getElementById('modal').style.display = 'flex';
}
function cerrarModal(){
  document.getElementById('modal').style.display = 'none';
}

// ── VISTA: DASHBOARD ──────────────────────────────────────────────────────────
function renderDashboard(){
  const v = vehiculoActivo();
  const km = kmActualVehiculo(v.uuid);
  const rendProm = kpiRendimientoPromedio3Meses(v.uuid);
  const rendUlt = kpiUltimoRendimiento(v.uuid);
  const gastoMes = kpiGastoCombustibleMes(v.uuid);

  // Costo por km: últimos 12 meses por defecto
  const hasta = hoyISO();
  const desde = new Date(); desde.setMonth(desde.getMonth()-12);
  const costoKm = calcularCostoPorKm(v.uuid, desde.toISOString(), hasta);

  const alertas = alertasActivas(v.uuid);

  document.getElementById('content').innerHTML = `
    ${alertas.length ? `
    <div class="alert-stack">
      ${alertas.map(a => `
        <div class="alert-item ${a.tipo==='componente'?'alert-crit':'alert-warn'}">
          <span>${a.mensaje}</span>
          <button class="btn btn-sm" onclick="descartarAlerta('${a.uuid}')">Descartar</button>
        </div>`).join('')}
    </div>` : ''}

    <div class="stats">
      <div class="stat"><div class="stat-n">${fmtKm(km)}</div><div class="stat-l">Km actual</div></div>
      <div class="stat"><div class="stat-n">${rendUlt ? fmtNum(rendUlt,1) : '—'}</div><div class="stat-l">Último rendim. (km/L)</div></div>
      <div class="stat"><div class="stat-n">${rendProm ? fmtNum(rendProm,1) : '—'}</div><div class="stat-l">Promedio 3 meses</div></div>
      <div class="stat"><div class="stat-n">${fmtMoney(gastoMes)}</div><div class="stat-l">Combustible este mes</div></div>
      <div class="stat"><div class="stat-n">${costoKm ? fmtMoney(costoKm.costoPorKmTotal) : '—'}</div><div class="stat-l">Costo / km (12m)</div></div>
    </div>

    <div class="card">
      <div class="ch"><div class="ct">⛽ Últimas cargas</div><button class="btn btn-sm btn-p" onclick="modalNuevaCarga()">+ Nueva carga</button></div>
      <div class="card-body twrap">
        ${renderTablaCargas(cargasVehiculo(v.uuid).slice(-5).reverse())}
      </div>
    </div>

    <div class="card">
      <div class="ch"><div class="ct">🔧 Próximos mantenimientos</div></div>
      <div class="card-body twrap">
        ${renderTablaProximosMantenimientos(v.uuid, km)}
      </div>
    </div>

    <div class="card">
      <div class="ch"><div class="ct">🛞 Estado de componentes</div></div>
      <div class="card-body twrap">
        ${renderTablaComponentesActivos(v.uuid, km)}
      </div>
    </div>
  `;
}

function renderTablaCargas(cargas){
  if(!cargas.length) return `<div class="empty">Sin cargas registradas todavía.</div>`;
  return `<table><thead><tr><th>Fecha</th><th>Km</th><th>Combustible</th><th>Litros</th><th>Total</th><th>Lleno</th><th>Rendim.</th></tr></thead><tbody>
    ${cargas.map(c=>`<tr>
      <td class="mono">${fmtFecha(c.fecha)}</td>
      <td>${fmtKm(c.km)}</td>
      <td class="text2">${escHtml(c.marca||'—')} ${c.tipoCombustible?'· '+escHtml(c.tipoCombustible):''}</td>
      <td>${fmtNum(c.litros,1)} L</td>
      <td>${fmtMoney(c.totalPagado)}</td>
      <td>${c.tanqueLleno?'✅':'—'}</td>
      <td>${c.rendimiento_calculado ? fmtNum(c.rendimiento_calculado,1)+' km/L' : '—'}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function renderTablaProximosMantenimientos(vehiculoId, km){
  const progs = DB.mantenimientosProgramados.filter(p=>p.vehiculoId===vehiculoId);
  if(!progs.length) return `<div class="empty">No hay mantenimientos programados. <a onclick="goTo('mantenimientos')" style="color:var(--primary-light);cursor:pointer">Crear uno</a></div>`;
  const filas = progs.map(p => {
    const proximoKm = proximoKmMantenimiento(p);
    const faltan = proximoKm - km;
    return { p, proximoKm, faltan };
  }).sort((a,b)=>a.faltan-b.faltan);
  return `<table><thead><tr><th>Servicio</th><th>Próximo km</th><th>Faltan</th></tr></thead><tbody>
    ${filas.map(f=>`<tr>
      <td>${escHtml(f.p.nombre_servicio)}</td>
      <td>${fmtKm(f.proximoKm)}</td>
      <td class="${f.faltan<=0?'red':(f.faltan<1000?'amber':'')}">${f.faltan<=0?'¡Toca ahora!':fmtKm(f.faltan)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function renderTablaComponentesActivos(vehiculoId, km){
  const activos = componentesVehiculo(vehiculoId, true);
  if(!activos.length) return `<div class="empty">No hay componentes registrados. <a onclick="goTo('componentes')" style="color:var(--primary-light);cursor:pointer">Agregar uno</a></div>`;
  return activos.map(c => {
    const e = estadoComponente(c, km);
    const cls = e.porcentajeUsado>=90?'vprog-crit':(e.porcentajeUsado>=70?'vprog-warn':'vprog-ok');
    const proximo = e.criterioLimitante === 'tiempo'
      ? `${e.semanasRestantes<=0?`Vencido hace ${fmtSemanas(e.semanasRestantes)}`:`Faltan ${fmtSemanas(e.semanasRestantes)}`} (${fmtFecha(e.proximoCambioEstimadoFecha)})`
      : `Próximo cambio estimado: ${fmtKm(e.proximoCambioEstimadoKm)}`;
    return `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">
        <span>${c.tipo}${c.descripcion?' — '+escHtml(c.descripcion):''}</span>
        <span class="text2">${e.porcentajeUsado.toFixed(0)}%</span>
      </div>
      <div class="vprog"><div class="vprog-bar ${cls}" style="width:${e.porcentajeUsado}%"></div></div>
      <div class="text3" style="font-size:11px">${proximo}</div>
    </div>`;
  }).join('');
}

// ── VISTA: COMBUSTIBLE ────────────────────────────────────────────────────────
function renderCombustible(){
  const v = vehiculoActivo();
  document.getElementById('pacts').innerHTML = `<button class="btn btn-p btn-sm" onclick="modalNuevaCarga()">+ Nueva carga</button>`;
  const cargas = cargasVehiculo(v.uuid).reverse();
  const rendProm = kpiRendimientoPromedio3Meses(v.uuid);
  document.getElementById('content').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="stat-n">${rendProm?fmtNum(rendProm,1):'—'}</div><div class="stat-l">Prom. km/L (3m)</div></div>
      <div class="stat"><div class="stat-n">${cargas.length}</div><div class="stat-l">Cargas registradas</div></div>
    </div>
    <div class="card"><div class="card-body twrap">
      ${cargas.length ? `<table><thead><tr><th>Fecha</th><th>Km</th><th>Marca</th><th>Tipo</th><th>Litros</th><th>$/L</th><th>Total</th><th>Lleno</th><th>Rendim.</th><th></th></tr></thead><tbody>
      ${cargas.map(c=>`<tr>
        <td class="mono">${fmtFecha(c.fecha)}</td>
        <td>${fmtKm(c.km)}</td>
        <td>${escHtml(c.marca||'—')}</td>
        <td>${escHtml(c.tipoCombustible||'—')}</td>
        <td>${fmtNum(c.litros,1)} L</td>
        <td>${fmtMoney(c.costoLitro)}</td>
        <td>${fmtMoney(c.totalPagado)}</td>
        <td>${c.tanqueLleno?'✅':'—'}</td>
        <td>${c.rendimiento_calculado?fmtNum(c.rendimiento_calculado,1)+' km/L':'—'}</td>
        <td><button class="btn btn-sm btn-d" onclick="eliminarCarga('${c.uuid}')">✕</button></td>
      </tr>`).join('')}
      </tbody></table>` : `<div class="empty">Sin cargas todavía.</div>`}
    </div></div>
  `;
}

function modalNuevaCarga(){
  const v = vehiculoActivo();
  const kmSugerido = kmActualVehiculo(v.uuid);
  const marcaSugerida = DB.config.ultimaMarca || MARCAS_COMBUSTIBLE[0];
  const tipoSugerido = DB.config.ultimoTipoCombustible || TIPOS_COMBUSTIBLE[0];
  abrirModal('⛽ Nueva carga de combustible', `
    <div class="fg"><label>Kilometraje actual</label><input type="number" inputmode="numeric" id="f-km" value="${kmSugerido||''}" placeholder="km" onfocus="this.select()"></div>
    <div class="fgrid">
      <div class="fg"><label>Marca</label><select id="f-marca">${MARCAS_COMBUSTIBLE.map(m=>`<option ${m===marcaSugerida?'selected':''}>${m}</option>`).join('')}</select></div>
      <div class="fg"><label>Tipo</label><select id="f-tipoCombustible">${TIPOS_COMBUSTIBLE.map(t=>`<option ${t===tipoSugerido?'selected':''}>${t}</option>`).join('')}</select></div>
    </div>
    <div class="fgrid">
      <div class="fg"><label>Litros cargados</label><input type="number" inputmode="decimal" id="f-litros" step="0.01" placeholder="L" onfocus="this.select()" onchange="recalcularCarga('f-','litros')"></div>
      <div class="fg"><label>Costo por litro</label><input type="number" inputmode="decimal" id="f-costoLitro" step="0.01" placeholder="$" onfocus="this.select()" onchange="recalcularCarga('f-','costoLitro')"></div>
    </div>
    <div class="fg"><label>Total pagado</label><input type="number" inputmode="decimal" id="f-total" step="0.01" placeholder="$" onfocus="this.select()" onchange="recalcularCarga('f-','total')"></div>
    <div class="fg" style="flex-direction:row;align-items:center;gap:10px;margin-top:6px">
      <input type="checkbox" id="f-lleno" checked style="width:18px;height:18px;accent-color:var(--primary)">
      <label style="text-transform:none;font-size:13px">⛽ ¿Tanque lleno?</label>
    </div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="guardarNuevaCarga()">Guardar</button>
  `);
  setTimeout(()=>document.getElementById('f-km').focus(), 50);
}
// Completa automáticamente el campo que falte entre litros / precio-por-litro / total,
// sea cual sea el orden en que se carguen los otros dos. Nunca pisa el campo que se
// está tipeando en ese momento. Sirve para el modal de PC ('f-') y la vista rápida
// del celular ('vr-').
function recalcularCarga(prefix, campoEditado){
  const elLitros = document.getElementById(prefix+'litros');
  const elCosto = document.getElementById(prefix+'costoLitro');
  const elTotal = document.getElementById(prefix+'total');
  const litros = Number(elLitros.value);
  const costo = Number(elCosto.value);
  const total = Number(elTotal.value);
  const tieneLitros = litros > 0;
  const tieneCosto = costo > 0;
  const tieneTotal = total > 0;

  if(campoEditado !== 'total' && tieneLitros && tieneCosto){
    elTotal.value = (litros*costo).toFixed(2);
  } else if(campoEditado !== 'costoLitro' && tieneLitros && tieneTotal){
    elCosto.value = (total/litros).toFixed(2);
  } else if(campoEditado !== 'litros' && tieneCosto && tieneTotal){
    elLitros.value = (total/costo).toFixed(2);
  }
}
function guardarNuevaCarga(){
  const v = vehiculoActivo();
  const km = Number(document.getElementById('f-km').value);
  const marca = document.getElementById('f-marca').value;
  const tipoCombustible = document.getElementById('f-tipoCombustible').value;
  const litros = Number(document.getElementById('f-litros').value);
  const costoLitro = Number(document.getElementById('f-costoLitro').value);
  const totalPagado = Number(document.getElementById('f-total').value);
  const tanqueLleno = document.getElementById('f-lleno').checked;
  if(!km || !litros || !totalPagado){ alert('Completá km, litros y total.'); return; }
  DB.config.ultimaMarca = marca;
  DB.config.ultimoTipoCombustible = tipoCombustible;
  cerrarModal();
  const { carga, alertas } = registrarCarga({ vehiculoId: v.uuid, km, marca, tipoCombustible, litros, costoLitro, totalPagado, tanqueLleno });
  goTo('combustible');
  if(carga.rendimiento_calculado){
    setTimeout(()=>alert(`✅ Carga guardada.\nRendimiento: ${fmtNum(carga.rendimiento_calculado,1)} km/L`), 100);
  }
  if(alertas.length){
    setTimeout(()=>alert(alertas.map(a=>a.mensaje).join('\n\n')), carga.rendimiento_calculado?300:100);
  }
}

// ── VISTA: MANTENIMIENTOS ─────────────────────────────────────────────────────
function renderMantenimientos(){
  const v = vehiculoActivo();
  const km = kmActualVehiculo(v.uuid);
  document.getElementById('pacts').innerHTML = `
    <button class="btn btn-sm" onclick="modalMantenimientoADemanda()">+ A demanda</button>
    <button class="btn btn-p btn-sm" onclick="modalNuevoMantenimientoProgramado()">+ Programar servicio</button>
  `;
  const progs = DB.mantenimientosProgramados.filter(p=>p.vehiculoId===v.uuid);

  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="ch"><div class="ct">🔧 Servicios programados</div></div>
      <div class="card-body twrap">
        ${!progs.length ? `<div class="empty">No hay servicios programados todavía.</div>` : `
        <table><thead><tr><th>Servicio</th><th>Intervalo</th><th>Último realizado</th><th>Próximo km</th><th></th></tr></thead><tbody>
        ${progs.map(p=>{
          const ultimo = ultimoRealizado(p.uuid);
          const proximoKm = proximoKmMantenimiento(p);
          const faltan = proximoKm - km;
          return `<tr>
            <td>${escHtml(p.nombre_servicio)}${p.notas?`<div class="text3" style="font-size:11px">${escHtml(p.notas)}</div>`:''}</td>
            <td>cada ${fmtKm(p.intervalo_km)}</td>
            <td>${ultimo ? fmtKm(ultimo.kilometraje_realizado)+' · '+fmtFecha(ultimo.fecha) : '—'}</td>
            <td class="${faltan<=0?'red':(faltan<1000?'amber':'')}">${fmtKm(proximoKm)} ${faltan<=0?'⚠️':''}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-sm btn-g" onclick="modalRegistrarMantenimiento('${p.uuid}')">✓ Registrar</button>
              <button class="btn btn-sm" onclick="modalEditarMantenimientoProgramado('${p.uuid}')">✎</button>
              <button class="btn btn-sm btn-d" onclick="eliminarMantenimientoProgramado('${p.uuid}')">✕</button>
            </td>
          </tr>`;
        }).join('')}
        </tbody></table>`}
      </div>
    </div>

    <div class="card">
      <div class="ch"><div class="ct">📋 Historial de mantenimientos realizados</div></div>
      <div class="card-body twrap">
        <p class="text3" style="font-size:11px;margin-bottom:10px">Incluye tanto los servicios programados como los mantenimientos a demanda (los que no se repiten en un intervalo fijo, ej: cambio de lámpara, alineación y balanceo).</p>
        ${renderHistorialMantenimientos(v.uuid)}
      </div>
    </div>
  `;
}
function renderHistorialMantenimientos(vehiculoId){
  const realizados = DB.mantenimientosRealizados.filter(m=>m.vehiculoId===vehiculoId).sort((a,b)=>new Date(b.fecha)-new Date(a.fecha));
  if(!realizados.length) return `<div class="empty">Sin registros todavía.</div>`;
  return `<table><thead><tr><th>Fecha</th><th>Servicio</th><th>Km</th><th>Costo</th><th>Notas</th><th></th></tr></thead><tbody>
    ${realizados.map(r=>{
      const prog = DB.mantenimientosProgramados.find(p=>p.uuid===r.mantenimientoProgramadoId);
      const nombre = prog ? escHtml(prog.nombre_servicio) : (r.nombreLibre ? escHtml(r.nombreLibre)+' <span class="text3" style="font-size:10px">(a demanda)</span>' : '—');
      return `<tr>
        <td class="mono">${fmtFecha(r.fecha)}</td>
        <td>${nombre}</td>
        <td>${fmtKm(r.kilometraje_realizado)}</td>
        <td>${fmtMoney(r.costo)}</td>
        <td class="text2">${escHtml(r.notas)}</td>
        <td><button class="btn btn-sm btn-d" onclick="eliminarMantenimientoRealizado('${r.uuid}')">✕</button></td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

function modalNuevoMantenimientoProgramado(){
  abrirModal('🔧 Programar servicio', `
    <div class="fg"><label>Nombre del servicio</label><input type="text" id="f-nombre" placeholder="Ej: Cambio de aceite"></div>
    <div class="fg"><label>Intervalo (cada cuántos km)</label><input type="number" inputmode="numeric" id="f-intervalo" placeholder="Ej: 10000"></div>
    <div class="fg"><label>Notas</label><textarea id="f-notas" placeholder="Opcional"></textarea></div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="guardarNuevoMantenimientoProgramado()">Guardar</button>
  `);
}
function guardarNuevoMantenimientoProgramado(){
  const v = vehiculoActivo();
  const nombre_servicio = document.getElementById('f-nombre').value.trim();
  const intervalo_km = Number(document.getElementById('f-intervalo').value);
  const notas = document.getElementById('f-notas').value.trim();
  if(!nombre_servicio || !intervalo_km){ alert('Completá nombre e intervalo.'); return; }
  crearMantenimientoProgramado({ vehiculoId: v.uuid, nombre_servicio, intervalo_km, notas });
  cerrarModal(); goTo('mantenimientos');
}
function modalEditarMantenimientoProgramado(uuid){
  const p = DB.mantenimientosProgramados.find(x=>x.uuid===uuid);
  if(!p) return;
  abrirModal('✎ Editar servicio', `
    <div class="fg"><label>Nombre del servicio</label><input type="text" id="f-nombre" value="${escHtml(p.nombre_servicio)}"></div>
    <div class="fg"><label>Intervalo (km)</label><input type="number" inputmode="numeric" id="f-intervalo" value="${p.intervalo_km}"></div>
    <div class="fg"><label>Notas</label><textarea id="f-notas">${escHtml(p.notas)}</textarea></div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="editarMantenimientoProgramado('${uuid}', {nombre_servicio:document.getElementById('f-nombre').value.trim(), intervalo_km:document.getElementById('f-intervalo').value, notas:document.getElementById('f-notas').value.trim()}); cerrarModal(); goTo('mantenimientos');">Guardar</button>
  `);
}
function modalRegistrarMantenimiento(mantenimientoProgramadoId){
  const v = vehiculoActivo();
  const prog = DB.mantenimientosProgramados.find(p=>p.uuid===mantenimientoProgramadoId);
  const kmSugerido = kmActualVehiculo(v.uuid);
  abrirModal(`✓ Registrar: ${escHtml(prog.nombre_servicio)}`, `
    <div class="fgrid">
      <div class="fg"><label>Kilometraje</label><input type="number" inputmode="numeric" id="f-km" value="${kmSugerido||''}" onfocus="this.select()"></div>
      <div class="fg"><label>Fecha de realización</label><input type="date" id="f-fecha" value="${new Date().toISOString().slice(0,10)}"></div>
    </div>
    <div class="fg"><label>Costo</label><input type="number" inputmode="decimal" id="f-costo" step="0.01" placeholder="$"></div>
    <div class="fg"><label>Notas</label><textarea id="f-notas" placeholder="Opcional"></textarea></div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="guardarMantenimientoRealizado('${mantenimientoProgramadoId}')">Guardar</button>
  `);
}
function guardarMantenimientoRealizado(mantenimientoProgramadoId){
  const v = vehiculoActivo();
  const kilometraje_realizado = Number(document.getElementById('f-km').value);
  const costoRaw = document.getElementById('f-costo').value;
  const fecha = new Date(document.getElementById('f-fecha').value).toISOString();
  const notas = document.getElementById('f-notas').value.trim();
  if(!kilometraje_realizado){ alert('Ingresá el kilometraje.'); return; }
  if(costoRaw === ''){ alert('Ingresá el costo del servicio (poné 0 si fue sin cargo).'); return; }
  const costo = Number(costoRaw);
  registrarMantenimientoRealizado({ mantenimientoProgramadoId, vehiculoId: v.uuid, kilometraje_realizado, costo, fecha, notas });
  cerrarModal(); goTo('mantenimientos');
}

// Mantenimiento a demanda: para servicios puntuales que NO se repiten con un
// intervalo fijo de km (cambio de lámpara, alineación y balanceo, etc).
// No genera un mantenimientoProgramado ni alertas futuras, solo queda en el
// historial y suma al costo por km igual que cualquier otro mantenimiento.
function modalMantenimientoADemanda(){
  const v = vehiculoActivo();
  const kmSugerido = kmActualVehiculo(v.uuid);
  abrirModal('🔧 Mantenimiento a demanda', `
    <div class="fg">
      <label>Servicio realizado</label>
      <input type="text" id="f-nombreLibre" list="sugerencias-demanda" placeholder="Ej: Cambio de lámpara">
      <datalist id="sugerencias-demanda">
        ${SUGERENCIAS_MANTENIMIENTO_DEMANDA.map(s=>`<option value="${s}">`).join('')}
      </datalist>
    </div>
    <div class="fgrid">
      <div class="fg"><label>Kilometraje</label><input type="number" inputmode="numeric" id="f-km" value="${kmSugerido||''}" onfocus="this.select()"></div>
      <div class="fg"><label>Fecha de realización</label><input type="date" id="f-fecha" value="${new Date().toISOString().slice(0,10)}"></div>
    </div>
    <div class="fg"><label>Costo</label><input type="number" inputmode="decimal" id="f-costo" step="0.01" placeholder="$"></div>
    <div class="fg"><label>Notas</label><textarea id="f-notas" placeholder="Opcional"></textarea></div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="guardarMantenimientoADemanda()">Guardar</button>
  `);
  setTimeout(()=>document.getElementById('f-nombreLibre').focus(), 50);
}
function guardarMantenimientoADemanda(){
  const v = vehiculoActivo();
  const nombreLibre = document.getElementById('f-nombreLibre').value.trim();
  const kilometraje_realizado = Number(document.getElementById('f-km').value);
  const costoRaw = document.getElementById('f-costo').value;
  const fecha = new Date(document.getElementById('f-fecha').value).toISOString();
  const notas = document.getElementById('f-notas').value.trim();
  if(!nombreLibre){ alert('Ingresá qué servicio se realizó.'); return; }
  if(!kilometraje_realizado){ alert('Ingresá el kilometraje.'); return; }
  if(costoRaw === ''){ alert('Ingresá el costo del servicio (poné 0 si fue sin cargo).'); return; }
  const costo = Number(costoRaw);
  registrarMantenimientoRealizado({ mantenimientoProgramadoId: null, nombreLibre, vehiculoId: v.uuid, kilometraje_realizado, costo, fecha, notas });
  cerrarModal(); goTo('mantenimientos');
}

// ── VISTA: COMPONENTES (neumáticos / batería) ────────────────────────────────
function renderComponentes(){
  const v = vehiculoActivo();
  const km = kmActualVehiculo(v.uuid);
  document.getElementById('pacts').innerHTML = `<button class="btn btn-p btn-sm" onclick="modalNuevoComponente()">+ Nuevo componente</button>`;
  const activos = componentesVehiculo(v.uuid, true);
  const historicos = DB.componentes.filter(c=>c.vehiculoId===v.uuid && !c.activo).sort((a,b)=>new Date(b.fecha_reemplazo)-new Date(a.fecha_reemplazo));

  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="ch"><div class="ct">🛞 Componentes activos</div></div>
      <div class="card-body">
        ${!activos.length ? `<div class="empty">No hay componentes activos.</div>` : activos.map(c=>{
          const e = estadoComponente(c, km);
          const cls = e.porcentajeUsado>=90?'vprog-crit':(e.porcentajeUsado>=70?'vprog-warn':'vprog-ok');
          const partesDetalle = [];
          if(e.tieneKm) partesDetalle.push(`${fmtKm(e.kmRecorridos)} recorridos (${e.porcentajeKm.toFixed(0)}% por km)`);
          if(e.tieneMeses) partesDetalle.push(`${e.mesesTranscurridos.toFixed(1)} meses transcurridos (${e.porcentajeTiempo.toFixed(0)}% por tiempo)`);
          const partesProximo = [];
          if(e.tieneKm) partesProximo.push(`~${fmtKm(e.proximoCambioEstimadoKm)}`);
          if(e.tieneMeses) partesProximo.push(`${e.semanasRestantes<=0?`vencido hace ${fmtSemanas(e.semanasRestantes)}`:`faltan ${fmtSemanas(e.semanasRestantes)}`} (~${fmtFecha(e.proximoCambioEstimadoFecha)})`);
          return `<div class="card" style="margin-bottom:10px">
            <div class="card-body">
              <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:6px">
                <div>
                  <div style="font-weight:700">${c.tipo}${c.descripcion?' — '+escHtml(c.descripcion):''}</div>
                  <div class="text3" style="font-size:11px">Instalado: ${fmtKm(c.km_instalacion)} · ${fmtFecha(c.fecha_instalacion)}${c.km_instalacion_estimado?' <span class="amber">⚠️ estimado</span>':' ✅'}</div>
                </div>
                <div style="text-align:right">
                  <button class="btn btn-sm" onclick="modalEditarComponente('${c.uuid}')">✎ Editar</button>
                  <button class="btn btn-sm btn-g" onclick="modalReemplazarComponente('${c.uuid}')">🔄 Reemplazar</button>
                  <button class="btn btn-sm btn-d" onclick="eliminarComponente('${c.uuid}')">✕</button>
                </div>
              </div>
              <div class="vprog"><div class="vprog-bar ${cls}" style="width:${e.porcentajeUsado}%"></div></div>
              <div style="font-size:11px" class="text2">${partesDetalle.join(' · ')}</div>
              <div style="font-size:11px" class="text3">Próx. cambio: ${partesProximo.join(' o ')}${e.criterioLimitante ? ` — limita por ${e.criterioLimitante==='tiempo'?'tiempo':'km'}` : ''}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="card">
      <div class="ch"><div class="ct">📋 Historial de reemplazos</div></div>
      <div class="card-body twrap">
        ${!historicos.length ? `<div class="empty">Sin reemplazos registrados todavía.</div>` : `
        <table><thead><tr><th>Tipo</th><th>Instalado</th><th>Reemplazado</th><th>Vida útil real</th><th>Estimada</th><th>Costo</th><th>$/km</th></tr></thead><tbody>
        ${historicos.map(c=>{
          const vidaReal = c.km_reemplazo - c.km_instalacion;
          const vidaRealMeses = mesesTranscurridosDesde(c.fecha_instalacion, c.fecha_reemplazo);
          const costoPorKm = vidaReal>0 ? c.costo/vidaReal : 0;
          const realParts = [];
          if(c.vida_util_estimada_km) realParts.push(fmtKm(vidaReal));
          if(c.vida_util_meses) realParts.push(`${vidaRealMeses.toFixed(1)} m`);
          const estParts = [];
          if(c.vida_util_estimada_km) estParts.push(fmtKm(c.vida_util_estimada_km));
          if(c.vida_util_meses) estParts.push(`${c.vida_util_meses} m`);
          return `<tr>
            <td>${c.tipo}${c.descripcion?' — '+escHtml(c.descripcion):''}</td>
            <td>${fmtKm(c.km_instalacion)}</td>
            <td>${fmtKm(c.km_reemplazo)}</td>
            <td>${realParts.join(' / ')||'—'}</td>
            <td>${estParts.join(' / ')||'—'}</td>
            <td>${fmtMoney(c.costo)}</td>
            <td>${fmtMoney(costoPorKm)}</td>
          </tr>`;
        }).join('')}
        </tbody></table>`}
      </div>
    </div>
  `;
}

// Tipos disponibles para el combobox: los 3 base + cualquier tipo custom
// que el usuario haya escrito antes en otros componentes (así queda como
// sugerencia la próxima vez, sin perder la posibilidad de escribir uno nuevo).
function tiposComponenteDisponibles(){
  const usados = DB.componentes.map(c=>c.tipo).filter(Boolean);
  const set = new Set([...TIPOS_COMPONENTE, ...DB.tiposComponenteCustom, ...usados]);
  return Array.from(set).sort((a,b)=>a.localeCompare(b,'es'));
}
// Guarda un tipo nuevo como sugerencia persistente (si no es uno de los 3 base
// ni ya está guardado), independiente de si el componente que lo usó se borra después.
function recordarTipoComponenteCustom(tipo){
  if(!tipo) return;
  if(TIPOS_COMPONENTE.includes(tipo)) return;
  if(DB.tiposComponenteCustom.includes(tipo)) return;
  DB.tiposComponenteCustom.push(tipo);
  save();
}
function eliminarTipoComponenteCustom(tipo){
  DB.tiposComponenteCustom = DB.tiposComponenteCustom.filter(t=>t!==tipo);
  save();
  const cont = document.getElementById('tipos-custom-chips');
  if(cont) cont.innerHTML = renderChipsTiposCustom();
}
function renderChipsTiposCustom(){
  if(!DB.tiposComponenteCustom.length) return '';
  return `<div style="font-size:11px;color:var(--text3);margin-top:2px">Sugerencias guardadas: ${
    DB.tiposComponenteCustom.map(t=>`<span style="display:inline-flex;align-items:center;gap:4px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:2px 4px 2px 8px;margin:2px 4px 2px 0">${escHtml(t)}<button onclick="eliminarTipoComponenteCustom('${escHtml(t).replace(/'/g,"\\'")}')" style="border:none;background:transparent;color:var(--text3);cursor:pointer;font-size:12px;padding:0 4px" title="Borrar sugerencia">✕</button></span>`).join('')
  }</div>`;
}

function modalNuevoComponente(){
  const v = vehiculoActivo();
  const kmSugerido = kmActualVehiculo(v.uuid);
  abrirModal('🛞 Nuevo componente', `
    <div class="fg">
      <label>Tipo</label>
      <input type="text" id="f-tipo" list="tipos-componente-datalist" placeholder="Ej: Neumáticos">
      <datalist id="tipos-componente-datalist">
        ${tiposComponenteDisponibles().map(t=>`<option value="${escHtml(t)}">`).join('')}
      </datalist>
      <div id="tipos-custom-chips">${renderChipsTiposCustom()}</div>
    </div>
    <div class="fg"><label>Descripción</label><input type="text" id="f-desc" placeholder="Ej: Bridgestone 195/65"></div>
    <div class="fgrid">
      <div class="fg"><label>Km de instalación</label><input type="number" inputmode="numeric" id="f-km" value="${kmSugerido||''}" onfocus="this.select()"></div>
      <div class="fg"><label>Fecha de instalación</label><input type="date" id="f-fecha" value="${new Date().toISOString().slice(0,10)}"></div>
    </div>
    <div class="fg" style="flex-direction:row;align-items:center;gap:8px">
      <input type="checkbox" id="f-estimado" style="width:16px;height:16px;accent-color:var(--primary)">
      <label style="text-transform:none;font-size:12px">El km y/o la fecha son estimados (ya estaba puesto cuando empecé a usar la app)</label>
    </div>
    <div class="fg"><label>Costo</label><input type="number" inputmode="decimal" id="f-costo" step="0.01" placeholder="$" onfocus="this.select()"></div>
    <p class="text3" style="font-size:11px;margin-bottom:6px">Completá el criterio de vida útil que corresponda — por km (neumáticos), por tiempo desde la fecha de instalación (batería), o ambos si querés que alerte con el que se cumpla primero.</p>
    <div class="fgrid">
      <div class="fg"><label>Vida útil (km)</label><input type="number" inputmode="numeric" id="f-vidautil" placeholder="Ej: 50000" onfocus="this.select()"></div>
      <div class="fg"><label>Vida útil (meses)</label><input type="number" inputmode="numeric" id="f-vidautilmeses" placeholder="Ej: 36" onfocus="this.select()"></div>
    </div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="guardarNuevoComponente()">Guardar</button>
  `);
}
function guardarNuevoComponente(){
  const v = vehiculoActivo();
  const tipo = document.getElementById('f-tipo').value.trim();
  const descripcion = document.getElementById('f-desc').value.trim();
  const km_instalacion = Number(document.getElementById('f-km').value);
  const fecha_instalacion = new Date(document.getElementById('f-fecha').value).toISOString();
  const km_instalacion_estimado = document.getElementById('f-estimado').checked;
  const costo = Number(document.getElementById('f-costo').value)||0;
  const vida_util_estimada_km = Number(document.getElementById('f-vidautil').value)||0;
  const vida_util_meses = Number(document.getElementById('f-vidautilmeses').value)||0;
  if(!tipo){ alert('Ingresá el tipo de componente.'); return; }
  if(!km_instalacion){ alert('Ingresá el km de instalación.'); return; }
  if(!vida_util_estimada_km && !vida_util_meses){ alert('Ingresá al menos un criterio de vida útil: km o meses.'); return; }
  recordarTipoComponenteCustom(tipo);
  crearComponente({ vehiculoId: v.uuid, tipo, descripcion, km_instalacion, fecha_instalacion, km_instalacion_estimado, costo, vida_util_estimada_km, vida_util_meses });
  cerrarModal(); goTo('componentes');
}
function modalEditarComponente(uuid){
  const c = DB.componentes.find(x=>x.uuid===uuid);
  if(!c) return;
  abrirModal(`✎ Editar: ${escHtml(c.tipo)}`, `
    <div class="fg">
      <label>Tipo</label>
      <input type="text" id="f-tipo" list="tipos-componente-datalist" value="${escHtml(c.tipo)}">
      <datalist id="tipos-componente-datalist">
        ${tiposComponenteDisponibles().map(t=>`<option value="${escHtml(t)}">`).join('')}
      </datalist>
      <div id="tipos-custom-chips">${renderChipsTiposCustom()}</div>
    </div>
    <div class="fg"><label>Descripción</label><input type="text" id="f-desc" value="${escHtml(c.descripcion)}"></div>
    <div class="fgrid">
      <div class="fg"><label>Km de instalación</label><input type="number" inputmode="numeric" id="f-km" value="${c.km_instalacion}" onfocus="this.select()"></div>
      <div class="fg"><label>Fecha de instalación</label><input type="date" id="f-fecha" value="${c.fecha_instalacion.slice(0,10)}"></div>
    </div>
    <div class="fg" style="flex-direction:row;align-items:center;gap:8px">
      <input type="checkbox" id="f-estimado" ${c.km_instalacion_estimado?'checked':''} style="width:16px;height:16px;accent-color:var(--primary)">
      <label style="text-transform:none;font-size:12px">El km y/o la fecha son estimados</label>
    </div>
    <div class="fg"><label>Costo</label><input type="number" inputmode="decimal" id="f-costo" step="0.01" value="${c.costo||''}" onfocus="this.select()"></div>
    <div class="fgrid">
      <div class="fg"><label>Vida útil (km)</label><input type="number" inputmode="numeric" id="f-vidautil" value="${c.vida_util_estimada_km||''}" onfocus="this.select()"></div>
      <div class="fg"><label>Vida útil (meses)</label><input type="number" inputmode="numeric" id="f-vidautilmeses" value="${c.vida_util_meses||''}" onfocus="this.select()"></div>
    </div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="guardarEdicionComponente('${uuid}')">Guardar</button>
  `);
}
function guardarEdicionComponente(uuid){
  const tipo = document.getElementById('f-tipo').value.trim();
  const descripcion = document.getElementById('f-desc').value.trim();
  const km_instalacion = Number(document.getElementById('f-km').value);
  const fecha_instalacion = new Date(document.getElementById('f-fecha').value).toISOString();
  const km_instalacion_estimado = document.getElementById('f-estimado').checked;
  const costo = Number(document.getElementById('f-costo').value)||0;
  const vida_util_estimada_km = Number(document.getElementById('f-vidautil').value)||0;
  const vida_util_meses = Number(document.getElementById('f-vidautilmeses').value)||0;
  if(!tipo){ alert('Ingresá el tipo de componente.'); return; }
  if(!km_instalacion){ alert('Ingresá el km de instalación.'); return; }
  if(!vida_util_estimada_km && !vida_util_meses){ alert('Ingresá al menos un criterio de vida útil: km o meses.'); return; }
  recordarTipoComponenteCustom(tipo);
  editarComponente(uuid, { tipo, descripcion, km_instalacion, fecha_instalacion, km_instalacion_estimado, costo, vida_util_estimada_km, vida_util_meses });
  cerrarModal(); goTo('componentes');
}
function modalReemplazarComponente(uuid){
  const v = vehiculoActivo();
  const anterior = DB.componentes.find(c=>c.uuid===uuid);
  const kmSugerido = kmActualVehiculo(v.uuid);
  abrirModal(`🔄 Reemplazar: ${anterior.tipo}`, `
    <div class="fgrid">
      <div class="fg"><label>Km actual (del reemplazo)</label><input type="number" inputmode="numeric" id="f-km" value="${kmSugerido||''}" onfocus="this.select()"></div>
      <div class="fg"><label>Fecha del reemplazo</label><input type="date" id="f-fecha-reemplazo" value="${new Date().toISOString().slice(0,10)}"></div>
    </div>
    <div style="border-top:1px solid var(--border);margin:12px 0;padding-top:12px">
      <div class="text2" style="font-size:11px;margin-bottom:8px;text-transform:uppercase;font-weight:700">Datos del componente nuevo</div>
      <div class="fg"><label>Descripción</label><input type="text" id="f-desc" placeholder="Ej: Bridgestone 195/65"></div>
      <div class="fg"><label>Fecha de instalación (del nuevo)</label><input type="date" id="f-fecha" value="${new Date().toISOString().slice(0,10)}"></div>
      <div class="fg"><label>Costo</label><input type="number" inputmode="decimal" id="f-costo" step="0.01" placeholder="$" onfocus="this.select()"></div>
      <div class="fgrid">
        <div class="fg"><label>Vida útil (km)</label><input type="number" inputmode="numeric" id="f-vidautil" value="${anterior.vida_util_estimada_km||''}" onfocus="this.select()"></div>
        <div class="fg"><label>Vida útil (meses)</label><input type="number" inputmode="numeric" id="f-vidautilmeses" value="${anterior.vida_util_meses||''}" onfocus="this.select()"></div>
      </div>
    </div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="guardarReemplazoComponente('${uuid}')">Guardar</button>
  `);
}
function guardarReemplazoComponente(uuid){
  const km = Number(document.getElementById('f-km').value);
  const fechaReemplazo = new Date(document.getElementById('f-fecha-reemplazo').value).toISOString();
  const descripcion = document.getElementById('f-desc').value.trim();
  const fecha_instalacion = new Date(document.getElementById('f-fecha').value).toISOString();
  const costo = Number(document.getElementById('f-costo').value)||0;
  const vida_util_estimada_km = Number(document.getElementById('f-vidautil').value)||0;
  const vida_util_meses = Number(document.getElementById('f-vidautilmeses').value)||0;
  const anterior = DB.componentes.find(c=>c.uuid===uuid);
  if(!km){ alert('Ingresá el km actual.'); return; }
  const resultado = reemplazarComponente(uuid, km, { tipo: anterior.tipo, descripcion, costo, vida_util_estimada_km, vida_util_meses, fecha_instalacion }, fechaReemplazo);
  cerrarModal(); goTo('componentes');
  if(resultado){
    const partes = [];
    if(resultado.vidaUtilReal) partes.push(fmtKm(resultado.vidaUtilReal));
    partes.push(`${resultado.vidaUtilRealMeses.toFixed(1)} meses`);
    setTimeout(()=>alert(`✅ Reemplazado. El componente anterior duró ${partes.join(' / ')}.`), 100);
  }
}

// ── VISTA: GASTOS (fijos, variables, costo/km) ────────────────────────────────
function renderGastos(){
  const v = vehiculoActivo();
  document.getElementById('pacts').innerHTML = `
    <button class="btn btn-sm" onclick="modalNuevoGastoFijo()">+ Gasto fijo</button>
    <button class="btn btn-p btn-sm" onclick="modalNuevoGastoVariable()">+ Gasto variable</button>
  `;
  const desdeDefault = new Date(); desdeDefault.setMonth(desdeDefault.getMonth()-12);
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="ch"><div class="ct">💲 Costo por kilómetro</div></div>
      <div class="card-body">
        <div class="sbar">
          <label class="text2" style="font-size:11px">Desde</label>
          <input type="date" id="ck-desde" value="${desdeDefault.toISOString().slice(0,10)}" onchange="actualizarCostoKm()">
          <label class="text2" style="font-size:11px">Hasta</label>
          <input type="date" id="ck-hasta" value="${new Date().toISOString().slice(0,10)}" onchange="actualizarCostoKm()">
        </div>
        <div id="ck-resultado"></div>
      </div>
    </div>

    <div class="card">
      <div class="ch"><div class="ct">📌 Gastos fijos</div></div>
      <div class="card-body twrap">
        ${renderTablaGastosFijos(v.uuid)}
      </div>
    </div>

    <div class="card">
      <div class="ch"><div class="ct">💸 Gastos variables</div></div>
      <div class="card-body twrap">
        ${renderTablaGastosVariables(v.uuid)}
      </div>
    </div>
  `;
  actualizarCostoKm();
}

function actualizarCostoKm(){
  const v = vehiculoActivo();
  const desde = new Date(document.getElementById('ck-desde').value).toISOString();
  const hasta = new Date(document.getElementById('ck-hasta').value + 'T23:59:59').toISOString();
  const r = calcularCostoPorKm(v.uuid, desde, hasta);
  const el = document.getElementById('ck-resultado');
  if(!r){ el.innerHTML = `<div class="empty">No hay suficientes cargas de combustible en este rango para calcular km recorridos.</div>`; return; }
  el.innerHTML = `
    <div class="stats" style="margin-top:10px">
      <div class="stat"><div class="stat-n">${fmtMoney(r.costoPorKmTotal)}</div><div class="stat-l">$/km total</div></div>
      <div class="stat"><div class="stat-n">${fmtMoney(r.costoPorKmVariable)}</div><div class="stat-l">$/km variable</div></div>
      <div class="stat"><div class="stat-n">${fmtKm(r.kmRecorridos)}</div><div class="stat-l">Km en el período</div></div>
    </div>
    <div class="twrap" style="margin-top:10px">
      <table><tbody>
        <tr><td>Combustible</td><td>${fmtMoney(r.desglose.totalCombustible)}</td></tr>
        <tr><td>Mantenimientos</td><td>${fmtMoney(r.desglose.totalMantenimientos)}</td></tr>
        <tr><td>Componentes (neumáticos/batería)</td><td>${fmtMoney(r.desglose.totalComponentes)}</td></tr>
        <tr><td>Gastos variables extra</td><td>${fmtMoney(r.desglose.totalVariablesExtra)}</td></tr>
        <tr><td>Gastos fijos (prorrateados)</td><td>${fmtMoney(r.desglose.totalFijos)}</td></tr>
        <tr><td><b>Total</b></td><td><b>${fmtMoney(r.desglose.gastoTotal)}</b></td></tr>
      </tbody></table>
    </div>
  `;
}

function renderTablaGastosFijos(vehiculoId){
  const gastos = DB.gastosFijos.filter(g=>g.vehiculoId===vehiculoId);
  if(!gastos.length) return `<div class="empty">Sin gastos fijos registrados.</div>`;
  return `<table><thead><tr><th>Tipo</th><th>Monto</th><th>Periodicidad</th><th>Desde</th><th></th></tr></thead><tbody>
    ${gastos.map(g=>`<tr>
      <td>${g.tipo}</td><td>${fmtMoney(g.monto)}</td><td>${g.periodicidad}</td><td class="mono">${fmtFecha(g.fecha_inicio)}</td>
      <td><button class="btn btn-sm btn-d" onclick="eliminarGastoFijo('${g.uuid}')">✕</button></td>
    </tr>`).join('')}
  </tbody></table>`;
}
function renderTablaGastosVariables(vehiculoId){
  const gastos = DB.gastosVariables.filter(g=>g.vehiculoId===vehiculoId).sort((a,b)=>new Date(b.fecha)-new Date(a.fecha));
  if(!gastos.length) return `<div class="empty">Sin gastos variables registrados.</div>`;
  return `<table><thead><tr><th>Fecha</th><th>Categoría</th><th>Descripción</th><th>Monto</th><th></th></tr></thead><tbody>
    ${gastos.map(g=>`<tr>
      <td class="mono">${fmtFecha(g.fecha)}</td><td>${g.categoria}</td><td class="text2">${escHtml(g.descripcion)}</td><td>${fmtMoney(g.monto)}</td>
      <td><button class="btn btn-sm btn-d" onclick="eliminarGastoVariable('${g.uuid}')">✕</button></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function modalNuevoGastoFijo(){
  abrirModal('📌 Nuevo gasto fijo', `
    <div class="fg"><label>Tipo</label><select id="f-tipo">${TIPOS_GASTO_FIJO.map(t=>`<option>${t}</option>`).join('')}</select></div>
    <div class="fgrid">
      <div class="fg"><label>Monto</label><input type="number" inputmode="decimal" id="f-monto" step="0.01"></div>
      <div class="fg"><label>Periodicidad</label><select id="f-period"><option value="mensual">Mensual</option><option value="anual">Anual</option><option value="unico">Único</option></select></div>
    </div>
    <div class="fg"><label>Fecha de inicio</label><input type="date" id="f-fecha" value="${new Date().toISOString().slice(0,10)}"></div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="guardarNuevoGastoFijo()">Guardar</button>
  `);
}
function guardarNuevoGastoFijo(){
  const v = vehiculoActivo();
  const tipo = document.getElementById('f-tipo').value;
  const monto = Number(document.getElementById('f-monto').value);
  const periodicidad = document.getElementById('f-period').value;
  const fecha_inicio = new Date(document.getElementById('f-fecha').value).toISOString();
  if(!monto){ alert('Ingresá un monto.'); return; }
  crearGastoFijo({ vehiculoId: v.uuid, tipo, monto, periodicidad, fecha_inicio });
  cerrarModal(); goTo('gastos');
}
function modalNuevoGastoVariable(){
  const v = vehiculoActivo();
  const kmSugerido = kmActualVehiculo(v.uuid);
  abrirModal('💸 Nuevo gasto variable', `
    <div class="fg"><label>Categoría</label><select id="f-cat">${CATEGORIAS_GASTO_VAR.map(t=>`<option>${t}</option>`).join('')}</select></div>
    <div class="fg"><label>Descripción</label><input type="text" id="f-desc" placeholder="Opcional"></div>
    <div class="fgrid">
      <div class="fg"><label>Monto</label><input type="number" inputmode="decimal" id="f-monto" step="0.01"></div>
      <div class="fg"><label>Km (opcional)</label><input type="number" inputmode="numeric" id="f-km" value="${kmSugerido||''}" onfocus="this.select()"></div>
    </div>
    <div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${new Date().toISOString().slice(0,10)}"></div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="guardarNuevoGastoVariable()">Guardar</button>
  `);
}
function guardarNuevoGastoVariable(){
  const v = vehiculoActivo();
  const categoria = document.getElementById('f-cat').value;
  const descripcion = document.getElementById('f-desc').value.trim();
  const monto = Number(document.getElementById('f-monto').value);
  const kilometraje = document.getElementById('f-km').value;
  const fecha = new Date(document.getElementById('f-fecha').value).toISOString();
  if(!monto){ alert('Ingresá un monto.'); return; }
  crearGastoVariable({ vehiculoId: v.uuid, categoria, descripcion, monto, kilometraje, fecha });
  cerrarModal(); goTo('gastos');
}

// ── VISTA: VEHÍCULOS ──────────────────────────────────────────────────────────
function renderVehiculos(){
  document.getElementById('pacts').innerHTML = `<button class="btn btn-p btn-sm" onclick="modalNuevoVehiculo()">+ Nuevo vehículo</button>`;
  document.getElementById('content').innerHTML = `
    <div class="proy-grid">
      ${DB.vehiculos.map(v => {
        const km = kmActualVehiculo(v.uuid);
        return `<div class="proy-card">
          <div class="proy-card-num">${v.tipo}</div>
          <div class="proy-card-title">${escHtml(v.nombre)}</div>
          <div class="proy-card-obj">${escHtml(v.marca)} ${escHtml(v.modelo)} ${v.anio?'· '+v.anio:''}<br>Km actual: ${fmtKm(km)}</div>
          <div class="proy-card-footer">
            <span class="proy-card-cat">${v.uuid===DB.config.vehiculoActivo?'✅ Activo':''}</span>
            <div>
              <button class="btn btn-sm" onclick="event.stopPropagation();modalEditarVehiculo('${v.uuid}')">✎</button>
              <button class="btn btn-sm btn-d" onclick="event.stopPropagation();eliminarVehiculo('${v.uuid}')">✕</button>
            </div>
          </div>
        </div>`;
      }).join('') || `<div class="empty">No hay vehículos cargados.</div>`}
    </div>
  `;
}
function modalNuevoVehiculo(){
  abrirModal('🚙 Nuevo vehículo', `
    <div class="fg"><label>Matrícula</label><input type="text" id="f-nombre" placeholder="Ej: AB123CD" style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()"></div>
    <div class="fgrid">
      <div class="fg"><label>Tipo</label><select id="f-tipo"><option>Auto</option><option>Moto</option></select></div>
      <div class="fg"><label>Año</label><input type="number" inputmode="numeric" id="f-anio"></div>
    </div>
    <div class="fgrid">
      <div class="fg"><label>Marca</label><input type="text" id="f-marca"></div>
      <div class="fg"><label>Modelo</label><input type="text" id="f-modelo"></div>
    </div>
    <div class="fg"><label>Kilometraje actual del odómetro</label><input type="number" inputmode="numeric" id="f-kminicial" placeholder="El vehículo ya está en uso"></div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="guardarNuevoVehiculo()">Guardar</button>
  `);
}
function guardarNuevoVehiculo(){
  const nombre = document.getElementById('f-nombre').value.trim().toUpperCase();
  if(!nombre){ alert('Ingresá la matrícula.'); return; }
  crearVehiculo({
    nombre, tipo: document.getElementById('f-tipo').value,
    marca: document.getElementById('f-marca').value.trim(),
    modelo: document.getElementById('f-modelo').value.trim(),
    anio: document.getElementById('f-anio').value,
    km_inicial: document.getElementById('f-kminicial').value
  });
  cerrarModal(); goTo('vehiculos');
}
function modalEditarVehiculo(uuid){
  const v = DB.vehiculos.find(x=>x.uuid===uuid);
  abrirModal('✎ Editar vehículo', `
    <div class="fg"><label>Matrícula</label><input type="text" id="f-nombre" value="${escHtml(v.nombre)}" style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()"></div>
    <div class="fgrid">
      <div class="fg"><label>Tipo</label><select id="f-tipo"><option ${v.tipo==='Auto'?'selected':''}>Auto</option><option ${v.tipo==='Moto'?'selected':''}>Moto</option></select></div>
      <div class="fg"><label>Año</label><input type="number" inputmode="numeric" id="f-anio" value="${v.anio||''}"></div>
    </div>
    <div class="fgrid">
      <div class="fg"><label>Marca</label><input type="text" id="f-marca" value="${escHtml(v.marca)}"></div>
      <div class="fg"><label>Modelo</label><input type="text" id="f-modelo" value="${escHtml(v.modelo)}"></div>
    </div>
  `, `
    <button class="btn" onclick="cerrarModal()">Cancelar</button>
    <button class="btn btn-p" onclick="editarVehiculo('${uuid}',{nombre:document.getElementById('f-nombre').value.trim(),tipo:document.getElementById('f-tipo').value,marca:document.getElementById('f-marca').value.trim(),modelo:document.getElementById('f-modelo').value.trim(),anio:document.getElementById('f-anio').value}); cerrarModal(); goTo('vehiculos');">Guardar</button>
  `);
}

// ── VISTA: BACKUP ──────────────────────────────────────────────────────────────
function renderBackup(){
  const conectado = typeof DriveSync !== 'undefined' && DriveSync.conectado;
  const snaps = cvCargarSnaps();
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="ch"><div class="ct">☁️ Google Drive</div></div>
      <div class="card-body">
        ${DEV_MODE ? `<div class="alert alert-info" style="margin-bottom:10px">🔒 Este entorno es <b>DEV</b>: lee el backup real de PROD para tener datos de prueba parecidos a los reales, pero tiene bloqueada la escritura — nunca sube ni modifica nada en Drive, ni acá ni en "Salir" ni en el guardado automático.</div>` : ''}
        <p class="text2" style="margin-bottom:10px">Estado: ${conectado?'<span class="green">✅ Conectado</span>':'<span class="text3">No conectado</span>'}</p>
        <button class="btn btn-p" onclick="cvSincronizarDrive()">🔄 ${conectado?(DEV_MODE?'Traer datos de PROD':'Sincronizar ahora'):'Conectar'}</button>
      </div>
    </div>
    <div class="card">
      <div class="ch"><div class="ct">💾 Snapshots locales</div></div>
      <div class="card-body">
        <button class="btn" onclick="cvHacerSnapshot(true);renderBackup();">+ Crear snapshot manual</button>
        <div style="margin-top:10px">
        ${!snaps.length ? `<div class="empty">Sin snapshots todavía. Se crean automáticamente al cerrar o minimizar.</div>` :
          snaps.map(s=>`<div class="hist-item">
            <span class="hist-fecha">${new Date(s.ts).toLocaleString('es-AR')}</span>
            <span class="hist-accion">${s.label}</span>
            <span style="margin-left:auto;display:flex;gap:6px">
              <button class="btn btn-sm" onclick="cvRestaurarSnapshot(${s.ts})">Restaurar</button>
              <button class="btn btn-sm btn-d" onclick="cvEliminarSnapshot(${s.ts})">✕</button>
            </span>
          </div>`).join('')}
        </div>
      </div>
    </div>
    <div class="card" style="border-color:rgba(248,81,73,.35)">
      <div class="ch"><div class="ct red">⚠️ Zona de riesgo</div></div>
      <div class="card-body">
        <p class="text2" style="margin-bottom:10px;font-size:12px">Borra TODOS los vehículos, cargas, mantenimientos, componentes y gastos — local y en Drive si está conectado. Se guarda un último snapshot antes, por si te arrepentís. No se puede deshacer más allá de eso.</p>
        <button class="btn btn-d" onclick="cvBorrarTodo()">🗑️ Borrar todos los datos</button>
      </div>
    </div>
  `;
}

// ── SPLASH ────────────────────────────────────────────────────────────────────
function mostrarSplash(){
  const ahora = new Date();
  const diasSemana = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const meses = ['01','02','03','04','05','06','07','08','09','10','11','12'];
  const dia = diasSemana[ahora.getDay()];
  const fecha = `${dia} ${String(ahora.getDate()).padStart(2,'0')}/${meses[ahora.getMonth()]}/${ahora.getFullYear()}`;
  const hora = `${String(ahora.getHours()).padStart(2,'0')}:${String(ahora.getMinutes()).padStart(2,'0')}`;

  const el = document.createElement('div');
  el.id = 'splash';
  el.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;
    background:#111318;
    display:flex;flex-direction:column;
    font-family:system-ui,sans-serif;
  `;
  el.innerHTML = `
    <div style="background:#1e2128;border-bottom:1px solid rgba(255,255,255,0.08);padding:10px 18px;display:flex;align-items:center;gap:10px;">
      <div style="width:32px;height:32px;background:#2d7a4f;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">🚗</div>
      <div>
        <div style="font-weight:700;font-size:13px;color:#e0e0e0;">Control Vehicular</div>
        <div style="font-size:10px;color:#7aa88a;">Gastos y mantenimiento</div>
      </div>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3rem 2rem;">
      <div style="margin-bottom:2.5rem;text-align:center;">
        <div style="font-size:26px;font-weight:500;letter-spacing:0.03em;color:#c8e0d0;line-height:1.4;">Gastos, rendimiento y mantenimiento de tus vehículos</div>
      </div>
      <div style="text-align:center;width:100%;max-width:400px;">
        <div style="display:flex;align-items:center;justify-content:center;gap:1rem;font-size:10px;color:#5a8568;font-family:monospace;letter-spacing:0.05em;">
          <span style="color:#7aa88a;">Control Vehicular</span>
          <span style="opacity:0.3;">·</span>
          <span>${fecha}</span>
          <span style="opacity:0.3;">·</span>
          <span>${hora}</span>
          <span style="opacity:0.3;">·</span>
          <span>${VERSION}</span>
        </div>
        <div style="margin-top:16px;font-family:'Dancing Script',cursive;font-size:22px;color:#93d1a3;">Development by Guille</div>
        <div style="margin-top:32px;display:flex;align-items:center;justify-content:center;gap:8px;opacity:0.85;animation:splash-pulse 1.8s ease-in-out infinite;">
          <span style="border:1.2px solid #2a2e35;border-radius:5px;padding:3px 9px;font-size:10.5px;color:#cbd5e1;font-weight:600;">ENTER</span>
          <span style="font-size:11.5px;color:#5a8568;">o tocá la pantalla para continuar</span>
        </div>
      </div>
    </div>
    <style>@keyframes splash-pulse { 0%,100%{opacity:0.45;} 50%{opacity:1;} }</style>
  `;
  document.body.appendChild(el);

  function cerrarSplash(){
    document.removeEventListener('keydown', onKeydown);
    el.removeEventListener('click', cerrarSplash);
    el.style.transition = 'opacity 0.3s ease';
    el.style.opacity = '0';
    setTimeout(()=> el.remove(), 300);
  }
  function onKeydown(e){ if(e.key==='Enter') cerrarSplash(); }
  document.addEventListener('keydown', onKeydown);
  el.addEventListener('click', cerrarSplash);
}

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  load();
  document.getElementById('nav-version').textContent = VERSION;

  if(esMobile()){
    iniciarVistaMobile();
  } else {
    mostrarSplash();
    document.querySelector('.main').style.display = 'flex';
    goTo('dashboard');
    setTimeout(mostrarModalVencimientos, 800);
  }

  if(typeof DriveSync !== 'undefined'){
    DriveSync.init(() => { console.log('Drive listo'); });
    if(DriveSync.onToken){
      DriveSync.onToken(() => {
        // Se conectó (o se renovó el token): refrescar la vista actual para
        // que "No conectado" pase a "Conectado" sin que el usuario tenga que
        // hacer nada más.
        if(!esMobile() || _modoAppCompleta) goTo(_currentView || 'backup');
      });
    }
  }

  // Safe-close: snapshot automático + Drive
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'hidden'){
      cvHacerSnapshot(false);
      if(typeof DriveSync !== 'undefined' && DriveSync.conectado) DriveSync.subirBackup(DB, true).catch(()=>{});
    }
  });
  window.addEventListener('beforeunload', ()=>{ cvHacerSnapshot(false); });
});

// ── VISTA RÁPIDA MOBILE ────────────────────────────────────────────────────────
// En celular la app NO muestra el dashboard completo ni la navegación: solo
// una pantalla de carga rápida de combustible, igual que la "Vista Rápida" de
// FinanzasPro Ledger. El resto de los módulos (mantenimientos, componentes,
// gastos, reportes) se gestionan desde la PC.
let _modoAppCompleta = false;

function iniciarVistaMobile(){
  document.getElementById('nav').style.display = 'none';
  document.getElementById('nav-overlay').style.display = 'none';
  document.querySelector('.main').style.display = 'none';
  renderVistaRapidaMobile();
}

function volverVistaMobile(){
  _modoAppCompleta = false;
  const existente = document.getElementById('vr-screen');
  if(existente) existente.remove();
  document.querySelector('.main').style.display = 'none';
  const btnVolver = document.getElementById('btn-volver-mobile');
  if(btnVolver) btnVolver.style.display = 'none';
  renderVistaRapidaMobile();
}

function abrirAppCompletaDesdeMobile(){
  _modoAppCompleta = true;
  const vr = document.getElementById('vr-screen');
  if(vr) vr.remove();
  document.getElementById('nav').style.display = '';
  document.getElementById('nav-overlay').style.display = '';
  document.querySelector('.main').style.display = 'flex';
  const btnVolver = document.getElementById('btn-volver-mobile');
  if(btnVolver) btnVolver.style.display = 'inline-block';
  goTo('dashboard');
  setTimeout(mostrarModalVencimientos, 400);
}

function renderVistaRapidaMobile(){
  const existente = document.getElementById('vr-screen');
  if(existente) existente.remove();

  if(!DB.vehiculos.length){
    const el = document.createElement('div');
    el.id = 'vr-screen';
    el.className = 'vr-screen';
    el.innerHTML = `
      <div class="vr-top"><div class="vr-title">⛽ Control Vehicular</div><div class="vr-sub">Carga rápida de combustible</div></div>
      <div class="vr-body">
        <div class="empty">Todavía no hay ningún vehículo cargado. Configuralo desde la PC en la sección Vehículos, y después sincronizá Drive acá para verlo.</div>
        <button class="btn" onclick="cvSincronizarDrive()">🔄 Sincronizar con Drive</button>
      </div>
    `;
    document.body.appendChild(el);
    return;
  }

  const v = vehiculoActivo();
  const kmSugerido = kmActualVehiculo(v.uuid);
  const marcaSugerida = DB.config.ultimaMarca || MARCAS_COMBUSTIBLE[0];
  const tipoSugerido = DB.config.ultimoTipoCombustible || TIPOS_COMBUSTIBLE[0];

  const el = document.createElement('div');
  el.id = 'vr-screen';
  el.className = 'vr-screen';
  el.innerHTML = `
    <div class="vr-top">
      <div class="vr-title">⛽ Control Vehicular</div>
      <div class="vr-sub">Carga rápida de combustible</div>
      ${DB.vehiculos.length > 1 ? `
      <div class="vr-vsel">
        <select id="vr-vsel" onchange="cambiarVehiculoActivo(this.value); volverVistaMobile();">
          ${DB.vehiculos.map(veh => `<option value="${veh.uuid}" ${veh.uuid===v.uuid?'selected':''}>${escHtml(veh.nombre)}</option>`).join('')}
        </select>
      </div>` : `<div class="vr-vsel" style="font-size:13px;color:var(--text2);margin-top:8px">🚗 ${escHtml(v.nombre)}</div>`}
    </div>
    <div class="vr-body">
      <div id="vr-confirm-slot"></div>

      <div class="vr-fg">
        <label>Kilometraje actual</label>
        <input type="number" inputmode="numeric" id="vr-km" value="${kmSugerido||''}" placeholder="km" onfocus="this.select()">
      </div>
      <div class="vr-row">
        <div class="vr-fg">
          <label>Marca</label>
          <select id="vr-marca">${MARCAS_COMBUSTIBLE.map(m=>`<option ${m===marcaSugerida?'selected':''}>${m}</option>`).join('')}</select>
        </div>
        <div class="vr-fg">
          <label>Tipo</label>
          <select id="vr-tipoCombustible">${TIPOS_COMBUSTIBLE.map(t=>`<option ${t===tipoSugerido?'selected':''}>${t}</option>`).join('')}</select>
        </div>
      </div>
      <div class="vr-row">
        <div class="vr-fg">
          <label>Litros</label>
          <input type="number" inputmode="decimal" id="vr-litros" step="0.01" placeholder="L" onfocus="this.select()" onchange="recalcularCarga('vr-','litros')">
        </div>
        <div class="vr-fg">
          <label>$ / Litro</label>
          <input type="number" inputmode="decimal" id="vr-costoLitro" step="0.01" placeholder="$" onfocus="this.select()" onchange="recalcularCarga('vr-','costoLitro')">
        </div>
      </div>
      <div class="vr-fg">
        <label>Total pagado</label>
        <input type="number" inputmode="decimal" id="vr-total" step="0.01" placeholder="$" onfocus="this.select()" onchange="recalcularCarga('vr-','total')">
      </div>
      <div class="vr-switch">
        <label>⛽ ¿Tanque lleno?</label>
        <input type="checkbox" id="vr-lleno" checked>
      </div>

      <button class="vr-btn-main" onclick="guardarCargaRapidaMobile()">Guardar carga</button>
      <div class="vr-full-link">
        <a onclick="abrirAppCompletaDesdeMobile()" style="color:var(--primary-light);cursor:pointer">Ver app completa</a>
        &nbsp;·&nbsp;
        <a onclick="window.open('./instructivo.html#mobile','_blank')" style="color:var(--primary-light);cursor:pointer">❓ Ayuda</a>
      </div>
      <div style="text-align:center;font-size:10px;color:var(--text3);font-family:monospace;margin-top:4px">${VERSION}${DEV_MODE?' · DEV':''}</div>
    </div>
    <div class="vr-footer">
      <button onclick="cvSincronizarDrive()">🔄 Sincronizar</button>
      <button class="vr-salir" onclick="cvSalir()">🚪 Guardar y salir</button>
    </div>
  `;
  document.body.appendChild(el);
  setTimeout(()=>document.getElementById('vr-km').focus(), 50);
}


function guardarCargaRapidaMobile(){
  const v = vehiculoActivo();
  const km = Number(document.getElementById('vr-km').value);
  const marca = document.getElementById('vr-marca').value;
  const tipoCombustible = document.getElementById('vr-tipoCombustible').value;
  const litros = Number(document.getElementById('vr-litros').value);
  const costoLitro = Number(document.getElementById('vr-costoLitro').value);
  const totalPagado = Number(document.getElementById('vr-total').value);
  const tanqueLleno = document.getElementById('vr-lleno').checked;
  if(!km || !litros || !totalPagado){ alert('Completá km, litros y total.'); return; }
  DB.config.ultimaMarca = marca;
  DB.config.ultimoTipoCombustible = tipoCombustible;

  const { carga, alertas } = registrarCarga({ vehiculoId: v.uuid, km, marca, tipoCombustible, litros, costoLitro, totalPagado, tanqueLleno });

  let msg = '✅ Carga guardada.';
  if(carga.rendimiento_calculado) msg += ` Rendimiento: ${fmtNum(carga.rendimiento_calculado,1)} km/L.`;
  const slot = document.getElementById('vr-confirm-slot');
  if(slot) slot.innerHTML = `<div class="vr-confirm">${msg}</div>`;

  if(alertas.length){
    setTimeout(()=>alert(alertas.map(a=>a.mensaje).join('\n\n')), 150);
  }

  // Formulario queda listo para la próxima carga
  renderVistaRapidaMobile();
  const slot2 = document.getElementById('vr-confirm-slot');
  if(slot2) slot2.innerHTML = `<div class="vr-confirm">${msg}</div>`;
}
