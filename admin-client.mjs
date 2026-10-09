import http from 'node:http';

export function adminCall(socketPath, operation, fields = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ operation, ...fields });
    const request = http.request({ socketPath, path: '/', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, (response) => {
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) response.destroy(new Error('Admin response too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Admin response interrupted')));
      response.once('end', () => {
        try { resolve({ status: response.statusCode, ...JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { reject(new Error('Invalid admin response')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Admin timeout')), 20000);
    timer.unref();
    request.once('close', () => clearTimeout(timer));
    request.once('error', reject);
    request.end(body);
  });
}
