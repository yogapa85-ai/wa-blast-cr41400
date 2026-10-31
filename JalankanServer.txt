@echo off
TITLE Server CR 41400
:: Masuk ke direktori folder project Anda
cd /d C:\BotPython\wa-blast-ascendo

:: Jalankan server Node.js
node server.js

:: Jika jendela terminal ini ditutup (close), script akan berhenti otomatis
pause