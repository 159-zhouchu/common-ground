import net from 'node:net';
export async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) =>
    socket.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
export async function waitForInstance(base, instance, server, log = () => '', timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (server.exitCode !== null) throw new Error('Isolated server exited: ' + log());
    try {
      const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(700) });
      if (r.ok) {
        const health = await r.json();
        if (health.instance !== instance) throw new Error('INSTANCE_MISMATCH');
        return;
      }
    } catch (e) {
      if (e.message === 'INSTANCE_MISMATCH') throw e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Isolated server timeout: ' + log());
}
