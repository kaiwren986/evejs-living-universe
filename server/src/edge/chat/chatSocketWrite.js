"use strict";

function isSocketWritable(socket) {
  return Boolean(
    socket &&
    socket.destroyed !== true &&
    socket.writable !== false &&
    socket.writableEnded !== true &&
    socket.writableFinished !== true
  );
}

function writeSocket(socket, data) {
  if (!isSocketWritable(socket)) {
    return { accepted: false, closed: true };
  }
  // tls.TLSSocket.write(false) still accepted and queued the bytes. It is a
  // backpressure signal; the corresponding drain event resumes the producer.
  return {
    accepted: true,
    backpressured: socket.write(data) === false,
  };
}

module.exports = {
  isSocketWritable,
  writeSocket,
};
