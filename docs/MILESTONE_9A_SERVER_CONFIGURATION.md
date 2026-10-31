# BARQ DOWNLOADER — MILESTONE 9A
## Production Web Server Configuration Templates

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Endpoint Domain:** `updates.barq-downloader.org`  
**Protocol:** HTTPS only (TLS 1.3 / TLS 1.2)  
**Channels:** `beta`, `stable`

---

## 1. Caching & Content-Type Specification

To guarantee both instant update availability for clients and efficient binary caching across global edge CDNs, the server must enforce strict, differentiated HTTP headers based on file type:

| File Pattern | Content-Type | Cache-Control | Purpose |
| :--- | :--- | :--- | :--- |
| `release-manifest.json` | `application/json; charset=utf-8` | `no-cache, no-store, must-revalidate` | Ensure clients always check for newest release metadata without stale local cache. |
| `release-manifest.json.sig`| `application/octet-stream` | `no-cache, no-store, must-revalidate` | Ensure signature always matches latest manifest. |
| `SHA256SUMS.txt` | `text/plain; charset=utf-8` | `no-cache, must-revalidate, max-age=300` | Human and CLI verification checksum list. |
| `*.exe` (Installers & Portable) | `application/vnd.microsoft.portable-executable` (or `application/octet-stream`) | `public, max-age=31536000, immutable` | Version-pinned binaries never change; cache indefinitely. |

---

## 2. Nginx Server Block (`/etc/nginx/sites-available/updates.barq-downloader.org`)

```nginx
# Rate limiting zone: max 10 requests/second per IP with burst of 20
limit_req_zone $binary_remote_addr zone=update_limit:10m rate=10r/s;

# HTTP -> HTTPS Redirection
server {
    listen 80;
    listen [::]:80;
    server_name updates.barq-downloader.org;

    # Explicit permanent redirect to HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS Server Block
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name updates.barq-downloader.org;

    root /var/www/updates.barq-downloader.org;
    index index.html;

    # SSL / TLS 1.3 Hardened Configuration
    ssl_certificate /etc/letsencrypt/live/updates.barq-downloader.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/updates.barq-downloader.org/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/updates.barq-downloader.org/chain.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    ssl_stapling on;
    ssl_stapling_verify on;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'; base-uri 'none';" always;

    # Disallow directory listings
    autoindex off;

    # Enable HTTP Byte Range requests (critical for multi-segment resume)
    max_ranges 16;

    # Apply rate limiting across update endpoints
    limit_req zone=update_limit burst=20 nodelay;

    # Manifests and Digital Signatures (Dynamic / Instant Invalidation)
    location ~* \.json$ {
        default_type application/json;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
    }

    location ~* \.sig$ {
        default_type application/octet-stream;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
    }

    location = /SHA256SUMS.txt {
        default_type text/plain;
        add_header Cache-Control "no-cache, must-revalidate, max-age=300" always;
        add_header Access-Control-Allow-Origin "*" always;
    }

    # Binary Release Artifacts (Immutable / Cached)
    location ~* \.exe$ {
        default_type application/vnd.microsoft.portable-executable;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Accept-Ranges bytes always;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        
        # High-performance static sendfile
        sendfile on;
        tcp_nopush on;
        tcp_nodelay on;
        keepalive_timeout 65;
    }

    # Deny access to hidden files (.git, .env, .DS_Store)
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }
}
```

---

## 3. Apache Configuration (`.htaccess` / VirtualHost)

```apache
<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName updates.barq-downloader.org
    DocumentRoot /var/www/updates.barq-downloader.org

    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/updates.barq-downloader.org/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/updates.barq-downloader.org/privkey.pem
    SSLProtocol -all +TLSv1.2 +TLSv1.3

    # Security Headers
    Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "DENY"

    # CORS Headers for Open Availability
    Header always set Access-Control-Allow-Origin "*"
    Header always set Access-Control-Allow-Methods "GET, HEAD, OPTIONS"

    # Enable Range Requests
    Header always set Accept-Ranges bytes

    # Caching Directives
    <FilesMatch "\.json$">
        ForceType application/json
        Header set Cache-Control "no-cache, no-store, must-revalidate"
        Header set Pragma "no-cache"
    </FilesMatch>

    <FilesMatch "\.sig$">
        ForceType application/octet-stream
        Header set Cache-Control "no-cache, no-store, must-revalidate"
        Header set Pragma "no-cache"
    </FilesMatch>

    <FilesMatch "\.exe$">
        ForceType application/vnd.microsoft.portable-executable
        Header set Cache-Control "public, max-age=31536000, immutable"
    </FilesMatch>

    <FilesMatch "SHA256SUMS\.txt$">
        ForceType text/plain
        Header set Cache-Control "no-cache, max-age=300"
    </FilesMatch>

    Options -Indexes -FollowSymLinks
</VirtualHost>
</IfModule>
```

---

## 4. Cloudflare R2 / AWS S3 Bucket Metadata & Rules

When hosting on object storage backed by a CDN:

### S3 / R2 Bucket CORS Configuration (`cors.json`)
```json
[
  {
    "AllowedHeaders": ["Range", "If-None-Match", "If-Modified-Since"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
    "MaxAgeSeconds": 86400
  }
]
```

### Upload Metadata CLI Commands
```bash
# Upload Manifests (No Cache)
aws s3 cp release-manifest.json s3://barq-updates/beta/release-manifest.json \
  --content-type "application/json" \
  --cache-control "no-cache, no-store, must-revalidate"

aws s3 cp release-manifest.json.sig s3://barq-updates/beta/release-manifest.json.sig \
  --content-type "application/octet-stream" \
  --cache-control "no-cache, no-store, must-revalidate"

# Upload Executables (Immutable Cache)
aws s3 cp BARQ-Downloader-Setup-0.1.0.exe s3://barq-updates/beta/BARQ-Downloader-Setup-0.1.0.exe \
  --content-type "application/vnd.microsoft.portable-executable" \
  --cache-control "public, max-age=31536000, immutable"

aws s3 cp BARQ-Downloader-Portable-0.1.0.exe s3://barq-updates/beta/BARQ-Downloader-Portable-0.1.0.exe \
  --content-type "application/vnd.microsoft.portable-executable" \
  --cache-control "public, max-age=31536000, immutable"
```

---

## 5. Linux Host Directory Permissions & Hardening

On a dedicated origin server, enforce read-only execution permissions to protect release assets:

```bash
# Set ownership to web user (www-data / nginx)
chown -R www-data:www-data /var/www/updates.barq-downloader.org

# Set directory permissions: read + execute (traverse) only
find /var/www/updates.barq-downloader.org -type d -exec chmod 0555 {} +

# Set file permissions: read-only for web user, no write or execute
find /var/www/updates.barq-downloader.org -type f -exec chmod 0444 {} +
```
This guarantees that even if a web application vulnerability exists elsewhere on the server, the update distribution directory remains completely immutable.
