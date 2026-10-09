import http from 'node:http';

// Bound the complete exchange, including responses that arrive one byte at a time.
export function readResponse(options, { timeout = 10000, limit = 65536, signal } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const request = http.request({ ...options, signal }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) response.destroy(new Error('Backend response too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Backend response interrupted')));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.once('close', () => clearTimeout(timer));
    });
    timer = setTimeout(() => request.destroy(new Error('Backend timeout')), timeout);
    timer.unref();
    request.once('error', reject);
    request.once('close', () => clearTimeout(timer));
    request.end();
  });
}

export async function protectedBackend(config, timeout = 3000) {
  const response = await readResponse({ hostname: config.backendHost, port: config.backendPort, path: '/api/info' }, { timeout });
  return response.status === 401 && (response.headers['content-type'] || '').includes('application/json');
}
