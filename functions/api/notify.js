async function getAccessToken(serviceAccount) {
  const enc = new TextEncoder();
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: serviceAccount.token_uri,
    exp: now + 3600,
    iat: now
  };

  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsignedToken = `${headerB64}.${payloadB64}`;

  const pem = serviceAccount.private_key;
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem.substring(pem.indexOf(pemHeader) + pemHeader.length, pem.indexOf(pemFooter)).replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsignedToken));
  
  let binaryStr = '';
  const bytes = new Uint8Array(signature);
  for (let i = 0; i < bytes.byteLength; i++) {
    binaryStr += String.fromCharCode(bytes[i]);
  }
  const signatureB64 = btoa(binaryStr).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = `${unsignedToken}.${signatureB64}`;

  const res = await fetch(serviceAccount.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const data = await res.json();
  if (!data.access_token) throw new Error("Failed to get OAuth2 token: " + JSON.stringify(data));
  return data.access_token;
}

export async function onRequest(context) {
  if (context.request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  
  try {
    const body = await context.request.json();
    if (!body.token || !body.title) return new Response("Bad Request", { status: 400 });

    const saJsonRaw = context.env.FIREBASE_SERVICE_ACCOUNT;
    if (!saJsonRaw) return new Response("Missing API Key Configuration", { status: 500 });

    const saJson = JSON.parse(saJsonRaw);
    const accessToken = await getAccessToken(saJson);

    const fcmPayload = {
      message: {
        token: body.token,
        notification: {
          title: body.title,
          body: body.body || ""
        },
        android: { priority: "high" },
        apns: {
          payload: {
            aps: { sound: "default" }
          }
        }
      }
    };

    const pushReq = await fetch(`https://fcm.googleapis.com/v1/projects/${saJson.project_id}/messages:send`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(fcmPayload)
    });

    const result = await pushReq.json();
    return new Response(JSON.stringify({ success: pushReq.ok, result }), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(err.message, { status: 500 });
  }
}
