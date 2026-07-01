#!/bin/sh
set -e

# Fill in sensible defaults. Cert paths default to Let's Encrypt locations for
# the configured server name; override via NGINX_SSL_CERTIFICATE and
# NGINX_SSL_CERTIFICATE_KEY if you use custom certs.
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-roguecord.example.com}"
NGINX_SSL_CERTIFICATE="${NGINX_SSL_CERTIFICATE:-/etc/letsencrypt/live/${NGINX_SERVER_NAME}/fullchain.pem}"
NGINX_SSL_CERTIFICATE_KEY="${NGINX_SSL_CERTIFICATE_KEY:-/etc/letsencrypt/live/${NGINX_SERVER_NAME}/privkey.pem}"

export NGINX_SERVER_NAME NGINX_SSL_CERTIFICATE NGINX_SSL_CERTIFICATE_KEY

# Delegate to the official nginx entrypoint, which will run envsubst on
# /etc/nginx/templates/default.conf.template and start nginx.
exec /docker-entrypoint.sh nginx -g 'daemon off;'
