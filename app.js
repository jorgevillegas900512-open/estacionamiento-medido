const RATE = 50000;
const config = window.SUPABASE_CONFIG;
const supabaseClient = window.supabase.createClient(config.url, config.anonKey);

let sessions = [];
let currentUser = null;
let currentRole = "operator";
let loadVersion = 0;
let realtimeChannel = null;

const $ = (id) => document.getElementById(id);
const money = (value) => "$" + Math.round(value).toLocaleString("es-AR");
const plateOf = (value) => String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const dniOf = (value) => String(value || "").replace(/\D/g, "");
const dateTime = (value) => new Date(value).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
const elapsedDays = (start, end = Date.now()) => Math.max(1, Math.ceil((end - new Date(start).getTime()) / 86400000));
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

function showMessage(id, text, error = false) {
  const element = $(id);
  element.textContent = text;
  element.className = `message${error ? " error" : ""}`;
}

function isTemporaryActive(session) {
  return Boolean(session.temporary_until && new Date(session.temporary_until).getTime() > Date.now());
}

function activeSession(plate) {
  return sessions.find((session) => session.plate === plate && !session.final_exit_at);
}

function render() {
  const inside = sessions.filter((session) => !isTemporaryActive(session));
  $("insideCount").textContent = inside.length;
  $("temporaryCount").textContent = sessions.length - inside.length;
  $("recordCount").textContent = sessions.length;
  $("tableEmpty").style.display = sessions.length ? "none" : "block";
  $("vehicleTable").innerHTML = sessions.map((session) => {
    const expired = session.temporary_until && !isTemporaryActive(session);
    const status = isTemporaryActive(session) ? "Salida temporal" : expired ? "Permiso vencido" : "En playa";
    return `<tr><td>${escapeHtml(session.plate)}</td><td>${dateTime(session.entry_at)}</td><td><span class="status ${isTemporaryActive(session) || expired ? "temp" : ""}">${status}</span></td><td>${money(RATE * elapsedDays(session.entry_at))}</td></tr>`;
  }).join("");
}

async function loadSessions() {
  const version = ++loadVersion;
  const { data, error } = await supabaseClient
    .from("parking_sessions")
    .select("id,plate,entry_at,temporary_until,final_exit_at")
    .is("final_exit_at", null)
    .order("entry_at", { ascending: false });
  if (error) throw error;
  if (version !== loadVersion) return;
  sessions = data || [];
  render();
  if (currentRole === "admin") await loadAdminSummary();
}

async function hashDni(dni) {
  const bytes = new TextEncoder().encode(`${dni}:cabred-hospital-2026`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function writeAudit(action, details) {
  const { error } = await supabaseClient.from("parking_audit").insert({
    operator_name: currentUser.name,
    action,
    plate: details.plate,
    dni_last4: details.dni ? details.dni.slice(-4) : null,
    minutes: details.minutes || null,
    amount: details.amount || null
  });
  if (error) throw error;
}

async function verifyDni(sessionId, dni) {
  const { data, error } = await supabaseClient.from("parking_sessions").select("driver_dni_hash").eq("id", sessionId).single();
  if (error) throw error;
  if (data.driver_dni_hash !== await hashDni(dni)) throw new Error("El DNI no coincide con el registrado al ingreso.");
}

function setButtonBusy(form, busy) {
  form.querySelectorAll("button").forEach((button) => { button.disabled = busy; });
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = $("loginName").value.trim();
  const role = $("loginRole").value;
  if (!name) { showMessage("loginMessage", "Ingresá el nombre del operador.", true); return; }
  try {
    if (config.url.startsWith("PEGAR") || config.anonKey.startsWith("PEGAR")) throw new Error("Falta configurar la conexión con Supabase.");
    const email = role === "admin" ? config.adminEmail : config.operatorEmail;
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password: $("loginPassword").value });
    if (error) throw error;
    currentUser = { id: data.user.id, name };
    currentRole = role;
    $("loginScreen").style.display = "none";
    $("adminPanel").hidden = role !== "admin";
    document.querySelector(".stats div:nth-child(3)").style.display = role === "admin" ? "block" : "none";
    await loadSessions();
    subscribeToChanges();
    form.reset();
  } catch (error) {
    showMessage("loginMessage", error.message || "No se pudo iniciar sesión.", true);
  }
}

async function handleEntry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const plate = plateOf($("entryPlate").value);
  const dni = dniOf($("entryDni").value);
  if (!plate) { showMessage("entryMessage", "Ingresá una patente.", true); return; }
  if (dni.length < 6) { showMessage("entryMessage", "Ingresá un DNI válido.", true); return; }
  setButtonBusy(form, true);
  try {
    const { error } = await supabaseClient.from("parking_sessions").insert({ plate, driver_dni_hash: await hashDni(dni), entry_at: new Date().toISOString() });
    if (error) throw error;
    await writeAudit("entrada", { plate, dni });
    form.reset();
    showMessage("entryMessage", `Entrada registrada para ${plate}. Tarifa inicial: ${money(RATE)}.`);
    await loadSessions();
  } catch (error) {
    const duplicate = String(error.message || "").includes("one_active_plate") || String(error.message || "").includes("duplicate");
    showMessage("entryMessage", duplicate ? "La patente ya tiene una sesión activa." : error.message, true);
  } finally { setButtonBusy(form, false); }
}

async function handleTemporaryExit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const plate = plateOf($("temporaryPlate").value);
  const dni = dniOf($("temporaryDni").value);
  const session = activeSession(plate);
  if (!session) { showMessage("temporaryMessage", "No hay un vehículo activo con esa patente.", true); return; }
  if (isTemporaryActive(session)) { showMessage("temporaryMessage", "La patente ya tiene un permiso temporal vigente.", true); return; }
  if (dni.length < 6) { showMessage("temporaryMessage", "Ingresá un DNI válido.", true); return; }
  setButtonBusy(form, true);
  try {
    await verifyDni(session.id, dni);
    const until = new Date(Date.now() + Number($("temporaryMinutes").value) * 60000).toISOString();
    const result = await supabaseClient.from("parking_sessions").update({ temporary_until: until }).eq("id", session.id).is("final_exit_at", null).select("id,temporary_until").single();
    if (result.error) throw result.error;
    await writeAudit("salida temporal", { plate, dni, minutes: Number($("temporaryMinutes").value) });
    form.reset();
    showMessage("temporaryMessage", `Salida temporal autorizada hasta ${dateTime(until)}.`);
    await loadSessions();
    showVehicle(plate);
  } catch (error) { showMessage("temporaryMessage", error.message, true); }
  finally { setButtonBusy(form, false); }
}

function showVehicle(rawPlate) {
  const plate = plateOf(rawPlate);
  const session = activeSession(plate);
  const resultBox = $("vehicleResult");
  if (!session) { resultBox.className = "result empty"; resultBox.textContent = "No se encontró un vehículo activo con esa patente."; return; }
  const temporary = isTemporaryActive(session);
  const expired = session.temporary_until && !temporary;
  resultBox.className = "result";
  resultBox.innerHTML = `<strong>${escapeHtml(session.plate)}</strong><p>Entrada: ${dateTime(session.entry_at)} · ${temporary ? `salida temporal hasta ${dateTime(session.temporary_until)}` : expired ? "permiso temporal vencido" : "vehículo dentro de la playa"}</p><p>Importe actual: <strong>${money(RATE * elapsedDays(session.entry_at))}</strong></p><div class="result-actions">${temporary ? '<button class="success" data-action="reentry">Registrar reingreso</button>' : ""}<button class="danger" data-action="final">Dar salida definitiva</button></div>`;
  resultBox.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => handleExit(button, session, plate)));
}

async function handleExit(button, session, plate) {
  const dni = dniOf($("lookupDni").value);
  const resultBox = $("vehicleResult");
  if (dni.length < 6) { resultBox.innerHTML = "<strong>Falta el DNI</strong><p>Ingresá el DNI del chofer para continuar.</p>"; return; }
  button.disabled = true;
  try {
    await verifyDni(session.id, dni);
    if (button.dataset.action === "reentry") {
      const reentry = await supabaseClient.from("parking_sessions").update({ temporary_until: null }).eq("id", session.id).is("final_exit_at", null).select("id").single();
      if (reentry.error) throw reentry.error;
      await writeAudit("reingreso", { plate, dni });
      await loadSessions();
      showVehicle(plate);
      return;
    }
    const amount = RATE * elapsedDays(session.entry_at);
    const now = new Date().toISOString();
    const finalExit = await supabaseClient.from("parking_sessions").update({ final_exit_at: now, amount, temporary_until: null }).eq("id", session.id).is("final_exit_at", null).select("amount,final_exit_at").single();
    if (finalExit.error) throw finalExit.error;
    if (!finalExit.data || Number(finalExit.data.amount) !== amount) throw new Error("La salida no fue confirmada por la base de datos.");
    await writeAudit("salida definitiva", { plate, dni, amount });
    sessions = sessions.filter((row) => row.id !== session.id);
    render();
    await loadSessions();
    resultBox.innerHTML = `<strong>Salida registrada: ${escapeHtml(plate)}</strong><p>Importe cobrado: <strong>${money(amount)}</strong></p>`;
  } catch (error) {
    resultBox.innerHTML = `<strong>Error</strong><p>${escapeHtml(error.message || "No se pudo completar la salida.")}</p>`;
  } finally { button.disabled = false; }
}

function subscribeToChanges() {
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel = supabaseClient.channel("parking-live").on("postgres_changes", { event: "*", schema: "public", table: "parking_sessions" }, () => loadSessions()).subscribe();
}

async function loadAdminSummary() {
  if (currentRole !== "admin") return;
  const { data, error } = await supabaseClient.from("parking_audit").select("amount").eq("action", "salida definitiva");
  if (error) throw error;
  $("revenue").textContent = money((data || []).reduce((total, row) => total + Number(row.amount || 0), 0));
}

$("loginForm").addEventListener("submit", handleLogin);
$("entryForm").addEventListener("submit", handleEntry);
$("temporaryForm").addEventListener("submit", handleTemporaryExit);
$("lookupButton").addEventListener("click", () => showVehicle($("lookupPlate").value));
$("lookupPlate").addEventListener("keydown", (event) => { if (event.key === "Enter") showVehicle(event.target.value); });
$("logoutButton").addEventListener("click", async () => { await supabaseClient.auth.signOut(); window.location.reload(); });
$("auditButton").addEventListener("click", async () => {
  const { data, error } = await supabaseClient.from("parking_audit").select("*").order("happened_at", { ascending: false }).limit(100);
  if (error) { $("auditList").textContent = error.message; return; }
  $("auditList").innerHTML = (data || []).map((row) => `<p><strong>${dateTime(row.happened_at)}</strong> · ${escapeHtml(row.operator_name)} · ${escapeHtml(row.action)} · ${escapeHtml(row.plate)} ${row.amount ? `· ${money(row.amount)}` : ""}</p>`).join("") || "<p>No hay movimientos todavía.</p>";
});
$("exportButton").addEventListener("click", async () => {
  const { data, error } = await supabaseClient.from("parking_audit").select("*").order("happened_at", { ascending: false });
  if (error) { $("auditList").textContent = error.message; return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `respaldo-estacionamiento-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
});
