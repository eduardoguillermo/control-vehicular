/* drive-sync.js — v1.0.0
   Sincroniza el backup de Control Vehicular contra una carpeta visible
   "ControlVehicular" en Drive. Mismo patrón y mismo Client ID de OAuth
   que el resto del ecosistema de PWAs (Mini HA, FinanzasPro, Stock en Casa).
   Un solo archivo: control-vehicular_backup.json (todo el DB).
*/
const DriveSync = (() => {
  const CLIENT_ID = '1049169592532-is5j1j4s1bmgrc9tsq48slrgul8fbj17.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/drive.file';
  const CARPETA = 'ControlVehicular';
  const ARCHIVO_BACKUP = 'control-vehicular_backup.json';

  let tokenClient = null;
  let accessToken = null;
  let folderId = null;
  let backupFileId = null;
  let renewTimer = null;
  let onTokenCallback = null; // se llama cada vez que se consigue un token (init O conectar), no solo la primera vez
  const TOKEN_KEY = 'cveh_drive_token';

  function log(...args) { console.log('[DriveSync]', ...args); }

  function guardarToken(token, expiresInSeg) {
    const vencimiento = Date.now() + (expiresInSeg * 1000) - 60000;
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, vencimiento }));
  }
  function tokenGuardadoValido() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const { token, vencimiento } = JSON.parse(raw);
      if (Date.now() < vencimiento) return token;
      return null;
    } catch (e) { return null; }
  }

  function init(onReady) {
    if (!window.google || !google.accounts) {
      log('Google Identity Services todavía no cargó, reintentando...');
      setTimeout(() => init(onReady), 400);
      return;
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (resp) => {
          if (resp.error) { log('Error de token', resp); return; }
          accessToken = resp.access_token;
          guardarToken(accessToken, resp.expires_in || 3600);
          programarRenovacion();
          if (onReady) onReady();
          if (onTokenCallback) onTokenCallback();
        },
        error_callback: (err) => { log('Intento de token falló (silencioso):', err && err.type); }
      });
    }
    const guardado = tokenGuardadoValido();
    if (guardado) {
      accessToken = guardado;
      programarRenovacion();
      if (onReady) onReady();
    } else if (localStorage.getItem(TOKEN_KEY)) {
      tokenClient.requestAccessToken({ prompt: '' });
    }
  }

  function conectar() {
    if (accessToken) return;
    if (!tokenClient) { log('tokenClient no inicializado todavía'); return; }
    tokenClient.requestAccessToken({ prompt: '' });
  }

  function forzarReconexion() {
    accessToken = null;
    localStorage.removeItem(TOKEN_KEY);
    if (tokenClient) tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  function programarRenovacion() {
    if (renewTimer) clearTimeout(renewTimer);
    let delay = 50 * 60 * 1000;
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (raw) {
        const { vencimiento } = JSON.parse(raw);
        delay = Math.max(vencimiento - Date.now() - 60000, 5000);
      }
    } catch (e) { /* usar delay por defecto */ }
    renewTimer = setTimeout(() => {
      tokenClient.requestAccessToken({ prompt: '' });
    }, delay);
  }

  async function api(url, opts = {}) {
    const resp = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${accessToken}` }
    });
    if (!resp.ok) throw new Error(`Drive API ${resp.status}: ${await resp.text()}`);
    return resp;
  }

  let _folderPromise = null;
  async function ensureFolder() {
    if (folderId) return folderId;
    if (_folderPromise) return _folderPromise;
    _folderPromise = (async () => {
      const q = encodeURIComponent(`name='${CARPETA}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
      const resp = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
      const data = await resp.json();
      if (data.files && data.files.length) { folderId = data.files[0].id; return folderId; }

      const createResp = await api('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: CARPETA, mimeType: 'application/vnd.google-apps.folder' })
      });
      const created = await createResp.json();
      folderId = created.id;
      return folderId;
    })();
    try { return await _folderPromise; } finally { _folderPromise = null; }
  }

  let _backupFilePromise = null;
  async function ensureBackupFile() {
    if (backupFileId) return backupFileId;
    if (_backupFilePromise) return _backupFilePromise;
    _backupFilePromise = (async () => {
      await ensureFolder();
      const q = encodeURIComponent(`name='${ARCHIVO_BACKUP}' and '${folderId}' in parents and trashed=false`);
      const resp = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
      const data = await resp.json();
      if (data.files && data.files.length) { backupFileId = data.files[0].id; return backupFileId; }

      backupFileId = await subirJSON({}, true);
      return backupFileId;
    })();
    try { return await _backupFilePromise; } finally { _backupFilePromise = null; }
  }

  async function subirJSON(obj, creando = false, keepalive = false, nombreArchivo = ARCHIVO_BACKUP, archivoIdDestino = null) {
    await ensureFolder();
    const boundary = 'cveh_boundary';
    const metadata = creando
      ? { name: nombreArchivo, parents: [folderId], mimeType: 'application/json' }
      : { mimeType: 'application/json' };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${boundary}--`;

    const url = creando
      ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
      : `https://www.googleapis.com/upload/drive/v3/files/${archivoIdDestino || backupFileId}?uploadType=multipart`;

    const opts = {
      method: creando ? 'POST' : 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    };
    if (keepalive && body.length < 60000) opts.keepalive = true;

    const resp = await api(url, opts);
    const data = await resp.json();
    return data.id;
  }

  async function subirBackup(datosCompletos, keepalive = false) {
    await ensureBackupFile();
    await subirJSON(datosCompletos, false, keepalive);
  }

  async function bajarBackup() {
    await ensureBackupFile();
    const resp = await api(`https://www.googleapis.com/drive/v3/files/${backupFileId}?alt=media`);
    return resp.json();
  }

  // ── BACKUPS HISTÓRICOS ─────────────────────────────────────────────────
  // Copias fechadas, independientes del archivo "en vivo" (ARCHIVO_BACKUP).
  // Sirven como punto de restauración real cuando el archivo en vivo se
  // corrompe o se le mergea algo indeseado — algo que restaurar que no sea
  // "volver a sincronizar" contra el mismo archivo que puede estar mal.
  const PREFIJO_HIST = 'backup_';
  const MAX_BACKUPS_HIST = 30;

  function _nombreBackupHistorico() {
    const f = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${PREFIJO_HIST}${f.getFullYear()}-${p(f.getMonth()+1)}-${p(f.getDate())}_${p(f.getHours())}${p(f.getMinutes())}.json`;
  }

  async function listarBackupsHistoricos() {
    await ensureFolder();
    const q = encodeURIComponent(`name contains '${PREFIJO_HIST}' and '${folderId}' in parents and trashed=false`);
    const resp = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&orderBy=createdTime desc&pageSize=50`);
    const data = await resp.json();
    return data.files || [];
  }

  async function bajarBackupPorId(fileId) {
    const resp = await api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return resp.json();
  }

  async function _limpiarBackupsViejos() {
    try {
      const files = await listarBackupsHistoricos();
      if (files.length <= MAX_BACKUPS_HIST) return;
      const sobrantes = files.slice(MAX_BACKUPS_HIST);
      for (const f of sobrantes) {
        try { await api(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE' }); } catch (e) {}
      }
    } catch (e) { log('Error limpiando backups viejos', e); }
  }

  async function subirBackupHistorico(datosCompletos) {
    await ensureFolder();
    await subirJSON(datosCompletos, true, false, _nombreBackupHistorico());
    _limpiarBackupsViejos();
  }

  return {
    init, conectar, forzarReconexion,
    subirBackup, bajarBackup,
    subirBackupHistorico, listarBackupsHistoricos, bajarBackupPorId,
    onToken(fn){ onTokenCallback = fn; },
    get conectado() { return !!accessToken; }
  };
})();
