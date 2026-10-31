# BARQ Downloader — Database Backup & Update Recovery Guide
**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Applies to:** v0.1.0 and later  
**Platform:** Windows 10/11 x64  

---

## 1. Automated Pre-Migration Backups

BARQ Downloader incorporates defensive release engineering to guarantee that user download history and custom settings are never lost during an upgrade.

Before executing any database schema migration, the `DatabaseBackupManager` (`src/main/db/backup-manager.js`) executes a WAL-consistent snapshot:

```sql
VACUUM INTO 'path/to/backup.db'
```

This snapshot:
1. Flushes and checkpoints all pending write-ahead log (WAL) transactions into a clean, compacted single-file database.
2. Validates SQLite consistency via `PRAGMA integrity_check`.
3. Emits an immutable metadata record (`.meta.json`) recording the exact timestamp, source schema version, SHA-256 hash, and table counts.
4. Prunes backups beyond the retention limit (default: 5 latest snapshots).

---

## 2. Default Backup Locations

### Development / Source Mode:
`D:\Projects\BARQ_DOWNLOADER\dev-data\backups\`

### Packaged Per-User Installation:
`%LOCALAPPDATA%\BARQ Downloader\backups\`

### Packaged Portable Edition:
`<folder containing executable>\portable-data\backups\`

---

## 3. Step-by-Step Disaster Recovery Procedure

If an interrupted upgrade or system power outage ever prevents BARQ from starting:

### Step 1: Terminate Any Running BARQ Processes
Open PowerShell and verify no orphaned processes remain:
```powershell
Get-Process -Name "BARQ Downloader", electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

### Step 2: Locate the Latest Verified Backup
Inspect the `backups/` directory:
```powershell
Get-ChildItem -Path "$env:LOCALAPPDATA\BARQ Downloader\backups" -Filter "*.meta.json" | Sort-Object LastWriteTime -Descending
```
Select the newest backup with `integrityOk: true`.

### Step 3: Replace the Main Database File
Copy the selected backup `.db` file over the primary `barq.db` file:
```powershell
Copy-Item "$env:LOCALAPPDATA\BARQ Downloader\backups\barq-backup-v5-YYYY-MM-DD.db" "$env:LOCALAPPDATA\BARQ Downloader\barq.db" -Force
# Remove any orphaned WAL sidecar files
Remove-Item "$env:LOCALAPPDATA\BARQ Downloader\barq.db-wal" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\BARQ Downloader\barq.db-shm" -Force -ErrorAction SilentlyContinue
```

### Step 4: Relaunch BARQ Downloader
Launch BARQ Downloader. The application will initialize the verified database snapshot, run integrity checks, and restore normal operation.
