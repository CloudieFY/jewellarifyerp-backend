const http = require('http');

function sendPost(port, path, sizeMb) {
  return new Promise((resolve, reject) => {
    const sizeBytes = sizeMb * 1024 * 1024;
    const bodyData = JSON.stringify({ data: 'x'.repeat(sizeBytes) });

    const options = {
      hostname: 'localhost',
      port: port,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyData)
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          body: body.substring(0, 500)
        });
      });
    });

    req.on('error', (e) => reject(e));
    req.write(bodyData);
    req.end();
  });
}

async function run() {
  console.log("=== Testing Direct Backend on Port 3006 ===");
  try {
    const res = await sendPost(3006, '/health', 5); // 5MB
    console.log(`5MB direct: Status = ${res.statusCode}, Body preview: ${res.body.substring(0, 100)}`);
  } catch (err) {
    console.error("5MB direct error:", err);
  }

  try {
    const res = await sendPost(3006, '/health', 15); // 15MB
    console.log(`15MB direct: Status = ${res.statusCode}, Body preview: ${res.body.substring(0, 100)}`);
  } catch (err) {
    console.error("15MB direct error:", err);
  }

  console.log("\n=== Testing Vite Proxy on Port 5173 ===");
  try {
    const res = await sendPost(5173, '/api/health', 5); // 5MB
    console.log(`5MB proxy: Status = ${res.statusCode}, Body preview: ${res.body.substring(0, 100)}`);
  } catch (err) {
    console.error("5MB proxy error:", err);
  }

  try {
    const res = await sendPost(5173, '/api/health', 15); // 15MB
    console.log(`15MB proxy: Status = ${res.statusCode}, Body preview: ${res.body.substring(0, 100)}`);
  } catch (err) {
    console.error("15MB proxy error:", err);
  }
}

run();
