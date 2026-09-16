#!/bin/sh
# Run on B after the app.storyofme.cn A record points to 39.97.226.182.
set -eu
umask 077
domain=app.storyofme.cn
if ! getent ahostsv4 "$domain" | awk '{print $1}' | grep -qx 39.97.226.182; then
  echo "DNS is not ready: app.storyofme.cn must resolve to 39.97.226.182." >&2
  exit 3
fi
sudo -n certbot certonly --non-interactive --agree-tos \
  --register-unsafely-without-email --webroot -w /var/www/bio-v3-acme -d "$domain"
python3 "$(dirname "$0")/render-nginx.py" > /srv/bio-v3/shared/nginx.conf
sudo -n cp /etc/nginx/sites-available/bio-v3 /srv/bio-v3/shared/nginx-before-https.conf
sudo -n install -m 600 /srv/bio-v3/shared/nginx.conf /etc/nginx/sites-available/bio-v3
if ! sudo -n nginx -t; then
  sudo -n cp /srv/bio-v3/shared/nginx-before-https.conf /etc/nginx/sites-available/bio-v3
  exit 1
fi
sudo -n systemctl reload nginx
sudo -n rm -f /etc/nginx/conf.d/bio-v3-preview.conf
sudo -n nginx -t
sudo -n systemctl reload nginx
echo 'HTTPS activated: https://app.storyofme.cn'
