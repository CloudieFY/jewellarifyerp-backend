const http = require('http');

function postJson(port, path, bodyObj, token) {
  return new Promise((resolve, reject) => {
    const bodyData = JSON.stringify(bodyObj);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyData)
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const options = {
      hostname: 'localhost',
      port: port,
      path: path,
      method: token ? 'PUT' : 'POST',
      headers: headers
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', (e) => reject(e));
    req.write(bodyData);
    req.end();
  });
}

async function run() {
  console.log("Logging in...");
  const loginRes = await postJson(3006, '/api/auth/login', {
    shopSlug: 'patel',
    username: 'admin',
    password: '123456'
  });
  
  if (loginRes.statusCode !== 200) {
    console.error("Login failed:", loginRes.body);
    return;
  }

  const { token, shop } = JSON.parse(loginRes.body);
  console.log("Logged in successfully. Token received.");

  // Test updating shop with 1.5MB payload (similar to current database payload)
  console.log("\nSending PUT update with 1.5MB body...");
  const payload = {
    ...shop,
    invoiceSettings: {
      ...shop.invoiceSettings,
      qrCodeUrl: 'data:image/png;base64,' + 'x'.repeat(1.5 * 1024 * 1024)
    }
  };

  const updateRes = await postJson(3006, '/api/auth/shop', payload, token);
  console.log(`Direct port 3006 response status: ${updateRes.statusCode} ${updateRes.statusMessage}`);
  console.log(`Response body: ${updateRes.body.substring(0, 500)}`);

  console.log("\nSending PUT update with 1.5MB body via Vite Proxy port 5173...");
  const updateProxyRes = await postJson(5173, '/api/auth/shop', payload, token);
  console.log(`Vite Proxy port 5173 response status: ${updateProxyRes.statusCode} ${updateProxyRes.statusMessage}`);
  console.log(`Response body: ${updateProxyRes.body.substring(0, 500)}`);
}

run();
