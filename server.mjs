import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const root = fileURLToPath(new URL(".", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };
const dataFile = join(root, "sessions.json");
const auditFile = join(root, "audit.json");
let sessions = [];
let audit = [];
const clients = new Set();
const tokens = new Map();
try { sessions = JSON.parse(await readFile(dataFile, "utf8")); } catch { await writeFile(dataFile, "[]"); }
try { audit = JSON.parse(await readFile(auditFile, "utf8")); } catch { await writeFile(auditFile, "[]"); }
const send = (response, status, body) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }); response.end(JSON.stringify(body)); };
const publicSessions = () => sessions.filter((session) => !session.finalExit).map(({ driverDni, amount, ...session }) => session);
const broadcast = () => { const payload = `data: ${JSON.stringify(publicSessions())}\n\n`; for (const response of clients) response.write(payload); };
const persist = async () => { await writeFile(dataFile, JSON.stringify(sessions, null, 2)); broadcast(); };
const logAction = async (operator, action, details) => { audit.push({ id: crypto.randomUUID(), at: new Date().toISOString(), operator, action, ...details }); await writeFile(auditFile, JSON.stringify(audit, null, 2)); };
const plateOf = (value) => String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const dniOf = (value) => String(value || "").replace(/\D/g, "");
const active = (plate) => sessions.find((s) => s.plate === plate && !s.finalExit);
const cookies = (request) => Object.fromEntries(String(request.headers.cookie || "").split(";").filter(Boolean).map((part) => part.trim().split("=")));
const userFor = (request) => tokens.get(cookies(request).parking_session);
const passwords = { operator: process.env.OPERATOR_PASSWORD || "cabred2026", admin: process.env.ADMIN_PASSWORD || "admin-cabred-2026" };

http.createServer(async (request, response) => {
  if (request.url === "/api/login" && request.method === "POST") {
    let raw = ""; for await (const chunk of request) raw += chunk;
    try { const { name, password } = JSON.parse(raw || "{}"); const role = password === passwords.admin ? "admin" : password === passwords.operator ? "operator" : null; if (!role || !String(name || "").trim()) { send(response, 401, { error: "Nombre o contraseña incorrectos." }); return; } const token = crypto.randomBytes(32).toString("hex"); tokens.set(token, { name: String(name).trim(), role }); response.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `parking_session=${token}; HttpOnly; SameSite=Lax; Path=/` }); response.end(JSON.stringify({ name: String(name).trim(), role })); } catch (error) { send(response, 400, { error: error.message }); } return;
  }
  if (request.url === "/api/me" && request.method === "GET") { const user = userFor(request); if (!user) { send(response, 401, { error: "No autenticado." }); return; } send(response, 200, user); return; }
  const user = userFor(request);
  if (request.url.startsWith("/api/") && !user) { send(response, 401, { error: "Sesión vencida. Ingresá nuevamente." }); return; }
  if (request.url === "/api/audit" && request.method === "GET") { if (user.role !== "admin") { send(response, 403, { error: "Solo el administrador puede ver la auditoría." }); return; } send(response, 200, audit.slice().reverse()); return; }
  if (request.url === "/api/summary" && request.method === "GET") { if (user.role !== "admin") { send(response, 403, { error: "Solo el administrador puede ver la recaudación." }); return; } send(response, 200, { revenue: sessions.reduce((total, session) => total + Number(session.amount || 0), 0), completed: sessions.filter((session) => session.finalExit).length }); return; }
  if (request.url === "/api/sessions" && request.method === "GET") { send(response, 200, publicSessions()); return; }
  if (request.url === "/api/stream" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
    response.write(`data: ${JSON.stringify(publicSessions())}\n\n`); clients.add(response); request.on("close", () => clients.delete(response)); return;
  }
  if (request.url === "/api/action" && request.method === "POST") {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const { type, plate: rawPlate, minutes } = JSON.parse(raw || "{}"); const plate = plateOf(rawPlate);
      if (!plate) { send(response, 400, { error: "La patente es obligatoria." }); return; }
      let session = active(plate);
      const dni = dniOf((JSON.parse(raw || "{}")).dni); if (!dni || dni.length < 6) { send(response, 400, { error: "El DNI es obligatorio y debe ser válido." }); return; }
      if (type === "entry") { if (session) { send(response, 409, { error: "El vehículo ya tiene una sesión activa." }); return; } session = { plate, driverDni: dni, entry: new Date().toISOString(), temporaryUntil: null, finalExit: null, amount: 0 }; sessions.push(session); await logAction(user.name, "entrada", { plate, dniLast4: dni.slice(-4) }); }
      else if (!session) { send(response, 404, { error: "No hay un vehículo activo con esa patente." }); return; }
      else if (dni !== session.driverDni) { send(response, 403, { error: "El DNI no coincide con el registrado al ingreso." }); return; }
      else if (type === "temporary") { session.temporaryUntil = new Date(Date.now() + Number(minutes || 30) * 60000).toISOString(); await logAction(user.name, "salida temporal", { plate, minutes: Number(minutes || 30), dniLast4: dni.slice(-4) }); }
      else if (type === "reentry") { session.temporaryUntil = null; await logAction(user.name, "reingreso", { plate, dniLast4: dni.slice(-4) }); }
      else if (type === "final") { const now = Date.now(); session.finalExit = new Date(now).toISOString(); session.amount = 50000 * Math.max(1, Math.ceil((now - new Date(session.entry).getTime()) / 86400000)); session.temporaryUntil = null; await logAction(user.name, "salida definitiva", { plate, amount: session.amount, dniLast4: dni.slice(-4) }); }
      else { send(response, 400, { error: "Acción no válida." }); return; }
      await persist(); send(response, 200, session);
    } catch (error) { send(response, 400, { error: error.message }); }
    return;
  }
  const requested = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) { response.writeHead(403); response.end("Forbidden"); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch { response.writeHead(404); response.end("Not found"); }
}).listen(Number(process.env.PORT || 4173), "0.0.0.0", () => console.log(`Estacionamiento abierto en el puerto ${process.env.PORT || 4173}`));
