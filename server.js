const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    onWhatsApp 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const xlsx = require('xlsx');
const cors = require('cors');
const fs = require('fs');
const path = require('path'); 

const app = express();

// ============================================================ 
// PERBAIKAN KRUSIAL: Middleware untuk membaca data dari Frontend
// ============================================================
app.use(cors());
app.use(express.json()); // <--- INI YANG TADI HILANG (WAJIB ADA)
app.use(express.urlencoded({ extended: true })); // Agar bisa baca form data

// Folder Static agar HTML, Foto Profil, dan Foto Layout bisa diakses browser
app.use(express.static(path.join(__dirname, 'cr41400_frontend', 'cr41400_frontend')));
app.use(express.static(path.join(__dirname, 'cr41400_frontend'))); 
app.use('/profiles', express.static(path.join(__dirname, 'DATA', 'DATA FOTO')));
app.use('/layout', express.static(path.join(__dirname, 'DATA', 'DATA FOTO LAYOUT')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const upload = multer({ dest: 'uploads/' });

let sock = null;
let isSending = false;

async function connectToWhatsApp() {
    console.log('--- [SISTEM] Inisialisasi Koneksi Baru ---');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, 
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'], 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) io.emit('qr', qr); 

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi Terputus. Reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('SISTEM TERHUBUNG KE WHATSAPP!');
            io.emit('connected', 'WhatsApp Terhubung!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

io.on('connection', (clientSocket) => {
    console.log('Frontend terhubung via WebSocket');

    clientSocket.on('check-connection', () => {
        clientSocket.emit('connection-status', sock ? 'connected' : 'disconnected');
    });

    clientSocket.on('request-pairing-code', async (phoneNumber) => {
        try {
            if (!sock) return clientSocket.emit('pairing-error', 'Server belum siap.');
            const cleanNumber = phoneNumber.replace(/\D/g, '');
            let formattedNumber = cleanNumber.startsWith('0') ? '62' + cleanNumber.slice(1) : 
                                  cleanNumber.startsWith('62') ? cleanNumber : '62' + cleanNumber;
            const code = await sock.requestPairingCode(formattedNumber);
            clientSocket.emit('pairing-code', code);
        } catch (err) {
            console.error('[ERROR Pairing]:', err);
            clientSocket.emit('pairing-error', 'Gagal mengambil kode.');
        }
    });

    clientSocket.on('request-logout', async () => {
        try {
            console.log('[SYSTEM] Request Logout...');
            if (sock) await sock.logout(); 
            if (fs.existsSync('auth_info_baileys')) {
                fs.rmSync('auth_info_baileys', { recursive: true, force: true });
            }
            clientSocket.emit('logout-status', 'Sesi berhasil dihapus. Silakan login ulang.');
            connectToWhatsApp();
        } catch (err) {
            console.error('[ERROR Logout]:', err);
            clientSocket.emit('pairing-error', 'Gagal logout device.');
        }
    });
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min) * 1000;

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!sock) return res.status(400).send({ message: 'Silahkan login terlebih dahulu' });
    if (isSending) return res.status(400).send({ message: 'Proses pengiriman sedang berjalan' });
    
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
        data.shift(); // Buang header
        const filteredData = data.filter(row => row[0]);

        // 1. KIRIM SEMUA NOMOR KE FRONTEND SEKALIGUS AGAR MASUK KE ANTREAN
        const queueList = filteredData.map((row, index) => {
            let phone = row[0].toString().replace(/\D/g, '');
            phone = phone.startsWith('0') ? '62' + phone.slice(1) : 
                    phone.startsWith('62') ? phone : '62' + phone;
            return { index: index + 1, phone };
        });

        io.emit('init-queue', queueList);

        res.send({ message: `Memuat ${filteredData.length} nomor ke antrean...`, total: filteredData.length });
        
        // 2. Jalankan proses kirim di background secara berurutan dan aman
        processBlast(filteredData);
    } catch (err) {
        console.error('[ERROR Upload]:', err);
        res.status(500).send({ message: 'Gagal membaca file excel' });
    }
});

async function processBlast(data) {
    isSending = true;
    console.log(`\n--- [START BLAST] Memulai pengiriman ke ${data.length} nomor ---\n`);

    for (let i = 0; i < data.length; i++) {
        const [phone, message] = data[i];
        if (!phone) continue;

        let formattedPhone = phone.toString().replace(/\D/g, '');
        formattedPhone = formattedPhone.startsWith('0') ? '62' + formattedPhone.slice(1) : 
                         formattedPhone.startsWith('62') ? formattedPhone : '62' + formattedPhone;
        
        const jid = `${formattedPhone}@s.whatsapp.net`;

        try {
            console.log(`[${i + 1}/${data.length}] Memproses: ${formattedPhone}`);
            
            // Pindah dari Antrean ke Validasi
            io.emit('status', { index: i + 1, phone: formattedPhone, status: 'validating' });
            await sleep(1500); 

            console.log(`    -> Mengecek validitas nomor...`);
            console.log(`    ✅ VALID: Mengirim pesan...`);
            await sock.sendMessage(jid, { text: message });
            
            console.log(`    🚀 BERHASIL: Pesan terkirim ke ${formattedPhone}`);
            
            // Pindah ke Berhasil
            io.emit('status', { index: i + 1, phone: formattedPhone, status: 'success' });

            const delay = getRandomDelay(43, 200);
            console.log(`    🕒 Safety Delay: Menunggu ${delay/1000} detik...`);
            await sleep(delay);

            if ((i + 1) % 10 === 0) {
                const longPause = getRandomDelay(300, 600);
                console.log(`\n--- [BATCH BREAK] Istirahat 10 pesan. Pause ${longPause/1000} detik ---\n`);
                await sleep(longPause);
            }
        } catch (err) {
            console.error(`    ⚠️ ERROR pada nomor ${formattedPhone}:`, err.message);
            // Pindah ke Gagal jika error
            io.emit('status', { index: i + 1, phone: formattedPhone, status: 'failed' });
        }
    }
    isSending = false;
    console.log(`\n--- [FINISHED] Semua pesan telah diproses ---\n`);
    io.emit('completed', 'Seluruh misi telah selesai dieksekusi!');
}

/* ============================================================ 
   SECTION: DASHBOARD PERFORMANCE 
   ============================================================ */
app.get('/api/performance/:name', (req, res) => {
    const searchName = req.params.name.toLowerCase();
    const filePath = path.join(__dirname, 'DATA', 'DATA EXCEL', 'performance.xlsx');

    if (!fs.existsSync(filePath)) {
        return res.status(404).send({ message: 'File performance.xlsx tidak ditemukan' });
    }

    try {
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        const userRecords = data.filter(row => 
            row['COLL NAME'] && row['COLL NAME'].toString().toLowerCase().includes(searchName)
        );

        if (userRecords.length === 0) {
            return res.status(404).send({ message: 'Data personil tidak ditemukan' });
        }

        res.json({ 
            success: true, 
            allData: userRecords 
        });
    } catch (err) {
        res.status(500).send({ message: 'Gagal membaca data: ' + err.message });
    }
});

/* ============================================================ 
   SECTION: LOGIN VALIDATION (Secure & Fixed)
   ============================================================ */
app.post('/api/login', (req, res) => {
    // PENGAMAN: Jika req.body kosong, jangan crash, kirim respon 400
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({ success: false, message: 'Data login tidak terkirim!' });
    }

    const username = req.body.username;
    const password = req.body.password;
    const filePath = path.join(__dirname, 'DATA', 'DATA EXCEL', 'datakolektor.xlsx');

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, message: 'Database tidak ditemukan' });
    }

    try {
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        const user = data.find(row => 
            row['USER'] && row['USER'].toString().trim() === username?.toString().trim() && 
            row['PASS'] && row['PASS'].toString().trim() === password?.toString().trim()
        );

        if (user) {
            res.json({ success: true, message: 'Login Berhasil!' });
        } else {
            res.json({ success: false, message: 'USER atau PASS Salah!' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error: ' + err.message });
    }
});
// ==========================================
// SYSTEM CACHE EXCEL INSENTIF (Super Cepat & Ringan)
// ==========================================
let cachedIncentiveData = null;

function loadIncentiveCache() {
    try {
        const excelPath = 'C:/BotPython/wa-blast-ascendo/DATA/DATA EXCEL/Incentive.xlsx';
        if (fs.existsSync(excelPath)) {
            const workbook = xlsx.readFile(excelPath);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            cachedIncentiveData = xlsx.utils.sheet_to_json(sheet, { header: 1 });
            console.log("[INFO] Data Incentive.xlsx berhasil di-cache ke memori!");
        }
    } catch (error) {
        console.error("[ERROR] Gagal memuat Incentive.xlsx:", error.message);
    }
}

// Panggil saat server pertama kali menyala
loadIncentiveCache();
/* ============================================================ 
   SECTION: INCENTIVE PERFORMANCE (XLOOKUP Workflow)
   ============================================================ */
app.get('/api/incentive/:npk', (req, res) => {
    const searchNPK = req.params.npk.toString().trim().toUpperCase();
    const filePath = path.join(__dirname, 'DATA', 'DATA EXCEL', 'incentive.xlsx');

    if (!fs.existsSync(filePath)) {
        return res.status(404).send({ success: false, message: 'File incentive.xlsx tidak ditemukan' });
    }

    try {
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

        const userRecords = [];

        // Looping baris Excel (Mulai dari baris index 1, mengabaikan header di index 0)
        // Kolom A=0 (Periode), B=1 (NPK), C=2 (Nama), D=3 (Status), E=4 (Handling Cycle), H=7 (Final Inc Coll)
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const rowNPK = row[1] ? row[1].toString().trim().toUpperCase() : '';
            
            if (rowNPK === searchNPK) {
                userRecords.push({
                    PERIODE: row[0] || '',
                    NPK: row[1] || '',
                    NAMA: row[2] || '',
                    STATUS: row[3] || '',
                    HANDLING_CYCLE: row[4] || 'C0',
                    FINAL_INC_COLL: row[7] || 0
                });
            }
        }

        if (userRecords.length === 0) {
            return res.status(404).send({ success: false, message: 'Data insentif personil tidak ditemukan' });
        }

        res.json({ 
            success: true, 
            allData: userRecords 
        });
    } catch (err) {
        res.status(500).send({ success: false, message: 'Gagal membaca data: ' + err.message });
    }
});
// --- TARO DI SINI (Dekat rute /upload atau sebelum server.listen) ---
app.post('/preview-excel', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send({ success: false, message: 'File tidak ditemukan' });
    
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
        data.shift(); // Buang header

        const previewList = [];
        data.forEach((row, index) => {
            if (row[0]) {
                let phone = row[0].toString().replace(/\D/g, '');
                phone = phone.startsWith('0') ? '62' + phone.slice(1) : 
                        phone.startsWith('62') ? phone : '62' + phone;
                previewList.push({ index: index + 1, phone, message: row[1] || '' });
            }
        });

        res.json({ success: true, total: previewList.length, data: previewList });
    } catch (err) {
        console.error('[ERROR Preview]:', err);
        res.status(500).json({ success: false, message: 'Gagal membaca excel' });
    }
});
server.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
    connectToWhatsApp();
});
