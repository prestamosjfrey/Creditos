// Puente mínimo para emitir eventos en tiempo real por Socket.IO desde
// cualquier parte del backend sin acoplar los servicios al servidor HTTP.
let io = null;

function setIo(instancia) {
  io = instancia;
}

// Emite un evento a TODOS los clientes conectados (fail-soft: si Socket.IO
// aún no está listo, simplemente no hace nada).
function emitir(evento, datos) {
  if (io) io.emit(evento, datos || {});
}

module.exports = { setIo, emitir };
